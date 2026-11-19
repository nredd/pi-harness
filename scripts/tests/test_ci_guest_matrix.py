"""Pin the CI matrix and exercise the real plan and coverage reporting steps.

References:
    https://docs.github.com/actions/using-jobs/using-a-matrix-for-your-jobs
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import merge_pr_checks

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
SETUP_CI_TOOLS = "./.github/actions/setup-ci-tools"
# A command that starts a shell line, never one inside a comment or an echoed string.
NPM_INSTALL_COMMAND = re.compile(r"^\s*(?:npm ci|make install-owned)\b", re.MULTILINE)
PLATFORMS = {
    "ubuntu-24.04": ("ubuntu-24.04", "linux", "linux-x64"),
    "macos-14": ("xcode-27", "macos", "darwin-arm64"),
}
STACK_PLATFORMS = PLATFORMS
RUNNER_OS = {"ubuntu-24.04": "Linux", "xcode-27": "macOS", "windows-2025": "Windows"}
PLAN_ONLY = {"Check out the local actions", "Report execution plan"}
REPORT_PLAN = ROOT / ".github/actions/report-plan/action.yml"
PERSONAL_STEPS = {
    "Replay source-selected installer runtime locks without lifecycle scripts",
    "Strict standalone startup with failure-only diagnostics",
    "Standalone D and E (personal)",
}
LOCAL_STEPS = {"Standalone D and E (local)"}
BUILD_AND_NODE = {"Assembled D and E boundaries (explicit stack, no machine config)", "Build standalone"}
# Each `owned (<os>)` check is its own fan-in job over its own shard job (#350).
OWNED_FAN_IN = {"ubuntu-24.04": "owned-ubuntu", "macos-14": "owned-macos"}
OWNED_SHARD_JOBS = {"ubuntu-24.04": "owned-shards-ubuntu", "macos-14": "owned-shards-macos"}


@dataclass(frozen=True)
class Trigger:
    """One workflow trigger and the `classify` outputs it produced.

    Parameters:
        event (str): Triggering event.
        docs_only (str): `classify` output.
        stack_inputs (str): `classify` output.
        title_problem (str): A PR title failure the plan turns into a blocked cell.
        classify_result (str): The `classify` job's result; anything but `success` publishes no plan.
    """

    event: str = "pull_request"
    docs_only: str = "false"
    stack_inputs: str = "true"
    title_problem: str = ""
    classify_result: str = "success"


PULL_REQUEST = Trigger()


def jobs() -> dict[str, Any]:
    """Return parsed CI jobs, retaining GitHub expressions as strings.

    Returns:
        dict[str, Any]: YAML job records.
    """
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]


def expand(name: str, event: str = "pull_request") -> dict[str, dict[str, str]]:
    """Expand the real workflow matrix for an event, keyed by reported check name."""
    if name == "owned":
        return {check: cell for job in OWNED_FAN_IN.values() for check, cell in expand(job, event).items()}
    job = jobs()[name]
    context = {"github.event_name": event}
    if name in OWNED_FAN_IN.values() and not evaluate(job["if"], context):
        return {}
    matrix = job["strategy"]["matrix"]
    if "include" in matrix:
        records = evaluate(matrix["include"], context)
    else:
        systems = matrix["os"]
        records = [
            {"os": system} for system in (evaluate(systems, context) if isinstance(systems, str) else systems)
        ]
    return {
        render(job["name"], {f"matrix.{key}": value for key, value in cell.items()}): cell for cell in records
    }


class Absent(dict[str, Any]):
    """A parsed JSON object where a missing property is an empty object, like GitHub's null."""

    def __missing__(self, key: str) -> Absent:
        """Return an empty object for a missing property.

        Parameters:
            key (str): Missing property.

        Returns:
            Absent: An empty, falsy object.
        """
        return Absent()


def github_format(template: str, *values: Any) -> str:
    """Format like GitHub's `format('{0} {1}', a, b)`.

    Parameters:
        template (str): Template with indexed placeholders.
        *values (Any): Replacement values.

    Returns:
        str: The formatted string.
    """
    return template.format(*values)


def evaluate(expression: str, context: dict[str, str]) -> Any:
    """Evaluate the GitHub expression subset `ci.yml` uses with its real operators.

    Parameters:
        expression (str): `if`, `runs-on` or scalar expression, with or without `${{ }}`.
        context (dict[str, str]): Dotted context values; a missing property is an empty string.

    Returns:
        Any: The expression's value, keeping GitHub's operand-returning `&&` and `||`.
    """
    body = expression.strip().removeprefix("${{").removesuffix("}}")
    body = re.sub(r"!(?!=)", " not ", body)
    body = re.sub(r"(?<!['\w])[a-z]+(?:\.[a-z_]+)+", lambda match: repr(context.get(match[0], "")), body)
    body = re.sub(r"\]\.(\w+)", r"]['\1']", body)  # `fromJSON(...)[key].property`
    functions = {
        "fromJSON": lambda text: json.loads(text, object_hook=Absent),
        "format": github_format,
        "contains": lambda haystack, needle: needle in haystack,
        "cancelled": lambda: context.get("cancelled") == "true",
        "always": lambda: True,
    }
    return eval(body.replace("&&", " and ").replace("||", " or "), {"__builtins__": {}} | functions)


def render(value: str, context: dict[str, str]) -> str:
    """Render a scalar like GitHub: every `${{ }}` expression is replaced by its string value.

    Parameters:
        value (str): Scalar with zero or more expressions.
        context (dict[str, str]): Dotted context values.

    Returns:
        str: The rendered value, with booleans as `true`/`false`.
    """

    def text(match: re.Match[str]) -> str:
        result = evaluate(match[0], context)
        if isinstance(result, Absent):
            return ""
        return str(result).lower() if isinstance(result, bool) else str(result)

    return re.sub(r"\$\{\{.*?\}\}", text, value)


def classify_outputs(trigger: Trigger) -> dict[str, str]:
    """Publish the real `ci_paths` outputs for a trigger and read them back.

    Parameters:
        trigger (Trigger): Event and classification; an empty input flag models a missing output, so
            the plan treats it as true. A `classify_result` other than `success` publishes nothing.

    Returns:
        dict[str, str]: `plan` and the other single-line outputs, as the `classify` job publishes them.
    """
    if trigger.classify_result != "success":
        return {"plan": ""}
    result = ci_paths.ChangeClassification(
        paths=("a.txt",),
        docs_only=trigger.docs_only == "true",
        inputs={
            "stack_inputs": trigger.stack_inputs != "false",
        },
    )
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "classify-output"
        output.write_text("")
        plan = ci_paths.plan_cells(result, trigger.event, trigger.title_problem)
        ci_paths.write_github_output(output, result, plan)
        return dict(
            line.split("=", 1) for line in output.read_text().splitlines() if "=" in line and "<<" not in line
        )


def classify_context(trigger: Trigger) -> dict[str, str]:
    """Return the `needs.classify` context a job would see.

    Parameters:
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        dict[str, str]: Dotted context values.
    """
    outputs = classify_outputs(trigger)
    return {
        "needs.classify.outputs.plan": outputs["plan"],
        "needs.classify.outputs.changed_files": "a.txt",
        "needs.classify.result": trigger.classify_result,
        "github.event_name": trigger.event,
    }


def runner_for(name: str, cell: dict[str, str], trigger: Trigger = PULL_REQUEST) -> str:
    """Return the runner one cell really selects from the plan.

    Parameters:
        name (str): Workflow job name.
        cell (dict[str, str]): Expanded matrix cell.
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        str: Selected runner label.
    """
    context = {f"matrix.{key}": value for key, value in cell.items()}
    job = OWNED_FAN_IN[cell["os"]] if name == "owned" else name
    return render(jobs()[job]["runs-on"], context | classify_context(trigger))


def report_step() -> dict[str, Any]:
    """Return the shared reporter's one real step.

    Returns:
        dict[str, Any]: The composite action's `report` step.
    """
    return yaml.safe_load(REPORT_PLAN.read_text())["runs"]["steps"][0]


def run_plan(
    name: str, check: str, tmp_path: Path, trigger: Trigger = PULL_REQUEST, *, check_status: bool = True
) -> tuple[dict[str, str], str, str]:
    """Execute a cell's real `plan` step, the shared composite's script, over the real plan.

    Parameters:
        name (str): Workflow job name.
        check (str): Required check name selecting the cell.
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.
        check_status (bool): Whether a failing step raises; a blocked cell fails on purpose.

    Returns:
        tuple[dict[str, str], str, str]: Step outputs, output text and the step summary.
    """
    cell = expand(name, trigger.event)[check]
    job = OWNED_FAN_IN[cell["os"]] if name == "owned" else name
    job_step = next(step for step in jobs()[job]["steps"] if step.get("id") == "plan")
    assert job_step["uses"] == "./.github/actions/report-plan"
    values = {f"matrix.{key}": value for key, value in cell.items()} | classify_context(trigger)
    inputs = {f"inputs.{key}": render(value, values) for key, value in job_step["with"].items()}
    step = report_step()
    env = {key: render(value, inputs) for key, value in step["env"].items()}
    script = tmp_path / "plan.sh"
    script.write_text(step["run"])
    output = tmp_path / "output"
    summary = tmp_path / "summary"
    output.write_text("")
    summary.write_text("")
    result = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ | env | {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)},
        capture_output=True,
        text=True,
        check=check_status,
    )
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return outputs, result.stdout + result.stderr, summary.read_text()


def executed_steps(name: str, check: str, tmp_path: Path, trigger: Trigger = PULL_REQUEST) -> set[str]:
    """Walk a cell's steps with their real `if` conditions, assuming each step succeeds.

    Parameters:
        name (str): Workflow job name.
        check (str): Required check name selecting the cell.
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        set[str]: Display names of steps that execute.
    """
    cell = expand(name, trigger.event)[check]
    outputs, _, _ = run_plan(name, check, tmp_path, trigger)
    context = {f"matrix.{key}": value for key, value in cell.items()}
    context |= {f"steps.plan.outputs.{key}": value for key, value in outputs.items()}
    context |= {
        "github.event_name": trigger.event,
        "runner.os": RUNNER_OS[runner_for(name, cell, trigger)],
    }
    job = OWNED_FAN_IN[cell["os"]] if name == "owned" else name
    return walk_steps(jobs()[job]["steps"], context)


def walk_steps(steps: list[dict[str, Any]], context: dict[str, Any]) -> set[str]:
    """Return the steps whose real `if` holds, assuming each executed step succeeds.

    Parameters:
        steps (list[dict[str, Any]]): A job's steps.
        context (dict[str, Any]): Dotted context values.

    Returns:
        set[str]: Display names (or `uses`) of the executed steps.
    """
    context = dict(context)
    executed: set[str] = set()
    for step in steps:
        if "if" in step and not evaluate(step["if"], context):
            continue
        executed.add(step.get("name") or step["uses"])
        if "id" in step:
            context[f"steps.{step['id']}.outcome"] = "success"
    return executed


def shard_entries(os_name: str, trigger: Trigger = PULL_REQUEST) -> list[dict[str, str]]:
    """Return the matrix entries a cell's shard job really runs: none when its `if` is false.

    Parameters:
        os_name (str): Matrix `os` of the `owned` cell.
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        list[dict[str, str]]: The evaluated `strategy.matrix.include`, from the real plan.
    """
    job = jobs()[OWNED_SHARD_JOBS[os_name]]
    context = classify_context(trigger)
    # No status function in the `if`, so GitHub's implicit `success()` needs a successful `classify`.
    if trigger.classify_result != "success" or not evaluate(job["if"], context):
        return []
    return evaluate(job["strategy"]["matrix"]["include"], context)


def shard_runner(os_name: str, entry: dict[str, str]) -> str:
    """Return the runner one shard job selects.

    Parameters:
        os_name (str): Matrix `os` of the `owned` cell.
        entry (dict[str, str]): Shard matrix entry.

    Returns:
        str: Runner label.
    """
    context = {f"matrix.{key}": value for key, value in entry.items()}
    return render(jobs()[OWNED_SHARD_JOBS[os_name]]["runs-on"], context)


def shard_steps(os_name: str, entry: dict[str, str], trigger: Trigger = PULL_REQUEST) -> set[str]:
    """Walk one shard's steps with their real `if` conditions.

    Parameters:
        os_name (str): Matrix `os` of the `owned` cell.
        entry (dict[str, str]): Shard matrix entry.
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        set[str]: Display names of the steps the shard executes.
    """
    context = {f"matrix.{key}": value for key, value in entry.items()} | {
        "github.event_name": trigger.event,
        "runner.os": RUNNER_OS[shard_runner(os_name, entry)],
    }
    return walk_steps(jobs()[OWNED_SHARD_JOBS[os_name]]["steps"], context)


def shard_gates(steps: set[str]) -> set[str]:
    """Return the Make targets of the executed `Owned gate <target>` steps.

    Parameters:
        steps (set[str]): Executed step names.

    Returns:
        set[str]: Gate names.
    """
    return {
        step.removeprefix("Owned gate ").split(" ")[0] for step in steps if step.startswith("Owned gate ")
    }


@pytest.mark.parametrize("name", ["owned", "contracts", "stack"])
def test_every_required_check_name_keeps_reporting(name: str) -> None:
    """Keep each ruleset context in the matrix, including the cells that only report.

    Parameters:
        name (str): Ordinary CI gate job.
    """
    expected = {check for check in merge_pr_checks.EXPECTED_MATRIX if check.startswith(name)}
    assert set(expand(name)) == expected


@pytest.mark.parametrize("name", ["owned", "contracts"])
@pytest.mark.parametrize("os_name", ["ubuntu-24.04", "macos-14"])
def test_native_cells_use_their_runner(tmp_path: Path, name: str, os_name: str) -> None:
    """Run native evidence on the planned runner.

    Parameters:
        tmp_path (Path): Disposable output directory.
        name (str): Ordinary CI gate job.
        os_name (str): Native matrix cell.
    """
    check = f"{name} ({os_name})"
    trigger = Trigger(event="push" if os_name == "macos-14" else "pull_request")
    if name == "owned":
        entries = shard_entries(os_name, trigger)
        assert entries
        assert {shard_runner(os_name, entry) for entry in entries} == {PLATFORMS[os_name][0]}
    else:
        assert runner_for(name, expand(name, trigger.event)[check], trigger) == PLATFORMS[os_name][0]
    outputs, stdout, _ = run_plan(name, check, tmp_path, trigger)
    assert outputs["run"] == "true"
    assert "NOT RUN" not in stdout


@pytest.mark.parametrize("check", ["stack (ubuntu-24.04, personal)", "stack (ubuntu-24.04, local)"])
def test_docs_only_bypass_still_covers_running_stack_cells(tmp_path: Path, check: str) -> None:
    """Keep the existing docs-only bypass on the cells that do run.

    Parameters:
        tmp_path (Path): Disposable output directory.
        check (str): Running stack cell.
    """
    trigger = Trigger(docs_only="true", stack_inputs="false")
    outputs, stdout, _ = run_plan("stack", check, tmp_path, trigger)
    assert outputs["run"] == "false"
    assert f"::notice title={check} NOT RUN::{ci_paths.NOT_RUN['docs_only']}" in stdout
    assert executed_steps("stack", check, tmp_path, trigger) == PLAN_ONLY


def test_personal_cell_keeps_setup_but_skips_personal_work_without_stack_inputs(tmp_path: Path) -> None:
    """Gate the personal steps, never the whole cell, on a PR with no stack inputs.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    check = "stack (ubuntu-24.04, personal)"
    trigger = Trigger(stack_inputs="false")
    outputs, stdout, summary = run_plan("stack", check, tmp_path, trigger)
    assert (outputs["run"], outputs["scenarios"]) == ("true", "false")
    assert f"::notice title={check} scenarios NOT RUN::" in stdout
    assert "NOT RUN" in summary
    steps = executed_steps("stack", check, tmp_path, trigger)
    assert "Fetch exact Gitlinked core release, formula-equivalent install" in steps
    assert not steps & (PERSONAL_STEPS | LOCAL_STEPS)
    assert "Assembled D and E boundaries (explicit stack, no machine config)" not in steps
    assert "Build standalone" not in steps


@pytest.mark.parametrize("event", ["pull_request", "push"])
def test_personal_cell_runs_only_personal_steps_when_it_runs(tmp_path: Path, event: str) -> None:
    """Run all personal work with stack inputs, and on every `main` push regardless.

    Parameters:
        tmp_path (Path): Disposable output directory.
        event (str): Triggering event.
    """
    trigger = Trigger(event=event, stack_inputs="false" if event == "push" else "true")
    steps = executed_steps("stack", "stack (ubuntu-24.04, personal)", tmp_path, trigger)
    assert steps >= PERSONAL_STEPS | BUILD_AND_NODE
    assert not steps & LOCAL_STEPS


@pytest.mark.parametrize("os_name", ["ubuntu-24.04", "macos-14"])
@pytest.mark.parametrize("stack_inputs", ["true", "false"])
def test_local_cells_own_standalone_local(tmp_path: Path, os_name: str, stack_inputs: str) -> None:
    """Keep standalone macOS evidence in `local`, whatever `stack_inputs` says.

    Parameters:
        tmp_path (Path): Disposable output directory.
        os_name (str): Running local cell.
        stack_inputs (str): `classify` output; `packages/` feeds `local` regardless.
    """
    check = f"stack ({os_name}, local)"
    event = "push" if os_name == "macos-14" else "pull_request"
    steps = executed_steps("stack", check, tmp_path, Trigger(event=event, stack_inputs=stack_inputs))
    assert steps >= LOCAL_STEPS | BUILD_AND_NODE
    assert not steps & PERSONAL_STEPS


def test_macos_jobs_expand_only_outside_pull_requests() -> None:
    """No macOS placeholder is materialized in a pull request matrix."""
    for name in ("owned", "contracts", "stack"):
        assert all(cell["os"] == "ubuntu-24.04" for cell in expand(name).values())
        assert any(cell["os"] == "macos-14" for cell in expand(name, "push").values())
    assert not shard_entries("macos-14", PULL_REQUEST)
    assert shard_entries("macos-14", Trigger(event="push"))


def test_other_pool_routed_macos_jobs_skip_prs() -> None:
    """Keep optional pool work off PRs without skipping the Windows helper or Linux smoke."""
    workflows = ROOT / ".github/workflows"
    helper = yaml.safe_load((workflows / "native-helper.yml").read_text())["jobs"]
    smoke = yaml.safe_load((workflows / "runner-smoke.yml").read_text())["jobs"]
    pr_guard = "github.event_name != 'pull_request'"
    assert helper["route"]["if"] == "${{ " + pr_guard + " && !vars.PI_POOLS_DISABLED }}"
    assert helper["build"]["if"] == "${{ !cancelled() && " + pr_guard + " }}"
    assert "if" not in helper["windows-helper"]
    assert set(smoke) == {"pi-macos", "pi-linux"}
    report = next(step for step in jobs()["classify"]["steps"] if step.get("name") == "Report classification")
    assert 'if [ "$GITHUB_EVENT_NAME" = pull_request ]; then' in report["run"]
    assert "macOS PR skip:" in report["run"]


def test_standalone_uploads_cannot_collide_between_stack_cells() -> None:
    """Both Ubuntu cells now build, so the artifact name must include the stack."""
    steps = jobs()["stack"]["steps"]
    upload = next(step for step in steps if step.get("with", {}).get("name", "").startswith("standalone-${{"))
    running = list(expand("stack", "push").values())
    names = {
        upload["with"]["name"]
        .replace("${{ matrix.platform }}", cell["platform"])
        .replace("${{ matrix.stack }}", cell["stack"])
        for cell in running
    }
    assert len(names) == len(running) == 3


def test_pull_requests_cancel_and_main_runs_complete() -> None:
    """Supersede stale PR heads only."""
    workflow = yaml.safe_load(WORKFLOW.read_text())
    expression = workflow["concurrency"]["cancel-in-progress"]
    assert evaluate(expression, {"github.event_name": "pull_request"}) is True
    assert evaluate(expression, {"github.event_name": "push"}) is False


def test_main_pushes_never_share_a_concurrency_group() -> None:
    """Keep a queued `main` run: GitHub drops older pending runs in the same group."""
    group = yaml.safe_load(WORKFLOW.read_text())["concurrency"]["group"]
    inner = group.removeprefix("ci-${{ ").removesuffix(" }}")
    assert (
        evaluate(
            inner,
            {"github.event_name": "pull_request", "github.ref": "refs/pull/1/merge", "github.sha": "abc"},
        )
        == "refs/pull/1/merge"
    )
    assert (
        evaluate(inner, {"github.event_name": "push", "github.ref": "refs/heads/main", "github.sha": "abc"})
        == "abc"
    )


def test_dispatched_core_gates_never_cancel_each_other() -> None:
    """Keep each frozen candidate's `release-core`, a reusable call that inherits CI's context."""
    concurrency = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())["concurrency"]

    def outcome(event: str, ref: str, sha: str) -> tuple[str, Any]:
        """Return the group and cancellation one caller context selects.

        Parameters:
            event (str): Caller's triggering event.
            ref (str): Caller's ref.
            sha (str): Caller's commit.

        Returns:
            tuple[str, Any]: Rendered group and `cancel-in-progress` value.
        """
        context = {"github.workflow": "CI", "github.event_name": event, "github.ref": ref, "github.sha": sha}
        cancel = concurrency["cancel-in-progress"]
        return render(concurrency["group"], context), cancel if isinstance(cancel, bool) else evaluate(
            cancel, context
        )

    first = outcome("workflow_dispatch", "refs/heads/main", "a" * 40)
    second = outcome("workflow_dispatch", "refs/heads/main", "b" * 40)
    frozen = outcome("workflow_dispatch", f"refs/heads/release-verification/{'c' * 40}", "c" * 40)
    assert len({first[0], second[0], frozen[0]}) == 3
    assert first[1] is second[1] is frozen[1] is False
    pr = outcome("pull_request", "refs/pull/1/merge", "d" * 40)
    assert pr == (outcome("pull_request", "refs/pull/1/merge", "e" * 40)[0], True)


def test_forks_callee_contract() -> None:
    """Pin the input-free `workflow_call` that `ci.yml` `release-core` relies on."""
    forks = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    assert forks[True]["workflow_call"] is None
    assert forks["permissions"] == {"contents": "read"}
    assert set(forks["jobs"]) == {"core"}
    assert forks["jobs"]["core"]["name"] == "core (forks/pi)"


def test_classify_base_and_head_follow_the_trigger() -> None:
    """Diff a PR against its base, a push against `before`, and a dispatch against itself."""
    step = next(step for step in jobs()["classify"]["steps"] if step.get("id") == "classify")
    pr = {
        "github.event.pull_request.base.sha": "base",
        "github.event.pull_request.head.sha": "head",
        "github.sha": "merge",
    }
    push = {"github.event.before": "before", "github.sha": "after"}
    dispatch = {"github.sha": "frozen"}
    assert [evaluate(step["env"]["BASE"], context) for context in (pr, push, dispatch)] == [
        "base",
        "before",
        "frozen",
    ]
    assert [evaluate(step["env"]["HEAD"], context) for context in (pr, push, dispatch)] == [
        "head",
        "after",
        "frozen",
    ]


@pytest.mark.parametrize(
    ("ref", "commit", "admitted"),
    [
        ("refs/heads/main", "tip", True),
        ("refs/heads/release-verification/{sha}", "old", True),
        ("refs/heads/release-verification/{other}", "old", False),
        ("refs/heads/feature", "tip", False),
        ("refs/heads/main", "side", False),
        ("refs/heads/release-verification/{sha}", "side", False),
    ],
)
def test_dispatch_classifies_only_frozen_main_candidates(
    tmp_path: Path, ref: str, commit: str, admitted: bool
) -> None:
    """Run the real dispatch guard: exact ref, `origin/main` ancestry, then every full-lane flag.

    Parameters:
        tmp_path (Path): Disposable repository and output file.
        ref (str): Dispatched ref template.
        commit (str): Which fixture commit the dispatch froze.
        admitted (bool): Whether the guard must admit the dispatch.
    """
    git = shutil.which("git")
    assert git
    repo = tmp_path / "repo"
    repo.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")} | {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_AUTHOR_NAME": "Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }

    def command(*args: str) -> str:
        """Run fixture Git with isolated configuration.

        Parameters:
            args (str): Literal Git arguments.

        Returns:
            str: Stripped stdout.
        """
        return subprocess.check_output([git, *args], cwd=repo, env=env, text=True).strip()

    (repo / "scripts").mkdir()
    shutil.copy(ROOT / "scripts/ci_paths.py", repo / "scripts/ci_paths.py")
    shutil.copy(ROOT / "scripts/runner_pools.py", repo / "scripts/runner_pools.py")
    # The plan splits `owned` by the checkout's npm workspaces.
    shutil.copy(ROOT / "package.json", repo / "package.json")
    for workspace in ci_paths.npm_workspaces(ROOT):
        (repo / workspace).mkdir(parents=True)
        shutil.copy(ROOT / workspace / "package.json", repo / workspace / "package.json")
    command("init", "--quiet", "--template=", "-b", "main")
    commits = {}
    for name in ("old", "tip"):
        command("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", name)
        commits[name] = command("rev-parse", "HEAD")
    command("update-ref", "refs/remotes/origin/main", commits["tip"])
    command("checkout", "--quiet", "-b", "side", commits["old"])
    command("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "side")
    commits["side"] = command("rev-parse", "HEAD")
    sha = commits[commit]
    step = next(step for step in jobs()["classify"]["steps"] if step.get("id") == "classify")
    script = tmp_path / "classify.sh"
    script.write_text(step["run"])
    output = tmp_path / "output"
    output.touch()
    result = subprocess.run(
        ["/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
        cwd=repo,
        env=env
        | {
            "EVENT": "workflow_dispatch",
            "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
            "GITHUB_REF": ref.format(sha=sha, other="0" * 40),
            "GITHUB_SHA": sha,
            "GITHUB_OUTPUT": str(output),
            "BASE": sha,
            "HEAD": sha,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    if admitted:
        assert result.returncode == 0, result.stderr
        lines = output.read_text().splitlines()
        for flag in ("docs_only=false", "stack_inputs=true"):
            assert flag in lines
        assert "Full frozen release candidate" in lines
        plan = json.loads(next(line for line in lines if line.startswith("plan="))[5:])
        # No diff to read: every required name runs for real, nothing is a bypass.
        assert set(plan) == {
            check for name in ("owned", "contracts", "stack") for check in expand(name, "push")
        }
        skipped = {name for name, cell in plan.items() if not cell["run"]}
        assert not skipped
    else:
        assert result.returncode != 0
        assert output.read_text() == ""
        if not ref.startswith("refs/heads/main") and "{sha}" not in ref:
            assert "requires main or an exact frozen candidate ref" in result.stderr


def test_bench_notice_moved_into_classify_summary(tmp_path: Path) -> None:
    """Run the real classify report and keep the NOT RUN disclosure without a job.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    assert "bench" not in jobs()
    step = next(step for step in jobs()["classify"]["steps"] if step.get("name") == "Report classification")
    script = tmp_path / "report.sh"
    script.write_text(step["run"])
    summary = tmp_path / "summary"
    result = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ
        | {
            "DOCS_ONLY": "false",
            "WSL_INPUTS": "true",
            "STACK_INPUTS": "false",
            "CHANGED_FILES": "a.txt",
            "GITHUB_STEP_SUMMARY": str(summary),
        },
        capture_output=True,
        text=True,
        check=True,
    )
    assert "::notice title=bench not run::" in result.stdout
    assert "stack-inputs=false" in result.stdout
    assert "### bench: NOT RUN" in summary.read_text()
    assert "This is not a pass." in summary.read_text()


def test_every_planned_gate_has_a_step_that_survives_other_gate_failures() -> None:
    """Give each gate the plan can list its own step, so one red gate never hides another's evidence."""
    planned = {gate for gates in ci_paths.OWNED_GATES.values() for gate in gates}
    steps = {
        step["name"].removeprefix("Owned gate ").split(" ")[0]: step
        for step in jobs()["owned-shards-ubuntu"]["steps"]
        if step.get("name", "").startswith("Owned gate ")
    }
    assert set(steps) == planned
    for gate in planned:
        condition = steps[gate]["if"]
        assert steps[gate]["run"].split(" ")[:2] == ["make", gate]
        assert "!cancelled()" in condition
        assert "steps.install.outcome == 'success'" in condition
        assert f"contains(matrix.gates, '{gate}')" in condition
    # `check-ts` runs exactly the shard's workspaces, rendered into the command.
    assert steps["check-ts"]["run"] == 'make check-ts WORKSPACES="${{ matrix.workspaces }}"'


def test_no_step_names_a_shard() -> None:
    """Keep the shard list in `ci_paths.OWNED_SHARDS`: no step reads a shard's name."""
    for job in OWNED_SHARD_JOBS.values():
        for step in jobs()[job]["steps"]:
            assert "matrix.shard" not in step.get("if", "")
            assert "matrix.shard" not in step.get("run", "")


@pytest.mark.parametrize(
    ("os_name", "gates"),
    [
        ("ubuntu-24.04", {"check-ts", "check-scripts", "check-integration"}),
        ("macos-14", {"check-ts", "check-scripts", "check-integration"}),
    ],
)
def test_owned_shards_run_exactly_the_gates_the_plan_lists(os_name: str, gates: set[str]) -> None:
    """Walk real step conditions over the real plan: each shard runs its own gates, the cell runs them all.

    Parameters:
        os_name (str): Running owned cell.
        gates (set[str]): Gate steps the cell's shards must execute between them.
    """
    entries = shard_entries(os_name, Trigger(event="push"))
    executed = {
        entry["shard"]: shard_gates(shard_steps(os_name, entry, Trigger(event="push"))) for entry in entries
    }
    for entry in entries:
        assert executed[entry["shard"]] == set(entry["gates"].split())
    assert set().union(*executed.values()) == gates


def test_partition_preserves_native_budget_and_both_full_coverage_runs() -> None:
    """Keep native shard deadlines, worker limits and both full coverage invocations intact."""
    for job in OWNED_SHARD_JOBS.values():
        assert jobs()[job]["timeout-minutes"] == 30
    makefile = (ROOT / "Makefile").read_text()
    assert "pytest $(3) -n 2 --dist loadfile" in makefile
    assert "$(call PY_GATE,release,,-c pyproject.toml ../tests/integration/tests,pi_release)" in makefile
    assert "$(call PY_GATE,tests/integration,,tests,harness)" in makefile
    integration = makefile.split("check-integration:  ##", 1)[1].split("\ncheck-probes:", 1)[0]
    assert "$(MAKE) check-probes" in integration
    assert "$(MAKE) check-providers" in integration


def test_only_the_computer_use_shards_add_the_arm64_target() -> None:
    """Install the aarch64 target where computer-use's Linux checks run, nowhere else."""
    for os_name in OWNED_SHARD_JOBS:
        for entry in shard_entries(os_name, Trigger(event="push")):
            steps = shard_steps(os_name, entry, Trigger(event="push"))
            expected = os_name != "macos-14" and "packages/computer-use" in entry["workspaces"].split()
            assert ("Add the aarch64 Linux compile target" in steps) is expected, entry["shard"]


def test_blocked_plan_fails_every_cell_before_any_work(tmp_path: Path) -> None:
    """Fail each required name, with the title message, when the squash subject is too long.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    trigger = Trigger(title_problem="Shorten the PR title to at most 65 characters.")
    assert not any(shard_entries(os_name, trigger) for os_name in OWNED_SHARD_JOBS)
    for name in ("owned", "contracts", "stack"):
        for check in expand(name):
            work = tmp_path / check.replace(" ", "_").replace("(", "").replace(")", "").replace(",", "")
            work.mkdir()
            with pytest.raises(subprocess.CalledProcessError) as failed:
                run_plan(name, check, work, trigger)
            assert f"::error title={check} blocked::Shorten the PR title" in failed.value.stdout


@pytest.mark.parametrize("result", ["failure", "skipped", "cancelled"])
def test_a_failed_classify_fails_all_four_required_checks_instead_of_skipping_them(
    tmp_path: Path, result: str
) -> None:
    """A skipped job satisfies a required check, so no `classify` outcome may skip a cell.

    Parameters:
        tmp_path (Path): Disposable output directory.
        result (str): The `classify` job's result.
    """
    trigger = Trigger(classify_result=result)
    names: set[str] = set()
    # No shard job starts, so the fan-ins report the failure on their own.
    assert not any(shard_entries(os_name, trigger) for os_name in OWNED_SHARD_JOBS)
    for name in ("owned", "contracts", "stack"):
        for check, cell in expand(name, trigger.event).items():
            job = jobs()[OWNED_FAN_IN[cell["os"]] if name == "owned" else name]
            # The job still starts: its `if` holds when `needs.classify` did not succeed.
            context = {"needs.classify.result": result}
            assert evaluate(job["if"], context) is True
            # ... but a cancelled run still stops, so the `if` is not a constant.
            assert evaluate(job["if"], context | {"cancelled": "true"}) is False
            names.add(check)
            assert runner_for(name, cell, trigger) == "ubuntu-24.04"  # No macOS or Windows slot is spent.
            work = tmp_path / f"{len(names)}"
            work.mkdir()
            with pytest.raises(subprocess.CalledProcessError) as failed:
                run_plan(name, check, work, trigger)
            assert (
                f"::error title={check} has no plan::classify finished with '{result}'" in failed.value.stdout
            )
    assert names == merge_pr_checks.EXPECTED_MATRIX


def test_a_cell_missing_from_a_successful_plan_fails_instead_of_passing_vacuously(tmp_path: Path) -> None:
    """Never treat an absent decision as a skip, which would report a green name with no evidence.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    step = report_step()
    script = tmp_path / "plan.sh"
    script.write_text(step["run"])
    env = os.environ | {
        "CELL": "owned (macos-14)",
        "CLASSIFY_RESULT": "success",
        "GITHUB_OUTPUT": str(tmp_path / "out"),
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
    }
    result = subprocess.run(
        ["/bin/bash", "-e", str(script)], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "::error title=owned (macos-14) has no plan::" in result.stdout


@pytest.mark.parametrize(
    "trigger",
    [
        Trigger(),
        Trigger(docs_only="true", stack_inputs="false"),
        Trigger(stack_inputs="false"),
        Trigger(event="push"),
        Trigger(event="push", docs_only="true"),
        Trigger(title_problem="too long"),
    ],
)
def test_a_cell_holds_a_native_slot_only_when_the_plan_runs_it(trigger: Trigger) -> None:
    """Take the macOS or Windows runner for a cell that does real work, and Ubuntu for every other one.

    Parameters:
        trigger (Trigger): Event and `classify` outputs.
    """
    published = json.loads(classify_outputs(trigger)["plan"])
    for name in ("contracts", "stack"):
        for check, cell in expand(name, trigger.event).items():
            expected = PLATFORMS[cell["os"]][0] if published[check]["run"] else "ubuntu-24.04"
            assert runner_for(name, cell, trigger) == expected, check
    # An owned cell's work runs on its shards; the fan-in itself only reads artifacts, on Ubuntu.
    for check, cell in expand("owned", trigger.event).items():
        assert runner_for("owned", cell, trigger) == "ubuntu-24.04"
        entries = shard_entries(cell["os"], trigger)
        assert bool(entries) is published[check]["run"], check
        runner = ci_paths.RUNNERS[cell["os"]][0]
        assert {shard_runner(cell["os"], entry) for entry in entries} <= {runner}


def test_every_job_reports_through_the_one_shared_action() -> None:
    """Keep the reporter in one composite action; the jobs differ only in the cell they name."""
    cfg = jobs()
    plans = {
        name: next(step for step in cfg[name]["steps"] if step.get("id") == "plan")
        for name in (*OWNED_FAN_IN.values(), "contracts", "stack")
    }
    assert {step["uses"] for step in plans.values()} == {"./.github/actions/report-plan"}
    for job in OWNED_FAN_IN.values():
        assert plans[job]["with"]["cell"] == "${{ format('owned ({0})', matrix.os) }}"
    action = yaml.safe_load(REPORT_PLAN.read_text())
    assert action["runs"]["using"] == "composite"
    assert action["runs"]["steps"][0]["shell"] == "bash -e {0}"
    for key in ("DOCS_ONLY", "STACK_INPUTS", "matrix."):
        assert key not in REPORT_PLAN.read_text()
    # The local action needs a checkout first; the sparse one precedes the plan, the full one follows it.
    for name, plan in plans.items():
        steps = cfg[name]["steps"]
        sparse = next(step for step in steps if step.get("name") == "Check out the local actions")
        assert steps.index(sparse) < steps.index(plan)
        assert sparse["with"]["sparse-checkout"] == ".github/actions"


def test_classify_step_threads_the_pr_title_into_the_plan(tmp_path: Path) -> None:
    """Run the real `classify` step over this repository's last commit with a too-long title.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    step = next(step for step in jobs()["classify"]["steps"] if step.get("id") == "classify")
    script = tmp_path / "classify.sh"
    script.write_text(step["run"])
    output = tmp_path / "output"
    output.write_text("")
    env = os.environ | {
        "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
        "BASE": "HEAD~1",
        "HEAD": "HEAD",
        "EVENT": "pull_request",
        "PR_TITLE": "A" * 70,
        "PR_NUMBER": "305",
        "GITHUB_OUTPUT": str(output),
    }
    subprocess.run(["/bin/bash", "-e", str(script)], cwd=ROOT, env=env, check=True, capture_output=True)
    plan = json.loads(next(line for line in output.read_text().splitlines() if line.startswith("plan="))[5:])
    assert set(plan) == merge_pr_checks.EXPECTED_MATRIX
    assert all(cell["blocked"] for cell in plan.values())
    assert plan["owned (ubuntu-24.04)"]["reason"].startswith("The squash subject")


@pytest.mark.parametrize("os_name", sorted(OWNED_FAN_IN))
def test_python_signals_skip_exactly_the_hosts_without_a_pytest_gate(os_name: str) -> None:
    """Scope each Python LCOV signal to the cells that run its producer, and no others.

    Parameters:
        os_name (str): Matrix `os` of the cell whose fan-in accounts for it.
    """
    # `ci_paths` owns each owned cell's gates and guest; the fan-in reads the guest from the shards' plan.
    accounting = fan_in_step("Coverage accounting (existing reports, including test failures)")
    context = {
        "matrix.os": os_name,
        "needs.classify.outputs.plan": classify_outputs(Trigger(event="push"))["plan"],
    }
    guest = ci_paths.RUNNERS[os_name][1]
    assert render(accounting["env"]["COVERAGE_HOST"], context) == guest
    assert 'COVERAGE_HOST="$COVERAGE_HOST"' in accounting["run"]
    policy = json.loads((ROOT / "coverage/policy.json").read_text())
    for name, gate in (
        ("python-scripts", "check-scripts"),
        ("python-harness", "check-integration"),
    ):
        skipped = set(policy["packages"][name]["signals"]["primary"].get("skip_hosts", []))
        assert (guest in skipped) == (gate not in ci_paths.OWNED_GATES[os_name])


@pytest.mark.parametrize("name", ["contracts", "stack"])
def test_shared_guest_matrix(name: str) -> None:
    """Only the native platforms expand outside PRs; the shell stays Bash."""
    assert {cell["os"] for cell in expand(name, "push").values()} == set(PLATFORMS)
    assert jobs()[name]["defaults"]["run"]["shell"] == "bash -e {0}"


def test_owned_fan_ins_share_one_definition_and_wait_only_for_their_own_shards() -> None:
    """Keep the required Ubuntu result and its scheduling independent of macOS."""
    cfg = jobs()
    assert cfg["owned-ubuntu"]["steps"] == cfg["owned-macos"]["steps"]
    for os_name, name in OWNED_FAN_IN.items():
        fan_in = cfg[name]
        shards = OWNED_SHARD_JOBS[os_name]
        ubuntu = os_name == "ubuntu-24.04"
        assert fan_in["needs"] == ["classify", shards, *(["computer-use-windows"] if ubuntu else [])]
        assert fan_in["env"]["SHARDS_RESULT"] == f"${{{{ needs.{shards}.result }}}}"
        if ubuntu:
            assert fan_in["env"]["WINDOWS_RESULT"] == "${{ needs.computer-use-windows.result }}"
            assert "packages/computer-use" in fan_in["env"]["WINDOWS_REQUIRED"]
        else:
            assert set(fan_in["env"]) == {"SHARDS_RESULT"}
        assert fan_in["runs-on"] == "ubuntu-24.04"


@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_owned_shard_jobs_share_one_definition_and_read_only_their_cell(event: str) -> None:
    """Evaluate the real matrix expressions without filtering out a wrong-OS shard."""
    cfg = jobs()
    assert cfg["owned-shards-ubuntu"]["steps"] == cfg["owned-shards-macos"]["steps"]
    trigger = Trigger(event=event, docs_only="true")
    plan = json.loads(classify_outputs(trigger)["plan"])
    for os_name, name in OWNED_SHARD_JOBS.items():
        assert cfg[name]["needs"] == "classify"
        assert cfg[name]["strategy"]["fail-fast"] is False
        entries = shard_entries(os_name, trigger)
        assert entries == plan[f"owned ({os_name})"]["shards"]
        assert {entry["os"] for entry in entries} == {os_name}
        assert f"owned ({os_name})" in expand(OWNED_FAN_IN[os_name], event)


def test_toolchain_pins_and_token_lifetime_follow_shared_steps() -> None:
    """Keep provenance ahead of installers and expose tokens only to fetch steps."""
    tools = yaml.safe_load((ROOT / ".github/actions/setup-ci-tools/action.yml").read_text())["runs"]["steps"]
    pinned_inputs = {
        "setup-node": ("node-version-file", ".node-version"),
        "setup-bun": ("bun-version-file", ".bun-version"),
        "setup-uv": ("version", "0.13.1"),
    }
    for action, (key, value) in pinned_inputs.items():
        step = next(step for step in tools if f"/{action}@" in step.get("uses", ""))
        assert step["with"][key] == value
    assert any('require("./package.json").packageManager' in step.get("run", "") for step in tools)
    cfg = jobs()
    for name in (
        *OWNED_FAN_IN.values(),
        *OWNED_SHARD_JOBS.values(),
        "contracts",
        "stack",
        "computer-use-windows",
    ):
        job = cfg[name]
        assert "GH_TOKEN" not in job.get("env", {})
        steps = job["steps"]
        token_steps = [step for step in steps if "GH_TOKEN" in step.get("env", {})]
        if name in OWNED_FAN_IN.values():
            assert not token_steps
        elif name == "stack":
            assert [step["name"] for step in token_steps] == [
                "Verify root core overrides before install",
                "Fetch exact Gitlinked core release, formula-equivalent install",
            ]
            commands = "\n".join(step.get("run", "") for step in steps)
            assert commands.index("--verify-root-overrides") < commands.index("npm ci --ignore-scripts")
            assert commands.index("--gitlink ../../forks/pi") < commands.index("pytest scenarios/")
        elif name == "computer-use-windows":
            assert [step["name"] for step in token_steps] == [
                "Verify root core overrides before installing dependencies"
            ]
        else:
            assert [step["name"] for step in token_steps] == ["Install"]
            assert token_steps[0]["run"] == "make install-owned"
        assert all(step["env"]["GH_TOKEN"] == "${{ github.token }}" for step in token_steps)


def fan_in_step(name: str) -> dict[str, Any]:
    """Return one step of the shared fan-in definition.

    Parameters:
        name (str): Step name.

    Returns:
        dict[str, Any]: The step record.
    """
    return next(step for step in jobs()["owned-ubuntu"]["steps"] if step.get("name") == name)


@pytest.mark.parametrize(
    ("result", "passes"), [("success", True), ("failure", False), ("cancelled", False), ("skipped", False)]
)
def test_fan_in_requires_every_planned_shard(tmp_path: Path, result: str, passes: bool) -> None:
    """Run the fan-in's real check: only a `success` of the whole shard matrix passes a running cell.

    Parameters:
        tmp_path (Path): Disposable directory.
        result (str): `needs.<shard job>.result`.
        passes (bool): Whether the step succeeds.
    """
    step = fan_in_step("Require every planned shard to succeed")
    assert step["if"] == "steps.plan.outputs.run == 'true'"
    script = tmp_path / "require.sh"
    script.write_text(step["run"])
    completed = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ | {"SHARDS_RESULT": result, "CELL": "owned (macos-14)"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert (completed.returncode == 0) is passes
    if passes:
        assert "Every planned shard of owned (macos-14) succeeded" in completed.stdout
    else:
        assert f"::error title=owned (macos-14) shards {result}::" in completed.stdout


def run_merge(tmp_path: Path, shards: dict[str, list[str]]) -> tuple[subprocess.CompletedProcess[str], Path]:
    """Run the fan-in's real merge step over downloaded shard artifacts.

    Parameters:
        tmp_path (Path): Disposable directory.
        shards (dict[str, list[str]]): Artifact name and the report paths inside it.

    Returns:
        tuple[subprocess.CompletedProcess[str], Path]: The step's result and the workspace it merged into.
    """
    temp, workspace = tmp_path / "runner-temp", tmp_path / "workspace"
    workspace.mkdir()
    for artifact, reports in shards.items():
        for report in reports:
            path = temp / "shard-coverage" / artifact / report
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{artifact}\n")
    script = tmp_path / "merge.sh"
    script.write_text(fan_in_step("Merge the shards' coverage reports")["run"])
    completed = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ | {"RUNNER_TEMP": str(temp), "GITHUB_WORKSPACE": str(workspace)},
        capture_output=True,
        text=True,
        check=False,
    )
    return completed, workspace


def test_fan_in_merges_each_shard_report_at_its_repository_path(tmp_path: Path) -> None:
    """Put every downloaded report back where its producer wrote it, so accounting reads the same paths.

    Parameters:
        tmp_path (Path): Disposable directory.
    """
    completed, workspace = run_merge(
        tmp_path,
        {
            "coverage-ubuntu-24.04-subagents": ["packages/subagents/coverage/primary/lcov.info"],
            "coverage-ubuntu-24.04-python": [
                "scripts/coverage/primary/lcov.info",
                "tests/integration/probes/coverage/primary/lcov.info",
            ],
        },
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (workspace / "packages/subagents/coverage/primary/lcov.info").read_text() == (
        "coverage-ubuntu-24.04-subagents\n"
    )
    assert (workspace / "scripts/coverage/primary/lcov.info").read_text() == "coverage-ubuntu-24.04-python\n"
    assert (workspace / "tests/integration/probes/coverage/primary/lcov.info").is_file()


def test_macos_partition_keeps_the_complete_python_artifact_union(tmp_path: Path) -> None:
    """Merge both independent Python suites and every JS/benchmark report without overwrites.

    Parameters:
        tmp_path (Path): Disposable directory.
    """
    reports = {
        "scripts": [
            "scripts/coverage/python/lcov.info",
            "scripts/coverage/primary/lcov.info",
            "scripts/coverage/bun/lcov.info",
        ],
        "python": [
            "release/coverage/python/lcov.info",
            "tests/integration/coverage/python/lcov.info",
            "tests/integration/probes/coverage/primary/lcov.info",
            "tests/integration/probes/coverage/bun/lcov.info",
            "tests/integration/providers/coverage/primary/lcov.info",
            "tests/integration/providers/coverage/bun/lcov.info",
        ],
    }
    entries = {entry["shard"]: entry for entry in shard_entries("macos-14", Trigger(event="push"))}
    assert entries["scripts"]["gates"] == "check-scripts"
    assert entries["python"]["gates"] == "check-integration"
    completed, workspace = run_merge(
        tmp_path, {f"coverage-macos-14-{name}": paths for name, paths in reports.items()}
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    for name, paths in reports.items():
        for path in paths:
            assert (workspace / path).read_text() == f"coverage-macos-14-{name}\n"


def test_fan_in_refuses_a_report_two_shards_produced(tmp_path: Path) -> None:
    """Fail rather than let one shard's report silently replace another's.

    Parameters:
        tmp_path (Path): Disposable directory.
    """
    report = "scripts/coverage/primary/lcov.info"
    completed, workspace = run_merge(tmp_path, {"coverage-wsl2-a": [report], "coverage-wsl2-b": [report]})
    assert completed.returncode == 1
    assert (
        f"::error title=duplicate shard coverage::More than one shard produced: {report}" in completed.stdout
    )
    assert not (workspace / report).exists()


def test_fan_in_fails_when_no_shard_uploaded_a_report(tmp_path: Path) -> None:
    """Fail closed when nothing was downloaded at all.

    Parameters:
        tmp_path (Path): Disposable directory.
    """
    completed, _ = run_merge(tmp_path, {})
    assert completed.returncode != 0


def test_fan_in_downloads_exactly_its_own_shard_uploads() -> None:
    """Match every shard upload of the cell, and neither another cell's nor the fan-in's own artifact."""
    shard_upload = next(
        step
        for step in jobs()["owned-shards-macos"]["steps"]
        if step.get("name") == "Preserve this shard's coverage reports"
    )
    download = fan_in_step("Download the shards' coverage reports")
    fan_in_upload = fan_in_step("Preserve independent coverage reports and summary")
    assert "merge-multiple" not in download["with"]
    assert download["with"]["path"] == "${{ runner.temp }}/shard-coverage"
    for os_name in OWNED_SHARD_JOBS:
        pattern = render(download["with"]["pattern"], {"matrix.os": os_name})
        names = {
            render(shard_upload["with"]["name"], {"matrix.os": other, "matrix.shard": entry["shard"]}): other
            for other in OWNED_SHARD_JOBS
            for entry in shard_entries(other, Trigger(event="push"))
        }
        assert {name for name in names if fnmatch.fnmatchcase(name, pattern)} == {
            name for name, other in names.items() if other == os_name
        }
        assert not fnmatch.fnmatchcase(render(fan_in_upload["with"]["name"], {"matrix.os": os_name}), pattern)
    # The shards upload reports only; the fan-in's accounting writes the one summary.
    assert "coverage/summary.json" not in shard_upload["with"]["path"]
    assert shard_upload["with"]["path"] + "coverage/summary.json\n" == fan_in_upload["with"]["path"]


@pytest.mark.parametrize(("os_name", "coverage_os"), [("ubuntu-24.04", "linux"), ("macos-14", "darwin")])
def test_fan_in_accounts_each_cell_against_its_own_os_floors(os_name: str, coverage_os: str) -> None:
    """Account the macOS reports with the darwin floors although the fan-in runs on Ubuntu.

    Parameters:
        os_name (str): Matrix `os` of the cell.
        coverage_os (str): `coverage_accounting.py --os` it must select.
    """
    step = fan_in_step("Coverage accounting (existing reports, including test failures)")
    context = {
        "matrix.os": os_name,
        "needs.classify.outputs.plan": classify_outputs(Trigger(event="push"))["plan"],
    }
    assert render(step["env"]["COVERAGE_OS"], context) == coverage_os
    assert step["run"] == (
        'make check-coverage BASE="$BASE" COVERAGE_OS="$COVERAGE_OS" COVERAGE_HOST="$COVERAGE_HOST" '
        'COVERAGE_SKIPPED_GATES="$COVERAGE_SKIPPED_GATES"'
    )
    recipe = subprocess.run(
        ["make", "--no-print-directory", "-n", "check-coverage", "BASE=base", f"COVERAGE_OS={coverage_os}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert recipe.strip().endswith(f'--base "base" --os "{coverage_os}"')
    skipping = subprocess.run(
        ["make", "--no-print-directory", "-n", "check-coverage", "COVERAGE_SKIPPED_GATES=check-example"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert skipping.strip().endswith('--skipped-gates "check-example"')


@pytest.mark.parametrize(
    ("trigger", "skipped"),
    [(Trigger(), ""), (Trigger(event="push"), "")],
)
def test_fan_in_accounting_skips_exactly_the_gates_its_shards_skipped(trigger: Trigger, skipped: str) -> None:
    """Hand the fan-in's accounting the same empty `skipped_gates` its shard plans publish.

    Parameters:
        trigger (Trigger): Event and `classify` outputs.
        skipped (str): Gates the macOS cell reports NOT RUN.
    """
    step = fan_in_step("Coverage accounting (existing reports, including test failures)")
    plan = classify_outputs(trigger)["plan"]
    for os_name in OWNED_FAN_IN:
        context = {"matrix.os": os_name, "needs.classify.outputs.plan": plan}
        rendered = render(step["env"]["COVERAGE_SKIPPED_GATES"], context)
        shard_skips = {
            gate for entry in shard_entries(os_name, trigger) for gate in entry["skipped_gates"].split()
        }
        assert rendered == (skipped if os_name == "macos-14" else "")
        assert set(rendered.split()) == shard_skips


@pytest.mark.parametrize("check", ["owned (ubuntu-24.04)", "owned (macos-14)"])
def test_running_fan_in_accounts_for_the_merged_reports(tmp_path: Path, check: str) -> None:
    """Walk a running fan-in: shard check, checkout, download, merge, accounting and the summary upload.

    Parameters:
        tmp_path (Path): Disposable output directory.
        check (str): Owned cell.
    """
    steps = executed_steps("owned", check, tmp_path, Trigger(event="push"))
    assert {
        "Require every planned shard to succeed",
        "Download the shards' coverage reports",
        "Merge the shards' coverage reports",
        "Coverage accounting (existing reports, including test failures)",
        "Preserve independent coverage reports and summary",
        "./.github/actions/setup-ci-tools",
    } <= steps
    assert not any(step.startswith("Owned gate ") for step in steps)


def test_all_original_cases_and_new_applicable_gates_share_the_boundary() -> None:
    """Keep exact scenario selectors and gates."""
    cfg = jobs()
    assert set(cfg) == {
        "classify",
        *OWNED_SHARD_JOBS.values(),
        *OWNED_FAN_IN.values(),
        "computer-use-windows",
        "contracts",
        "stack",
        "release-core",
    }
    assert cfg["release-core"] == {
        "if": "github.event_name == 'workflow_dispatch'",
        "needs": "classify",
        "uses": "./.github/workflows/forks.yml",
    }
    owned = cfg["owned-shards-ubuntu"]["steps"]
    arm = next(step for step in owned if step.get("name") == "Add the aarch64 Linux compile target")
    assert arm["if"] == "matrix.guest == 'linux' && contains(matrix.workspaces, 'packages/computer-use')"
    contracts = [step["run"] for step in cfg["contracts"]["steps"] if "run" in step]
    for target in (
        "check-package-contracts",
        "check-plan-mode-package-contract",
        "check-subagents-package-contract",
        "check-todo-package-contract",
        "check-computer-use-package-contract",
    ):
        assert any(command.startswith(f"make {target} REPORT=") for command in contracts)
    stack = cfg["stack"]
    assert {cell["stack"] for cell in expand("stack").values()} == {"personal", "local"}
    runs = [step for step in stack["steps"] if "pytest scenarios/" in step.get("run", "")]
    assert len(runs) == 3
    # The candidate `--bun-auth-adapter` lane is gone (#14): auth cases run inside standalone D/E.
    assert not any("--bun-auth-adapter" in step["run"] for step in stack["steps"] if "run" in step)
    for step in runs:
        assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in step["run"]
        assert "-m stack -n 2 --dist loadfile" in step["run"]
        assert "matrix.os" not in step["if"]  # No WSL-only elision.
    assert '--stack "../../release/stacks/${{ matrix.stack }}.json"' in runs[0]["run"]
    assert "stacks/personal.json --runtime bun-standalone" in runs[1]["run"]
    assert "stacks/local.json --runtime bun-standalone" in runs[2]["run"]
    uploads = [step for step in stack["steps"] if "upload-artifact@" in step.get("uses", "")]
    startup = next(
        step for step in uploads if step.get("name") == "Upload scanned standalone startup failure evidence"
    )
    assert startup["if"] == (
        "${{ !cancelled() && steps.startup.outcome == 'failure' "
        "&& steps.startup.outputs.artifact_ready == 'true' }}"
    )
    build_failure = next(
        step for step in uploads if step["with"]["name"].startswith("standalone-build-failure-")
    )
    assert build_failure["if"] == (
        "${{ !cancelled() && steps.build.outcome == 'failure' "
        "&& steps.build_failure.outputs.artifact_ready == 'true' }}"
    )
    assert (
        build_failure["with"]["name"] == "standalone-build-failure-${{ matrix.platform }}-${{ matrix.stack }}"
    )
    assert build_failure["with"]["path"] == "${{ runner.temp }}/standalone-build-failure/"
    assert build_failure["with"]["if-no-files-found"] == "warn"
    assert build_failure["with"]["retention-days"] == 7
    assert any(step.get("id") == "build_failure" for step in stack["steps"])
    assert all(
        "always()" in step["if"] for step in uploads if step is not startup and step is not build_failure
    )
    assert startup["with"]["name"] == "standalone-startup-linux-x64"
    standalone = next(step for step in uploads if step["with"]["name"].startswith("standalone-${{"))
    assert standalone["with"]["name"] == "standalone-${{ matrix.platform }}-${{ matrix.stack }}"
    assert standalone["with"]["path"] == "tests/integration/artifacts/"
    assert not (WORKFLOW.parent / "wsl2.yml").exists()
    for path in WORKFLOW.parent.glob("*.yml"):
        if path != WORKFLOW:
            # A control-test workflow may name the action in its path filter without invoking guest setup.
            assert "uses: ./.github/actions/setup-ci-wsl" not in path.read_text()
            assert "wsl2_run.sh" not in path.read_text()


def runs_npm_install(step: dict[str, Any]) -> bool:
    """Report whether a workflow step runs `npm ci`, directly or through `make install-owned`.

    Parameters:
        step (dict[str, Any]): One workflow step.

    Returns:
        bool: True when a line of the step's `run` script starts with `npm ci` or `make install-owned`.
    """
    return NPM_INSTALL_COMMAND.search(step.get("run", "")) is not None


def test_setup_ci_tools_restores_the_lockfile_npm_cache_under_its_own_key() -> None:
    """Pin the explicit npm cache that keeps release-CDN tarball fetches out of every `npm ci` (#531).

    setup-node's implicit npm cache key is shared with workflows that never run `npm ci`, which saved an empty
    cache that every hosted macOS cell then restored.
    """
    action = yaml.safe_load((ROOT / ".github/actions/setup-ci-tools/action.yml").read_text())
    assert action["inputs"]["npm-cache"]["default"] == "true"
    steps = action["runs"]["steps"]
    node = next(i for i, step in enumerate(steps) if "actions/setup-node@" in step.get("uses", ""))
    assert steps[node]["with"]["package-manager-cache"] is False
    assert "cache" not in steps[node]["with"]
    pin = next(i for i, step in enumerate(steps) if step.get("name") == "Pin npm to packageManager")
    locate = next(i for i, step in enumerate(steps) if step.get("id") == "npm-cache")
    assert steps[locate]["run"] == 'echo "dir=$(npm config get cache)" >>"$GITHUB_OUTPUT"'
    cache = next(i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/cache@"))
    assert node < pin < locate < cache
    assert re.fullmatch(r"actions/cache@[0-9a-f]{40}", steps[cache]["uses"])
    gate = "inputs.npm-cache == 'true'"
    assert steps[locate]["if"] == steps[cache]["if"] == gate
    # The prefix restore keeps a lockfile-changing run warm for every tarball the change did not touch.
    assert steps[cache]["with"] == {
        "path": "${{ steps.npm-cache.outputs.dir }}",
        "key": "npm-ci-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}",
        "restore-keys": "npm-ci-${{ runner.os }}-${{ runner.arch }}-",
    }


def test_every_npm_ci_job_restores_the_npm_cache_and_no_other_job_saves_one() -> None:
    """Every ci.yml job that runs `npm ci` restores the npm cache first; any other job turns it off."""
    installing: set[str] = set()
    for name, job in jobs().items():
        steps = job.get("steps", [])
        setups = [i for i, step in enumerate(steps) if step.get("uses") == SETUP_CI_TOOLS]
        installs = [i for i, step in enumerate(steps) if runs_npm_install(step)]
        if installs:
            installing.add(name)
            assert setups, name
            assert setups[0] < installs[0], name
            assert all(steps[i].get("with", {}).get("npm-cache", "true") == "true" for i in setups), name
        else:
            assert all(steps[i].get("with", {}).get("npm-cache") == "false" for i in setups), name
    assert {*OWNED_SHARD_JOBS.values(), "contracts", "stack"} <= installing


def lexical_path[PathType: PurePath](source: PathType) -> PathType:
    """Normalize a workflow path lexically without resolving symlinks or accessing the filesystem.

    Parameters:
        source (PathType): Workflow path to normalize.

    Returns:
        PathType: Lexically normalized path of the same flavour.
    """
    parts: list[str] = []
    for part in source.parts:
        if part == source.anchor:
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
        elif part != ".." or not source.anchor:
            parts.append(part)
    return type(source)(source.anchor, *parts)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("./a//b/../package-lock.json", "a/package-lock.json"),
        ("a/../../package-lock.json", "../package-lock.json"),
        ("/../../a/../package-lock.json", "/package-lock.json"),
        ("a/..", "."),
    ],
)
def test_lexical_path(value: str, expected: str) -> None:
    """Normalize dot segments without following filesystem links.

    Parameters:
        value (str): Workflow path to normalize.
        expected (str): Expected normalized path.
    """
    assert lexical_path(Path(value)) == Path(expected)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (PurePosixPath("//a/../package-lock.json"), PurePosixPath("//package-lock.json")),
        (PureWindowsPath("//a/../package-lock.json"), PureWindowsPath("//a/../package-lock.json")),
        (
            PureWindowsPath("//server/share/a/../package-lock.json"),
            PureWindowsPath("//server/share/package-lock.json"),
        ),
        (PureWindowsPath("C:/../../a/../package-lock.json"), PureWindowsPath("C:/package-lock.json")),
    ],
)
def test_lexical_path_flavours(value: PurePath, expected: PurePath) -> None:
    """Preserve POSIX roots and Windows drive and UNC anchors.

    Parameters:
        value (PurePath): Workflow path to normalize.
        expected (PurePath): Expected normalized path.
    """
    assert lexical_path(value) == expected


def installed_lockfiles(job: dict[str, Any]) -> set[Path]:
    """Return the lockfile each `npm ci` step of a job installs, from its working directory.

    Parameters:
        job (dict[str, Any]): One workflow job.

    Returns:
        set[Path]: Lexically normalized `package-lock.json` paths.
    """
    default = job.get("defaults", {}).get("run", {}).get("working-directory", ".")
    return {
        lexical_path(Path(f"{step.get('working-directory', default)}/package-lock.json"))
        for step in job.get("steps", [])
        if runs_npm_install(step)
    }


@pytest.mark.parametrize(
    "workflow", sorted((ROOT / ".github/workflows").glob("*.yml")), ids=lambda path: path.name
)
def test_setup_node_caches_only_the_lockfile_its_job_installs(workflow: Path) -> None:
    """A setup-node npm cache is keyed on a lockfile its own job's `npm ci` installs, or is off.

    A job with no `npm ci` would save an empty cache (`installer.yml`), and one keyed on another lockfile
    would save its dependencies under a key a root install restores (`forks.yml`) (#531).

    Parameters:
        workflow (Path): One workflow file.
    """
    for name, job in yaml.safe_load(workflow.read_text())["jobs"].items():
        for step in job.get("steps", []):
            if "actions/setup-node@" not in step.get("uses", ""):
                continue
            options = step.get("with", {})
            if "cache" not in options and options.get("package-manager-cache") is False:
                continue
            lockfile = lexical_path(Path(options.get("cache-dependency-path", "package-lock.json")))
            assert lockfile in installed_lockfiles(job), f"{workflow.name}:{name}"


def test_release_verify_restores_the_ci_npm_cache_without_saving() -> None:
    """`publish.yml` `verify` restores the `setup-ci-tools` npm cache before its root `npm ci`, read-only."""
    action = yaml.safe_load((ROOT / ".github/actions/setup-ci-tools/action.yml").read_text())
    ci_cache = next(
        step for step in action["runs"]["steps"] if step.get("uses", "").startswith("actions/cache@")
    )
    steps = yaml.safe_load((ROOT / ".github/workflows/publish.yml").read_text())["jobs"]["verify"]["steps"]
    assert not any(step.get("uses", "").startswith("actions/cache@") for step in steps)
    pin = next(i for i, step in enumerate(steps) if step.get("name") == "Pin npm to packageManager")
    locate = next(i for i, step in enumerate(steps) if step.get("id") == "npm-cache")
    restore = next(
        i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/cache/restore@")
    )
    install = next(i for i, step in enumerate(steps) if "npm_release.py verify" in step.get("run", ""))
    assert pin < locate < restore < install
    assert steps[restore]["uses"].split("@")[1] == ci_cache["uses"].split("@")[1]
    assert steps[restore]["with"] == ci_cache["with"]


NATIVE_HOST_STEPS = ("Smoke the native guest", "Bootstrap tools in the native guest")


def test_every_action_in_the_pool_workflows_stays_pinned_to_a_full_sha() -> None:
    """Repo setting `sha_pinning_required`: no `uses:` may name a tag or branch."""
    for workflow in ("ci.yml", "runner-smoke.yml", "runner-rescue.yml"):
        text = (ROOT / ".github/workflows" / workflow).read_text()
        for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", text, re.MULTILINE):
            assert ref.startswith("./") or re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", ref), (
                workflow,
                ref,
            )


def test_runner_smoke_is_dispatch_only() -> None:
    """No pool smoke job is queued by a pull request."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/runner-smoke.yml").read_text())
    assert set(workflow[True]) == {"workflow_dispatch"}
    assert set(workflow["jobs"]) == {"pi-linux", "pi-macos"}
    for path in WORKFLOW.parent.glob("*.yml"):
        workflow = yaml.safe_load(path.read_text())
        assert "wsl2" not in yaml.safe_dump(workflow["jobs"]).lower(), path.name
