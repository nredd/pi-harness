"""Pin the CI matrix and exercise the guest adapter without pretending to run WSL.

References:
    https://docs.github.com/actions/using-jobs/using-a-matrix-for-your-jobs
    https://learn.microsoft.com/windows/wsl/filesystems
"""

from __future__ import annotations

import fnmatch
import itertools
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import merge_pr_checks

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
PLATFORMS = {
    "ubuntu-24.04": ("ubuntu-24.04", "linux", "linux-x64"),
    "macos-14": ("xcode-27", "macos", "darwin-arm64"),
    "wsl2": ("windows-2025", "wsl2", "linux-x64"),
}
STACK_PLATFORMS = PLATFORMS | {"wsl2": ("ubuntu-24.04", "linux", "linux-x64")}
RUNNER_OS = {"ubuntu-24.04": "Linux", "xcode-27": "macOS", "windows-2025": "Windows"}
PLAN_ONLY = {"Check out the local actions", "Report execution plan"}
REPORT_PLAN = ROOT / ".github/actions/report-plan/action.yml"
PERSONAL_STEPS = {
    "Replay source-selected installer runtime locks without lifecycle scripts",
    "Strict standalone startup with failure-only diagnostics",
    "Standalone D and E (personal)",
    "Candidate compiled-core auth adapter (personal)",
}
LOCAL_STEPS = {"Standalone D and E (local)", "Candidate compiled-core auth adapter (local)"}
BUILD_AND_NODE = {"Assembled D and E boundaries (explicit stack, no machine config)", "Build standalone"}
# Each `owned (<os>)` check is its own fan-in job over its own shard job (#350).
OWNED_FAN_IN = {"ubuntu-24.04": "owned-ubuntu", "macos-14": "owned-macos", "wsl2": "owned-wsl2"}
OWNED_SHARD_JOBS = {
    "ubuntu-24.04": "owned-shards-ubuntu",
    "macos-14": "owned-shards-macos",
    "wsl2": "owned-shards-wsl2",
}


@dataclass(frozen=True)
class Trigger:
    """One workflow trigger and the `classify` outputs it produced.

    Parameters:
        event (str): Triggering event.
        docs_only (str): `classify` output.
        wsl_inputs (str): `classify` output, empty modelling a missing output.
        stack_inputs (str): `classify` output.
        benchmark_inputs (str): `classify` output.
        title_problem (str): A PR title failure the plan turns into a blocked cell.
        classify_result (str): The `classify` job's result; anything but `success` publishes no plan.
    """

    event: str = "pull_request"
    docs_only: str = "false"
    wsl_inputs: str = "true"
    stack_inputs: str = "true"
    benchmark_inputs: str = "true"
    title_problem: str = ""
    classify_result: str = "success"


PULL_REQUEST = Trigger()


def test_wsl_setup_rewrites_clean_crlf_checkout_to_exact_lf(tmp_path: Path) -> None:
    """Run setup's actual Git commands against a clean Windows-style checkout.

    Parameters:
        tmp_path (Path): Isolated repository, templates and configuration boundary.
    Returns:
        None: Tracked text matches blob bytes and binary assets are unchanged.
    Raises:
        AssertionError: Setup leaves CRLF in a clean index/worktree or modifies binary bytes.
        subprocess.CalledProcessError: A real fixture Git command fails.
    """
    git = shutil.which("git")
    assert git
    repo = tmp_path / "repo"
    repo.mkdir()
    templates = tmp_path / "templates"
    templates.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")} | {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
    }

    def command(*args: str) -> bytes:
        """Run fixture Git with isolated routing/configuration and no inherited hooks.

        Parameters:
            args (str): Literal Git arguments.
        Returns:
            bytes: Captured stdout.
        """
        return subprocess.check_output([git, *args], cwd=repo, env=env, stderr=subprocess.STDOUT)

    command("init", "--quiet", f"--template={templates}")
    command("config", "user.name", "Fixture")
    command("config", "user.email", "fixture@example.invalid")
    command("config", "core.autocrlf", "true")
    command("config", "core.eol", "crlf")
    (repo / ".git/info").mkdir(exist_ok=True)
    (repo / ".git/info/attributes").write_text("*.swift text\n*.ts text\n")
    expected = {
        "helper.swift": b'if let pid {\n\t\t\tapps = [["pid": Int(pid)]]\n}\n',
        "index.ts": b"export const value = 1;\n",
        "native.bin": b"\x00binary\r\nbytes\n",
    }
    for name, content in expected.items():
        (repo / name).write_bytes(content)
    command("add", ".")
    command("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture")
    for name in expected:
        (repo / name).unlink()
    command("checkout-index", "--all", "--force")
    assert (repo / "helper.swift").read_bytes() == expected["helper.swift"].replace(b"\n", b"\r\n")
    command("add", ".")
    assert command("status", "--porcelain") == b""
    setup = yaml.safe_load((ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text())
    for line in setup["runs"]["steps"][0]["run"].splitlines():
        if line.startswith("git "):
            command(*shlex.split(line)[1:])
    assert {name: (repo / name).read_bytes() for name in expected} == expected


def jobs() -> dict[str, Any]:
    """Return parsed CI jobs, retaining GitHub expressions as strings.

    Returns:
        dict[str, Any]: YAML job records.
    """
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]


def job_id(name: str, cell: dict[str, str]) -> str:
    """Return the workflow job that reports one cell of a check family.

    Parameters:
        name (str): Check family, `owned`, `contracts` or `stack`.
        cell (dict[str, str]): Expanded matrix cell.

    Returns:
        str: Job id; each `owned (<os>)` cell is its own fan-in job.
    """
    return OWNED_FAN_IN[cell["os"]] if name == "owned" else name


def expand(name: str) -> dict[str, dict[str, str]]:
    """Expand a check family's matrices with GitHub's `include` rules, keyed by each cell's check name.

    Parameters:
        name (str): Check family, `owned`, `contracts` or `stack`.

    Returns:
        dict[str, dict[str, str]]: Each reported check name and its cell values.
    """
    cells: dict[str, dict[str, str]] = {}
    for job in (jobs()[job] for job in (OWNED_FAN_IN.values() if name == "owned" else [name])):
        matrix = job["strategy"]["matrix"]
        axes = {key: value for key, value in matrix.items() if key != "include"}
        for values in itertools.product(*axes.values()):
            cell = dict(zip(axes, values, strict=True))
            for record in matrix.get("include", []):
                # An include applies unless it would overwrite an original axis value.
                if all(cell.get(key) == value for key, value in record.items() if key in axes):
                    cell |= record
            cells[
                job["name"]
                .replace("${{ matrix.os }}", cell["os"])
                .replace("${{ matrix.stack }}", cell.get("stack", ""))
            ] = cell
    return cells


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
            "wsl_inputs": trigger.wsl_inputs != "false",
            "stack_inputs": trigger.stack_inputs != "false",
            "benchmark_inputs": trigger.benchmark_inputs != "false",
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
    return {
        "needs.classify.outputs.plan": classify_outputs(trigger)["plan"],
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
    return render(jobs()[job_id(name, cell)]["runs-on"], context | classify_context(trigger))


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
    cell = expand(name)[check]
    job_step = next(step for step in jobs()[job_id(name, cell)]["steps"] if step.get("id") == "plan")
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
    cell = expand(name)[check]
    outputs, _, _ = run_plan(name, check, tmp_path, trigger)
    context = {f"matrix.{key}": value for key, value in cell.items()}
    context |= {f"steps.plan.outputs.{key}": value for key, value in outputs.items()}
    context |= {
        "needs.classify.outputs.benchmark_inputs": trigger.benchmark_inputs,
        "github.event_name": trigger.event,
        "runner.os": RUNNER_OS[runner_for(name, cell, trigger)],
    }
    return walk_steps(jobs()[job_id(name, cell)]["steps"], context)


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
    return list(evaluate(job["strategy"]["matrix"]["include"], context))


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
        "needs.classify.outputs.benchmark_inputs": trigger.benchmark_inputs,
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


@pytest.mark.parametrize(
    ("check", "runner", "stack_cell_not_run"),
    [
        ("stack (ubuntu-24.04, personal)", "ubuntu-24.04", False),
        ("stack (ubuntu-24.04, local)", "ubuntu-24.04", False),
        ("stack (macos-14, local)", "xcode-27", False),
        ("stack (macos-14, personal)", "ubuntu-24.04", True),
        ("stack (wsl2, personal)", "ubuntu-24.04", True),
        ("stack (wsl2, local)", "ubuntu-24.04", True),
    ],
)
def test_stack_cells_select_their_runner(check: str, runner: str, stack_cell_not_run: bool) -> None:
    """Spend no macOS or Windows slot on a cell that only reports.

    Parameters:
        check (str): Required check name.
        runner (str): Expected runner.
        stack_cell_not_run (bool): Whether the cell permanently reports NOT RUN.
    """
    cell = expand("stack")[check]
    assert runner_for("stack", cell) == runner
    assert ((cell["os"], cell["stack"]) in ci_paths.STACK_NOT_RUN) is stack_cell_not_run


@pytest.mark.parametrize(
    "check", ["stack (macos-14, personal)", "stack (wsl2, personal)", "stack (wsl2, local)"]
)
@pytest.mark.parametrize(
    ("event", "docs_only"), [("pull_request", "false"), ("pull_request", "true"), ("push", "false")]
)
def test_stack_bypass_cells_report_not_run(tmp_path: Path, check: str, event: str, docs_only: str) -> None:
    """Report NOT RUN and why, on every event, and execute nothing but the plan.

    Parameters:
        tmp_path (Path): Disposable output directory.
        check (str): Permanent bypass cell.
        event (str): Triggering event.
        docs_only (str): `classify` output.
    """
    trigger = Trigger(event=event, docs_only=docs_only)
    outputs, stdout, summary = run_plan("stack", check, tmp_path, trigger)
    assert outputs["run"] == "false"
    os_name, stack = check.removeprefix("stack (").removesuffix(")").split(", ")
    reason = ci_paths.STACK_NOT_RUN[os_name, stack]
    assert f"::notice title={check} NOT RUN::{reason}" in stdout
    assert f"### {check} NOT RUN" in summary
    assert "not a pass" in summary
    assert reason in summary
    assert executed_steps("stack", check, tmp_path, trigger) == PLAN_ONLY


WSL_TRIGGERS = [
    (Trigger(wsl_inputs="false"), "ubuntu-24.04", False),
    (Trigger(wsl_inputs="false", docs_only="true"), "ubuntu-24.04", False),
    (Trigger(wsl_inputs="true"), "windows-2025", True),
    (Trigger(wsl_inputs=""), "windows-2025", True),
    (Trigger(event="push", wsl_inputs="false"), "windows-2025", True),
    (Trigger(event="push", wsl_inputs="false", docs_only="true"), "windows-2025", True),
]


@pytest.mark.parametrize(("trigger", "runner", "runs"), WSL_TRIGGERS)
def test_wsl_contracts_run_on_main_and_for_wsl_inputs(
    tmp_path: Path, trigger: Trigger, runner: str, runs: bool
) -> None:
    """Hold Windows slots only for `main` and PRs touching WSL inputs, failing closed.

    Parameters:
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.
        runner (str): Expected runner.
        runs (bool): Whether the cell does real work.
    """
    check = "contracts (wsl2)"
    assert runner_for("contracts", expand("contracts")[check], trigger) == runner
    outputs, stdout, summary = run_plan("contracts", check, tmp_path, trigger)
    assert outputs["run"] == str(runs).lower()
    steps = executed_steps("contracts", check, tmp_path, trigger)
    assert ("Select and verify Git Bash on the Windows host" in steps) is runs
    if runs:
        assert "NOT RUN" not in stdout + summary
        assert "./.github/actions/setup-ci-tools" in steps
        return
    assert steps == PLAN_ONLY
    assert f"::notice title={check} NOT RUN::" in stdout
    assert f"### {check} NOT RUN" in summary
    assert "not a pass" in summary


@pytest.mark.parametrize(("trigger", "runner", "runs"), WSL_TRIGGERS)
def test_wsl_owned_shards_run_on_main_and_for_wsl_inputs(
    tmp_path: Path, trigger: Trigger, runner: str, runs: bool
) -> None:
    """Start Windows shards only for `main` and PRs touching WSL inputs; the fan-in reports from Ubuntu.

    Parameters:
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.
        runner (str): Runner the cell's work lands on.
        runs (bool): Whether the cell does real work.
    """
    check = "owned (wsl2)"
    assert runner_for("owned", expand("owned")[check], trigger) == "ubuntu-24.04"
    outputs, stdout, summary = run_plan("owned", check, tmp_path, trigger)
    assert outputs["run"] == str(runs).lower()
    entries = shard_entries("wsl2", trigger)
    assert bool(entries) is runs
    for entry in entries:
        assert shard_runner("wsl2", entry) == runner
        steps = shard_steps("wsl2", entry, trigger)
        assert "Select and verify Git Bash on the Windows host" in steps
        assert "./.github/actions/setup-ci-tools" in steps
    if runs:
        assert "NOT RUN" not in stdout + summary
        return
    assert executed_steps("owned", check, tmp_path, trigger) == PLAN_ONLY
    assert f"::notice title={check} NOT RUN::" in stdout
    assert f"### {check} NOT RUN" in summary
    assert "not a pass" in summary


@pytest.mark.parametrize("name", ["owned", "contracts"])
@pytest.mark.parametrize("os_name", ["ubuntu-24.04", "macos-14"])
def test_native_cells_ignore_wsl_inputs(tmp_path: Path, name: str, os_name: str) -> None:
    """Never route native evidence through the WSL bypass.

    Parameters:
        tmp_path (Path): Disposable output directory.
        name (str): Ordinary CI gate job.
        os_name (str): Native matrix cell.
    """
    check = f"{name} ({os_name})"
    trigger = Trigger(wsl_inputs="false")
    if name == "owned":
        entries = shard_entries(os_name, trigger)
        assert entries
        assert {shard_runner(os_name, entry) for entry in entries} == {PLATFORMS[os_name][0]}
    else:
        assert runner_for(name, expand(name)[check], trigger) == PLATFORMS[os_name][0]
    outputs, stdout, _ = run_plan(name, check, tmp_path, trigger)
    assert outputs["run"] == "true"
    assert "NOT RUN" not in stdout


@pytest.mark.parametrize(
    "check", ["stack (ubuntu-24.04, personal)", "stack (ubuntu-24.04, local)", "stack (macos-14, local)"]
)
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
    steps = executed_steps("stack", check, tmp_path, Trigger(stack_inputs=stack_inputs))
    assert steps >= LOCAL_STEPS | BUILD_AND_NODE
    assert not steps & PERSONAL_STEPS


@pytest.mark.parametrize(
    "check",
    ["stack (ubuntu-24.04, local)", "stack (macos-14, local)"],
)
def test_main_smoke_retains_only_ubuntu_personal(tmp_path: Path, check: str) -> None:
    """Keep the existing `main` selective smoke for the other running cells.

    Parameters:
        tmp_path (Path): Disposable output directory.
        check (str): Cell skipped by the smoke.
    """
    outputs, stdout, _ = run_plan("stack", check, tmp_path, Trigger(event="push"))
    assert outputs["run"] == "false"
    assert ci_paths.NOT_RUN["main_smoke"] in stdout


def test_standalone_uploads_cannot_collide_between_stack_cells() -> None:
    """Both Ubuntu cells now build, so the artifact name must include the stack."""
    steps = jobs()["stack"]["steps"]
    upload = next(step for step in steps if step.get("with", {}).get("name", "").startswith("standalone-${{"))
    running = [
        cell for cell in expand("stack").values() if (cell["os"], cell["stack"]) not in ci_paths.STACK_NOT_RUN
    ]
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
        for flag in ("docs_only=false", "wsl_inputs=true", "stack_inputs=true", "benchmark_inputs=true"):
            assert flag in lines
        assert "Full frozen release candidate" in lines
        plan = json.loads(next(line for line in lines if line.startswith("plan="))[5:])
        # No diff to read: every required name runs for real, nothing is a bypass.
        assert set(plan) == merge_pr_checks.EXPECTED_MATRIX
        skipped = {name for name, cell in plan.items() if not cell["run"]}
        assert skipped == {"stack (macos-14, personal)", "stack (wsl2, personal)", "stack (wsl2, local)"}
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
            "BENCHMARK_INPUTS": "true",
            "CHANGED_FILES": "a.txt",
            "GITHUB_STEP_SUMMARY": str(summary),
        },
        capture_output=True,
        text=True,
        check=True,
    )
    assert "::notice title=bench not run::" in result.stdout
    assert "wsl-inputs=true stack-inputs=false benchmark-inputs=true" in result.stdout
    assert "Benchmark inputs: `true`" in summary.read_text()
    assert "### bench: NOT RUN" in summary.read_text()
    assert "This is not a pass." in summary.read_text()


def test_benchmark_install_runs_only_where_check_benchmark_runs() -> None:
    """Sync `benchmarks/comparison` only on macOS `owned`, keeping `make install` whole."""

    def recipe(target: str) -> str:
        """Return Make's real dry-run recipe.

        Parameters:
            target (str): Make target.

        Returns:
            str: Commands Make would run.
        """
        return subprocess.run(
            ["make", "-n", target], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout

    assert "benchmarks/comparison" not in recipe("install-owned")
    assert "--verify-root-overrides" in recipe("install-owned")
    assert "benchmarks/comparison" in recipe("install-benchmark")
    full = recipe("install")
    assert full.index("--verify-root-overrides") < full.index("npm ci") < full.index("benchmarks/comparison")
    cfg = jobs()
    for name in ("owned-shards-macos", "contracts"):
        install = next(step for step in cfg[name]["steps"] if step.get("name") == "Install")
        assert install["run"] == "make install-owned"
    gate = next(
        step for step in cfg["owned-shards-macos"]["steps"] if step.get("name") == "Benchmark unit gate"
    )
    assert "contains(matrix.gates, 'check-benchmark')" in gate["if"]
    assert [
        shard.name for shard in ci_paths.OWNED_SHARDS["macos-14"] if "check-benchmark" in shard.gates
    ] == ["python"]
    assert not any("check-benchmark" in ci_paths.OWNED_GATES[os_name] for os_name in ("ubuntu-24.04", "wsl2"))
    assert gate["run"].index("make install-benchmark") < gate["run"].index("make check-benchmark")
    # No cp315 `pydantic-core` wheel: an unpinned interpreter makes uv compile it, per sync.
    run = gate["run"]
    assert run.index("export UV_PYTHON=") < run.index("make install-benchmark")


BENCHMARK_STEP = "Benchmark unit gate"
BENCHMARK_SKIP_STEP = "Benchmark unit gate (not run, no benchmark inputs)"
FAN_IN_BENCHMARK_NOTICE = "Benchmark unit gate (not run)"


@pytest.mark.parametrize(
    ("trigger", "runs"),
    [
        (Trigger(benchmark_inputs="true"), True),
        (Trigger(benchmark_inputs="false"), False),
        (Trigger(event="push", benchmark_inputs="false"), True),
        (Trigger(event="push", benchmark_inputs="true"), True),
        # A missing or empty output must fail open, like `wsl_inputs` and `stack_inputs`.
        (Trigger(benchmark_inputs=""), True),
        (Trigger(event="push", benchmark_inputs=""), True),
    ],
)
def test_benchmark_gate_runs_on_inputs_or_main_push_only_on_macos(
    tmp_path: Path, trigger: Trigger, runs: bool
) -> None:
    """Run `check-benchmark` for benchmark inputs and every push, report NOT RUN otherwise.

    Parameters:
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.
        runs (bool): Whether the macOS cell executes the gate.
    """
    trigger = replace(trigger, wsl_inputs="true")
    mac = {
        entry["shard"]: shard_steps("macos-14", entry, trigger)
        for entry in shard_entries("macos-14", trigger)
    }
    assert {name for name, steps in mac.items() if BENCHMARK_STEP in steps} == ({"python"} if runs else set())
    assert {name for name, steps in mac.items() if BENCHMARK_SKIP_STEP in steps} == (
        set() if runs else {"python"}
    )
    for os_name in ("ubuntu-24.04", "wsl2"):
        for entry in shard_entries(os_name, trigger):
            other = shard_steps(os_name, entry, trigger)
            assert BENCHMARK_STEP not in other
            assert BENCHMARK_SKIP_STEP not in other
    # The macOS-only notice reports from the fan-in of every cell that carries no benchmark shard.
    for check in expand("owned"):
        (tmp_path / check).mkdir()
        fan_in = executed_steps("owned", check, tmp_path / check, trigger)
        assert (FAN_IN_BENCHMARK_NOTICE in fan_in) is (check != "owned (macos-14)")


@pytest.mark.parametrize(
    ("gates", "skipped_gates"),
    [
        ("check-scripts check-integration check-benchmark", ""),
        ("check-scripts check-integration check-benchmark", "check-benchmark"),
        ("check-scripts check-integration", ""),
        ("check-ts", ""),
    ],
)
def test_benchmark_run_and_skip_conditions_are_exact_complements(gates: str, skipped_gates: str) -> None:
    """Never both run and skip, and never neither, on the shard that carries the benchmark; nothing elsewhere.

    `ci_paths.shard_plans` only ever skips a gate the shard plans, so those are the reachable entries.

    Parameters:
        gates (str): The shard's planned gates.
        skipped_gates (str): The shard's plan-skipped gates.
    """
    steps = {step.get("name"): step for step in jobs()["owned-shards-macos"]["steps"]}
    context = {"matrix.gates": gates, "matrix.skipped_gates": skipped_gates, "runner.os": "macOS"}
    runs = bool(evaluate(steps[BENCHMARK_STEP]["if"], context))
    skips = bool(evaluate(steps[BENCHMARK_SKIP_STEP]["if"], context))
    assert runs != skips if "check-benchmark" in gates.split() else not (runs or skips)


def test_benchmark_report_is_uploaded_after_the_benchmark_gate_writes_it() -> None:
    """Upload the shard's coverage only after `check-benchmark`, and keep its LCOV in both artifact globs."""
    shard = [step.get("name") for step in jobs()["owned-shards-macos"]["steps"]]
    upload = shard.index("Preserve this shard's coverage reports")
    assert shard.index(BENCHMARK_STEP) < upload
    assert shard.index(BENCHMARK_SKIP_STEP) < upload
    glob = "benchmarks/comparison/coverage/**/lcov.info"
    shard_upload = next(
        step for step in jobs()["owned-shards-macos"]["steps"] if step.get("name") == shard[upload]
    )
    assert glob in shard_upload["with"]["path"].split()
    assert glob in fan_in_step("Preserve independent coverage reports and summary")["with"]["path"].split()


def test_benchmark_skip_step_prints_its_not_run_reason(tmp_path: Path) -> None:
    """Run the skip step's real script and keep the NOT RUN disclosure honest.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    step = next(
        step for step in jobs()["owned-shards-macos"]["steps"] if step.get("name") == BENCHMARK_SKIP_STEP
    )
    script = tmp_path / "skip.sh"
    script.write_text(step["run"])
    summary = tmp_path / "summary"
    result = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ | {"GITHUB_STEP_SUMMARY": str(summary)},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "::notice title=check-benchmark NOT RUN::" in result.stdout
    assert "changes no benchmark input" in result.stdout
    # One list, in `ci_paths.py`: the reason points there instead of copying it.
    assert "BENCHMARK_INPUT_FILES" in result.stdout
    assert "benchmarks/comparison" not in step["run"]
    assert "### check-benchmark: NOT RUN" in summary.read_text()
    assert "This is not a pass." in summary.read_text()


def test_every_planned_gate_has_a_step_that_survives_other_gate_failures() -> None:
    """Give each gate the plan can list its own step, so one red gate never hides another's evidence."""
    # `check-benchmark` keeps its own run/skip pair and its old condition (no `!cancelled()`), tested above.
    planned = {gate for gates in ci_paths.OWNED_GATES.values() for gate in gates} - {"check-benchmark"}
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
    # `check-ts` runs exactly the shard's workspaces, rendered into the command: the WSL adapter forwards
    # only an explicit environment allowlist.
    assert steps["check-ts"]["run"] == 'make check-ts WORKSPACES="${{ matrix.workspaces }}"'


def test_no_step_names_a_shard() -> None:
    """Keep the shard list in `ci_paths.OWNED_SHARDS`: no step reads a shard's name."""
    for job in OWNED_SHARD_JOBS.values():
        for step in jobs()[job]["steps"]:
            assert "matrix.shard" not in step.get("if", "")
            assert "matrix.shard" not in step.get("run", "")


def test_wsl_setup_does_not_upgrade_distribution_packages() -> None:
    """Keep the guest on its image's packages; `additional-packages` still refreshes apt."""
    assert "update: 'false'" in (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()


@pytest.mark.parametrize(
    ("os_name", "gates"),
    [
        ("ubuntu-24.04", {"check-ts", "check-scripts", "check-integration"}),
        ("macos-14", {"check-ts", "check-scripts", "check-integration"}),
        ("wsl2", {"check-ts", "check-probes", "check-providers", "check-import-audit"}),
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
        assert executed[entry["shard"]] == set(entry["gates"].split()) - {"check-benchmark"}
    assert set().union(*executed.values()) == gates


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
def test_a_failed_classify_fails_all_twelve_required_checks_instead_of_skipping_them(
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
        for check, cell in expand(name).items():
            job = jobs()[job_id(name, cell)]
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
        Trigger(docs_only="true", wsl_inputs="false", stack_inputs="false"),
        Trigger(wsl_inputs="false", stack_inputs="false"),
        Trigger(event="push", wsl_inputs="false"),
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
        for check, cell in expand(name).items():
            expected = cell["runner"] if published[check]["run"] else "ubuntu-24.04"
            assert runner_for(name, cell, trigger) == expected, check
    # An owned cell's work runs on its shards; the fan-in itself only reads artifacts, on Ubuntu.
    for check, cell in expand("owned").items():
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
    assert plan["owned (macos-14)"]["reason"].startswith("The squash subject")


@pytest.mark.parametrize("os_name", sorted(OWNED_FAN_IN))
def test_python_signals_skip_exactly_the_hosts_without_a_pytest_gate(os_name: str) -> None:
    """Scope each Python LCOV signal to the cells that run its producer, and no others.

    Parameters:
        os_name (str): Matrix `os` of the cell whose fan-in accounts for it.
    """
    # `ci_paths` owns each owned cell's gates and guest; the fan-in reads the guest from the shards' plan.
    accounting = fan_in_step("Coverage accounting (existing reports, including test failures)")
    context = {"matrix.os": os_name, "needs.classify.outputs.plan": classify_outputs(PULL_REQUEST)["plan"]}
    guest = ci_paths.RUNNERS[os_name][1]
    assert render(accounting["env"]["COVERAGE_HOST"], context) == guest
    assert 'COVERAGE_HOST="$COVERAGE_HOST"' in accounting["run"]
    policy = json.loads((ROOT / "coverage/policy.json").read_text())
    for name, gate in (
        ("python-scripts", "check-scripts"),
        ("python-harness", "check-integration"),
        ("python-benchmarks", "check-benchmark"),
    ):
        skipped = set(policy["packages"][name]["signals"]["primary"]["skip_hosts"])
        assert (guest in skipped) == (gate not in ci_paths.OWNED_GATES[os_name])


def pool_runs_on(name_format: str, args: str) -> str:
    """Return the `runs-on` expression of a cell that a self-hosted pool may take.

    Parameters:
        name_format (str): The check name's `format` string, e.g. `contracts ({0})`.
        args (str): The matrix arguments it formats.

    Returns:
        str: A bypass cell runs hosted; a running one on the plan's pool, else its matrix's runner.
    """
    cell = f"fromJSON(needs.classify.outputs.plan || '{{}}')[format('{name_format}', {args})]"
    return f"${{{{ !{cell}.run && 'ubuntu-24.04' || {cell}.runner || matrix.runner }}}}"


@pytest.mark.parametrize("name", ["contracts", "stack"])
def test_shared_guest_matrix(name: str) -> None:
    """Expand every supported cell and reject unsupported hosts/platforms.

    Parameters:
        name (str): Ordinary CI gate job.
    """
    job = jobs()[name]
    matrix = job["strategy"]["matrix"]
    assert matrix["os"] == list(PLATFORMS)
    assert set(matrix) == ({"os", "stack", "include"} if name == "stack" else {"os", "include"})
    platforms = STACK_PLATFORMS if name == "stack" else PLATFORMS
    for cell in expand(name).values():
        if (cell["os"], cell.get("stack")) in ci_paths.STACK_NOT_RUN:
            continue
        runner, guest, platform = platforms[cell["os"]]
        assert cell["runner"] == runner
        assert cell["guest"] == guest
        if name == "stack":
            assert cell["platform"] == platform
    assert job["needs"] == "classify"
    assert job["strategy"]["fail-fast"] is False
    steps = job["steps"]
    plan = next(step for step in steps if step.get("id") == "plan")
    assert plan["uses"] == "./.github/actions/report-plan"
    assert plan["with"]["classify_result"] == "${{ needs.classify.result }}"
    assert job["if"] == "${{ !cancelled() }}"  # A failed classify must fail the cells, never skip them.
    setup = next(i for i, step in enumerate(steps) if step.get("id") == "tools")
    assert steps[setup]["uses"] == "./.github/actions/setup-ci-tools"
    assert steps[setup]["with"]["guest"] == "${{ matrix.guest }}"
    shell_overrides = [step for step in steps[setup + 1 :] if "run" in step and "shell" in step]
    if name == "stack":
        # WSL runs no stack cell, so this job has no guest boundary to preserve.
        # A bypass cell stays hosted; a running one takes the plan's pool, else its matrix runner.
        assert job["runs-on"] == pool_runs_on("stack ({0}, {1})", "matrix.os, matrix.stack")
        assert job["defaults"]["run"]["shell"] == "bash -e {0}"
        assert "wsl" not in yaml.safe_dump(steps).lower().replace("wsl2_host", "")
        assert shell_overrides == [
            next(step for step in steps if step.get("name") == "Report coverage exclusions")
        ]
        assert shell_overrides[0]["shell"] == "bash -e {0}"
        return
    assert not shell_overrides
    assert job["runs-on"] == pool_runs_on("contracts ({0})", "matrix.os")
    assert 'format(\'bash "{0}/scripts/wsl2_host.sh"' in job["defaults"]["run"]["shell"]
    assert "pwsh" not in job["defaults"]["run"]["shell"]
    selection = steps[0]
    assert selection["if"] == "runner.os == 'Windows'"
    assert selection["shell"] == "pwsh"
    assert "'Git\\bin'" in selection["run"]
    assert (
        "Get-Command bash.exe -All -CommandType Application | Select-Object -First 1).Source"
        in selection["run"]
    )
    assert 'Write-Output "Resolved Git Bash: $resolved; expected: $bash"' in selection["run"]
    assert "$gitBin >> $env:GITHUB_PATH" in selection["run"]
    assert "--version" in selection["run"]
    assert "GITHUB_STEP_SUMMARY" in selection["run"]
    assert steps[2] is plan
    assert steps[1]["with"]["sparse-checkout"] == ".github/actions"
    assert job["defaults"]["run"]["shell"].endswith("|| 'bash -e {0}' }}")
    assert any(step.get("with", {}).get("cleanup") == "cleanup" for step in steps)
    diagnostics = [
        step for step in steps if step.get("with", {}).get("path", "").endswith("/wsl2-diagnostics/")
    ]
    assert len(diagnostics) == 1
    assert "always()" in diagnostics[0]["if"]


def test_owned_fan_ins_share_one_definition_and_wait_only_for_their_own_shards() -> None:
    """Keep three identical fan-ins, each bound to its own shard job, reporting from Ubuntu."""
    cfg = jobs()
    steps = [cfg[job]["steps"] for job in OWNED_FAN_IN.values()]
    assert steps[0] == steps[1] == steps[2]
    for os_name, job in OWNED_FAN_IN.items():
        fan_in = cfg[job]
        shards = OWNED_SHARD_JOBS[os_name]
        assert fan_in["name"] == "owned (${{ matrix.os }})"
        assert fan_in["strategy"]["matrix"] == {"os": [os_name]}
        # A failed classify or a failed shard must still produce a red required check, never a skipped one.
        assert fan_in["if"] == "${{ !cancelled() }}"
        assert fan_in["needs"] == ["classify", shards]
        assert fan_in["env"] == {"SHARDS_RESULT": f"${{{{ needs.{shards}.result }}}}"}
        assert fan_in["runs-on"] == "ubuntu-24.04"
        assert "defaults" not in fan_in


def test_owned_shard_jobs_share_one_definition_and_read_only_their_cell() -> None:
    """Keep three identical shard jobs whose `if` and matrix both read their own cell of the plan."""
    cfg = jobs()
    steps = [cfg[job]["steps"] for job in OWNED_SHARD_JOBS.values()]
    assert steps[0] == steps[1] == steps[2]
    for os_name, job in OWNED_SHARD_JOBS.items():
        shards = cfg[job]
        cell = f"['owned ({os_name})']"
        assert shards["name"] == "owned shard (${{ matrix.os }}, ${{ matrix.shard }})"
        assert shards["needs"] == "classify"
        assert shards["if"] == f"${{{{ fromJSON(needs.classify.outputs.plan || '{{}}'){cell}.run }}}}"
        assert shards["strategy"] == {
            "fail-fast": False,
            "matrix": {"include": f"${{{{ fromJSON(needs.classify.outputs.plan){cell}.shards }}}}"},
        }
        assert shards["runs-on"] == "${{ matrix.runner }}"
        assert 'format(\'bash "{0}/scripts/wsl2_host.sh"' in shards["defaults"]["run"]["shell"]
        assert shards["defaults"]["run"]["shell"].endswith("|| 'bash -e {0}' }}")


def test_owned_runners_match_the_contracts_matrix() -> None:
    """Keep the plan's shard runners and guests identical to the `contracts` matrix of the same OS."""
    assert {
        cell["os"]: (cell["runner"], cell["guest"]) for cell in expand("contracts").values()
    } == ci_paths.RUNNERS


def test_owned_shards_keep_the_guest_boundary() -> None:
    """Select Git Bash first, run the WSL capture and cleanup, and keep one diagnostics upload per shard."""
    steps = jobs()["owned-shards-wsl2"]["steps"]
    selection = steps[0]
    assert selection["if"] == "runner.os == 'Windows'"
    assert selection["shell"] == "pwsh"
    assert not [step for step in steps if "run" in step and "shell" in step and step is not selection]
    assert any(step.get("with", {}).get("cleanup") == "cleanup" for step in steps)
    diagnostics = [
        step for step in steps if step.get("with", {}).get("path", "").endswith("/wsl2-diagnostics/")
    ]
    assert len(diagnostics) == 1
    assert "always()" in diagnostics[0]["if"]
    # One artifact name per shard: two shards of one run cannot upload the same name.
    assert diagnostics[0]["with"]["name"] == "wsl2-diagnostics-owned-${{ matrix.shard }}"
    setup = next(step for step in steps if step.get("id") == "tools")
    assert setup["with"] == {"guest": "${{ matrix.guest }}", "owned": "true"}
    capture = [step for step in steps if step.get("uses") == "./.github/actions/capture-ci-wsl"]
    upload = next(step for step in steps if step.get("name") == "Preserve this shard's coverage reports")
    assert steps.index(capture[0]) < steps.index(upload) < steps.index(capture[1])


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
                "integration/probes/coverage/primary/lcov.info",
            ],
        },
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (workspace / "packages/subagents/coverage/primary/lcov.info").read_text() == (
        "coverage-ubuntu-24.04-subagents\n"
    )
    assert (workspace / "scripts/coverage/primary/lcov.info").read_text() == "coverage-ubuntu-24.04-python\n"
    assert (workspace / "integration/probes/coverage/primary/lcov.info").is_file()


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
        for step in jobs()["owned-shards-ubuntu"]["steps"]
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
    assert "summary.json" not in shard_upload["with"]["path"]
    assert shard_upload["with"]["path"] + "coverage/summary.json\n" == fan_in_upload["with"]["path"]


@pytest.mark.parametrize(
    ("os_name", "coverage_os"), [("ubuntu-24.04", "linux"), ("macos-14", "darwin"), ("wsl2", "linux")]
)
def test_fan_in_accounts_each_cell_against_its_own_os_floors(os_name: str, coverage_os: str) -> None:
    """Account the macOS reports with the darwin floors although the fan-in runs on Ubuntu.

    Parameters:
        os_name (str): Matrix `os` of the cell.
        coverage_os (str): `coverage_accounting.py --os` it must select.
    """
    step = fan_in_step("Coverage accounting (existing reports, including test failures)")
    context = {"matrix.os": os_name, "needs.classify.outputs.plan": classify_outputs(PULL_REQUEST)["plan"]}
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
        ["make", "--no-print-directory", "-n", "check-coverage", "COVERAGE_SKIPPED_GATES=check-benchmark"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert skipping.strip().endswith('--skipped-gates "check-benchmark"')


@pytest.mark.parametrize(
    ("trigger", "skipped"),
    [
        (Trigger(benchmark_inputs="false"), "check-benchmark"),
        (Trigger(benchmark_inputs="true"), ""),
        (Trigger(event="push", benchmark_inputs="false"), ""),
    ],
)
def test_fan_in_accounting_skips_exactly_the_gates_its_shards_skipped(trigger: Trigger, skipped: str) -> None:
    """Hand the fan-in's accounting the same `skipped_gates` the macOS shard's benchmark steps read.

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


@pytest.mark.parametrize("check", ["owned (ubuntu-24.04)", "owned (macos-14)", "owned (wsl2)"])
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


def test_git_bash_selection_is_one_ordered_candidate_in_every_job() -> None:
    """Avoid treating Get-Command's application collection as one resolved path."""
    cfg = jobs()
    selections = {cfg[name]["steps"][0]["run"] for name in (*OWNED_SHARD_JOBS.values(), "contracts")}
    assert len(selections) == 1
    selection = selections.pop()
    assert "Get-Command bash.exe -All -CommandType Application | Select-Object -First 1).Source" in selection
    assert "if ($resolved -ne $bash)" in selection
    assert "(Get-Command bash -CommandType Application).Source -ne $bash" not in selection


def test_all_original_cases_and_new_applicable_gates_share_the_boundary() -> None:
    """Keep exact scenario selectors and gates."""
    cfg = jobs()
    assert set(cfg) == {
        "classify",
        *OWNED_SHARD_JOBS.values(),
        *OWNED_FAN_IN.values(),
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
    assert arm["if"] == "matrix.guest != 'macos' && contains(matrix.workspaces, 'packages/computer-use')"
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
    assert stack["strategy"]["matrix"]["stack"] == ["personal", "local"]
    runs = [step for step in stack["steps"] if "pytest scenarios/" in step.get("run", "")]
    assert len(runs) == 5
    candidates = [step for step in runs if "--bun-auth-adapter" in step["run"]]
    assert len(candidates) == 2
    for step, name in zip(candidates, ("personal", "local"), strict=True):
        assert "pytest scenarios/test_auth_transport.py" in step["run"]
        assert (
            f"--stack stacks/{name}.json --runtime bun-standalone --bun-auth-adapter -m stack" in step["run"]
        )
        assert f"--junitxml=artifacts/standalone-auth-{name}.xml" in step["run"]
        assert "steps.build.outcome == 'success'" in step["if"]
        assert "matrix.os" not in step["if"]
    scenarios = [step for step in runs if step not in candidates]
    assert len(scenarios) == 3
    for step in scenarios:
        assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in step["run"]
        assert "-m stack -n 2 --dist loadfile" in step["run"]
        assert "matrix.os" not in step["if"]  # No WSL-only elision.
    assert '--stack "stacks/${{ matrix.stack }}.json"' in scenarios[0]["run"]
    assert "stacks/personal.json --runtime bun-standalone" in scenarios[1]["run"]
    assert "stacks/local.json --runtime bun-standalone" in scenarios[2]["run"]
    uploads = [step for step in stack["steps"] if "upload-artifact@" in step.get("uses", "")]
    startup = next(
        step for step in uploads if step.get("name") == "Upload scanned standalone startup failure evidence"
    )
    assert startup["if"] == (
        "${{ !cancelled() && steps.startup.outcome == 'failure' "
        "&& steps.startup.outputs.artifact_ready == 'true' }}"
    )
    assert all("always()" in step["if"] for step in uploads if step is not startup)
    assert startup["with"]["name"] == "standalone-startup-linux-x64"
    standalone = next(step for step in uploads if step["with"]["name"].startswith("standalone-${{"))
    assert standalone["with"]["name"] == "standalone-${{ matrix.platform }}-${{ matrix.stack }}"
    assert standalone["with"]["path"] == "integration/artifacts/"
    assert not (WORKFLOW.parent / "wsl2.yml").exists()
    for path in WORKFLOW.parent.glob("*.yml"):
        if path != WORKFLOW:
            assert "setup-ci-wsl" not in path.read_text()
            assert "wsl2_run.sh" not in path.read_text()


def guest_fixture(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """Prepare a Linux-shaped guest HOME with real adapter inputs.

    Parameters:
        tmp_path (Path): Disposable fixture directory.

    Returns:
        tuple[Path, dict[str, str]]: Guest checkout and adapter environment.
    """
    home = tmp_path / "guest home"
    worktree = home / "pi-harness-ci"
    ti = worktree / ".ci-temp"
    ti.mkdir(parents=True)
    (ti / "tool-path").write_text(os.environ["PATH"])
    (worktree / "integration").mkdir()
    step = tmp_path / "host step.sh"
    env = dict(os.environ) | {
        "HOME": str(home),
        "WSL_STEP_SCRIPT": str(step),
        "WSL_STEP_DIRECTORY": "integration",
        "GITHUB_OUTPUT": str(tmp_path / "output"),
        "GITHUB_ENV": str(tmp_path / "env"),
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
        "GH_TOKEN": "synthetic-sentinel",
    }
    return worktree, env


@pytest.mark.parametrize("status", [0, 47])
def test_guest_adapter_real_execution_and_status(tmp_path: Path, status: int) -> None:
    """Exercise CRLF, paths with spaces, guest cwd/temp, outputs and failure retention.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        status (int): Exit status of the ordinary gate.
    """
    worktree, env = guest_fixture(tmp_path)
    Path(env["WSL_STEP_SCRIPT"]).write_bytes(
        (
            'test "$PWD" = "$GITHUB_WORKSPACE/integration"\r\n'
            'test "$RUNNER_TEMP" = "$GITHUB_WORKSPACE/.ci-temp"\r\n'
            'echo "PI_BIN=$GITHUB_WORKSPACE/pi-release/bin/pi" >> "$GITHUB_ENV"\r\n'
            'echo "ran=true" >> "$GITHUB_OUTPUT"\r\n'
            f"exit {status}\r\n"
        ).encode()
    )
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == status
    assert Path(env["GITHUB_OUTPUT"]).read_text() == "ran=true\n"
    assert Path(env["GITHUB_ENV"]).read_text() == f"PI_BIN={worktree}/pi-release/bin/pi\n"
    assert "synthetic-sentinel" not in result.stdout + result.stderr
    failure = worktree / ".ci-temp/first-failure"
    assert failure.exists() is bool(status)
    if status:
        assert failure.read_text() == f"{status}\n"
    assert not list((worktree / ".ci-temp").glob("step.*"))


@pytest.mark.parametrize("directory", ["..", "../escape", "integration/../..", "escape-link"])
def test_guest_adapter_refuses_escaping_directory(tmp_path: Path, directory: str) -> None:
    """Fail before running a host script outside the guest checkout.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        directory (str): Logical or symlink traversal outside the guest checkout.
    """
    worktree, env = guest_fixture(tmp_path)
    (worktree / "escape-link").symlink_to(tmp_path, target_is_directory=True)
    env["WSL_STEP_DIRECTORY"] = directory
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "escapes guest checkout" in result.stderr


def stub_guest_state_commands(commands: Path, *, dmesg: bool = False, kernel: str = "") -> Path:
    """Stub the guest-state collector's kernel commands, plus a `sudo` that only records calls.

    Parameters:
        commands (Path): PATH-prepended stub directory, created when absent.
        dmesg (bool): unprivileged `dmesg` succeeds.
        kernel (str): Extra kernel-log line, e.g. a planted credential.

    Returns:
        Path: Marker file that records every attempted kernel-log read.
    """
    commands.mkdir(exist_ok=True)
    marker = commands.parent / "kernel-log-attempts"
    sudo_calls = commands.parent / "sudo-calls"
    log = f"printf '%s\\n' \"$0 $*\" >> {shlex.quote(str(marker))}\n"
    stubs = {
        # The capture must never escalate; any call is recorded and fails.
        "sudo": f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {shlex.quote(str(sudo_calls))}\nexit 90\n",
        "dmesg": (
            f"#!/bin/sh\n{log}"
            + (
                f"printf '[    2.0] unprivileged kernel line\\n{kernel}\\n'\n"
                if dmesg
                else "echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2\nexit 1\n"
            )
        ),
        # GitHub's macos-14 image has no coreutils `timeout`; the guest's bounds are not under test here.
        "timeout": '#!/bin/sh\nshift\nexec "$@"\n',
        "python3": f'#!/bin/sh\nexec {shlex.quote(sys.executable)} "$@"\n',
    }
    for name, body in stubs.items():
        (commands / name).write_text(body)
        (commands / name).chmod(0o755)
    return marker


@pytest.mark.parametrize("export_failure", [False, True])
def test_capture_retains_first_failure_and_only_explicit_reports(
    tmp_path: Path, export_failure: bool
) -> None:
    """Run real export/cleanup against successively failed/successful guest steps.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        export_failure (bool): Inject a report-copy failure before cleanup.
    """
    worktree, env = guest_fixture(tmp_path)
    ti = worktree / ".ci-temp"
    (ti / "first-failure").write_text("47\n")
    (ti / "package-contracts.json").write_text("{}\n")
    (ti / "secret.txt").write_text("must not upload")
    startup = ti / "standalone-startup-diagnostics"
    startup.mkdir()
    (startup / "SHA256SUMS").write_text("synthetic scanned manifest\n")
    for name in ("artifacts", "artifacts-node", "artifacts-personal"):
        artifacts = worktree / "integration" / name
        artifacts.mkdir()
        (artifacts / "wsl2-personal.xml").write_text("<testsuite/>\n")
    scripts = worktree / "scripts"
    scripts.mkdir()
    shutil.copyfile(ROOT / "scripts/wsl2_cleanup.sh", scripts / "wsl2_cleanup.sh")
    host = tmp_path / "host"
    host_temp = host / "temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    env |= {"WSL_HOST_WORKSPACE": str(host), "WSL_HOST_TEMP": str(host_temp), "RUNNER_TEMP": str(ti)}
    commands = tmp_path / "commands"
    commands.mkdir()
    # Model DrvFs refusing timestamp/ownership preservation by an ordinary user.
    copy_script = (
        "#!/bin/sh\nexit 92\n"
        if export_failure
        else (
            f"#!{sys.executable}\n"
            "import os\nimport sys\n"
            "if sys.argv[1] in ('-a', '-p') or sys.argv[1].startswith('--preserve'):\n"
            "    sys.exit(93)\n"
            "os.execv('/bin/cp', ['/bin/cp', *sys.argv[1:]])\n"
        )
    )
    (commands / "cp").write_text(copy_script)
    (commands / "cp").chmod(0o755)
    stub_guest_state_commands(commands)
    env["PATH"] = f"{commands}{os.pathsep}{env['PATH']}"
    (ti / "tool-path").write_text(env["PATH"])
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh"), "cleanup"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 47
    assert not worktree.exists()
    for name in ("artifacts", "artifacts-node", "artifacts-personal"):
        assert (host / "integration" / name / "wsl2-personal.xml").is_file() is not export_failure
    assert (host_temp / "package-contracts.json").is_file() is not export_failure
    assert (host_temp / "wsl2-diagnostics/artifacts/wsl2-personal.xml").is_file() is not export_failure
    assert not (host_temp / "secret.txt").exists()
    assert (host_temp / "standalone-startup-diagnostics/SHA256SUMS").is_file() is not export_failure
    assert "status 47" in (host_temp / "wsl2-diagnostics/capture-status.txt").read_text()


@pytest.mark.parametrize(
    ("case", "heading"),
    [
        ("unprivileged", "== dmesg unprivileged (last 400 lines) =="),
        ("unavailable", "UNAVAILABLE: unprivileged dmesg failed (see dmesg_restrict above)"),
        ("credential", "withheld"),
        ("no-scanner", "withheld"),
    ],
)
def test_failed_capture_exports_scanned_guest_state(tmp_path: Path, case: str, heading: str) -> None:
    """Record kernel and memory state after a guest failure (#445), only past the shared credential scan.

    Parameters:
        tmp_path (Path): Disposable guest and host directories.
        case (str): Kernel-log source, a planted credential, or a scanner that cannot run.
        heading (str): Report text proving which path ran.
    """
    worktree, env = guest_fixture(tmp_path)
    ti = worktree / ".ci-temp"
    (ti / "first-failure").write_text("47\n")
    (worktree / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/wsl2_cleanup.sh", worktree / "scripts/wsl2_cleanup.sh")
    if case != "no-scanner":
        shutil.copytree(
            ROOT / "integration/harness",
            worktree / "integration/harness",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
    credential = "ghp_" + "A" * 36
    stub_guest_state_commands(
        tmp_path / "commands",
        dmesg=case in {"unprivileged", "credential", "no-scanner"},
        kernel=credential if case == "credential" else "",
    )
    host_temp = tmp_path / "host/temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    env |= {
        "WSL_HOST_WORKSPACE": str(tmp_path / "host"),
        "WSL_HOST_TEMP": str(host_temp),
        "WSL_JOB_STATUS": "failure",
        "PATH": f"{tmp_path / 'commands'}{os.pathsep}{env['PATH']}",
    }
    (ti / "tool-path").write_text(env["PATH"])
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh"), "cleanup"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 47
    assert not worktree.exists()
    exported = (host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert heading in exported
    assert "synthetic-sentinel" not in exported + result.stdout + result.stderr
    assert credential not in exported + result.stdout + result.stderr
    assert not (tmp_path / "sudo-calls").exists()
    if heading != "withheld":
        assert exported.startswith("WSL guest state at ")
        assert exported.splitlines()[0].endswith(" (UTC): guest status 47, job status failure")
        for section in ("/proc/meminfo", "/proc/swaps", "/proc/pressure/memory", "/proc/loadavg"):
            assert f"== {section} ==" in exported
        assert "== /proc/vmstat (swap, reclaim, OOM) ==" in exported
    assert "status 47" in (host_temp / "wsl2-diagnostics/capture-status.txt").read_text()


@pytest.mark.parametrize(
    ("job_status", "collected"), [("cancelled", True), ("failure", True), ("success", False), ("", False)]
)
def test_job_status_alone_triggers_guest_state(tmp_path: Path, job_status: str, collected: bool) -> None:
    """Collect after a timeout or cancel that killed the guest step before it wrote first-failure.

    A green guest with a green job never reads the kernel log. The job status never changes the
    capture's own exit status.

    Parameters:
        tmp_path (Path): Disposable guest and host directories.
        job_status (str): The caller's `job.status`; empty when an older caller passes none.
        collected (bool): Guest state is expected.
    """
    worktree, env = guest_fixture(tmp_path)
    (worktree / "scripts").mkdir()
    shutil.copyfile(ROOT / "scripts/wsl2_cleanup.sh", worktree / "scripts/wsl2_cleanup.sh")
    shutil.copytree(
        ROOT / "integration/harness",
        worktree / "integration/harness",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    marker = stub_guest_state_commands(tmp_path / "commands", dmesg=True)
    host_temp = tmp_path / "host/temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    env |= {
        "WSL_HOST_WORKSPACE": str(tmp_path / "host"),
        "WSL_HOST_TEMP": str(host_temp),
        "WSL_JOB_STATUS": job_status,
        "PATH": f"{tmp_path / 'commands'}{os.pathsep}{env['PATH']}",
    }
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"])
    command = ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh"), "cleanup"]
    subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    assert not (worktree / ".ci-temp/first-failure").exists()
    assert marker.exists() is collected
    assert not (tmp_path / "sudo-calls").exists()
    exported = host_temp / "wsl2-diagnostics/guest-state.txt"
    assert exported.exists() is collected
    if collected:
        text = exported.read_text()
        assert text.splitlines()[0].endswith(f" (UTC): guest status 0, job status {job_status}")
        assert "== dmesg unprivileged (last 400 lines) ==" in text
    assert "status 0" in (host_temp / "wsl2-diagnostics/capture-status.txt").read_text()


def test_capture_does_not_publish_partial_startup_evidence(tmp_path: Path) -> None:
    """Refuse a partial host copy before announcing uploadable startup evidence.

    Parameters:
        tmp_path (Path): Disposable guest and host directories.
    """
    worktree, env = guest_fixture(tmp_path)
    startup = worktree / ".ci-temp/standalone-startup-diagnostics"
    startup.mkdir()
    (startup / "SHA256SUMS").write_text("synthetic manifest\n")
    host = tmp_path / "host"
    host_temp = host / "temp"
    host_temp.mkdir(parents=True)
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "cp").write_text('#!/bin/sh\nprintf partial > "$3/partial"\nexit 92\n')
    (commands / "cp").chmod(0o755)
    env |= {
        "WSL_HOST_WORKSPACE": str(host),
        "WSL_HOST_TEMP": str(host_temp),
        "PATH": f"{commands}{os.pathsep}{env['PATH']}",
    }
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"])
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert not (host_temp / "standalone-startup-diagnostics").exists()
    assert not list(host_temp.glob(".standalone-startup.*"))


def test_capture_replaces_stale_node_snapshot(tmp_path: Path) -> None:
    """Keep Node and standalone report trees distinct across guest renames.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    worktree, env = guest_fixture(tmp_path)
    host = tmp_path / "host"
    (host / "temp/wsl2-diagnostics").mkdir(parents=True)
    env |= {"WSL_HOST_WORKSPACE": str(host), "WSL_HOST_TEMP": str(host / "temp")}
    artifacts = worktree / "integration/artifacts"
    artifacts.mkdir()
    (artifacts / "node.xml").write_text("Node report")
    command = ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh")]
    subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    artifacts.rename(worktree / "integration/artifacts-node")
    artifacts.mkdir()
    (artifacts / "standalone.xml").write_text("Standalone report")
    subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    assert not (host / "integration/artifacts/node.xml").exists()
    assert (host / "integration/artifacts/standalone.xml").read_text() == "Standalone report"
    assert (host / "integration/artifacts-node/node.xml").read_text() == "Node report"


@pytest.mark.parametrize("ambiguous_path", [False, True])
def test_host_launcher_preserves_script_arguments_and_exit_status(
    tmp_path: Path, ambiguous_path: bool
) -> None:
    """Prove host forwarding with a PowerShell argv stub, not a WSL runtime claim.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        ambiguous_path (bool): Resolve a shadowing legacy Windows Bash first.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "pwsh").write_text(
        '#!/bin/sh\ncase ";${MSYS2_ENV_CONV_EXCL:-};" in *";PI_BIN;"*) ;; *) exit 93 ;; esac\n'
        'test "$PI_BIN" = /root/pi-harness-ci/pi-release/bin/pi || exit 94\n'
        'printf "%s\\n" "$@" > "$ARGV_CAPTURE"\nexit 49\n'
    )
    (commands / "cygpath").write_text(
        '#!/bin/sh\ncase "$2" in */ambiguous/bash) printf "%s" "$LEGACY_BASH" ;; '
        '*) printf "%s" "$PI_CI_GIT_BASH" ;; esac\n'
    )
    for command in commands.iterdir():
        command.chmod(0o755)
    step = tmp_path / "step with spaces.sh"
    original = b'printf "%s\\n" "unchanged guest script"\n'
    step.write_bytes(original)
    workspace = tmp_path / "host checkout"
    arguments = tmp_path / "arguments.txt"
    env = dict(os.environ) | {
        "GITHUB_WORKSPACE": str(workspace),
        "ARGV_CAPTURE": str(arguments),
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "PI_CI_GIT_BASH": r"C:\Program Files\Git\bin\bash.exe",
        "LEGACY_BASH": r"C:\Windows\System32\bash.exe",
        "PI_BIN": "/root/pi-harness-ci/pi-release/bin/pi",
    }
    if ambiguous_path:
        ambiguous = tmp_path / "ambiguous"
        ambiguous.mkdir()
        (ambiguous / "bash").write_text("#!/bin/sh\nexit 97\n")
        (ambiguous / "bash").chmod(0o755)
        env["PATH"] = f"{ambiguous}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_host.sh"), str(step)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if ambiguous_path:
        assert result.returncode == 1
        assert "Refusing ambiguous Bash" in result.stderr
        assert not arguments.exists()
        return
    assert result.returncode == 49
    assert arguments.read_text().splitlines() == [
        "-NoProfile",
        "-File",
        str(workspace / "scripts/wsl2_shell.ps1"),
        str(step),
    ]
    assert step.read_bytes() == original


def test_toolchain_pins_and_token_lifetime_follow_shared_steps() -> None:
    """Pin the new per-step credential lifetime, not the retired monolithic unset.

    Returns:
        None: Verification precedes installers and tokens exist only in fetch steps.
    """
    tools = yaml.safe_load((ROOT / ".github/actions/setup-ci-tools/action.yml").read_text())
    uv = next(step for step in tools["runs"]["steps"] if "setup-uv@" in step.get("uses", ""))
    bootstrap = (ROOT / "scripts/wsl2_setup.sh").read_text()
    assert f"uv_version={uv['with']['version']}" in bootstrap
    assert bootstrap.index("unset GH_TOKEN") < bootstrap.index("curl ")
    assert "< .node-version" in bootstrap
    assert "< .bun-version" in bootstrap
    assert 'require("./package.json").packageManager' in bootstrap
    cfg = jobs()
    for job in OWNED_FAN_IN.values():
        assert not any("GH_TOKEN" in step.get("env", {}) for step in cfg[job]["steps"])
    for name in (*OWNED_SHARD_JOBS.values(), "contracts", "stack"):
        steps = cfg[name]["steps"]
        token_steps = [step for step in steps if "GH_TOKEN" in step.get("env", {})]
        if name == "stack":
            assert [step["name"] for step in token_steps] == [
                "Verify root core overrides before install",
                "Fetch exact Gitlinked core release, formula-equivalent install",
            ]
            commands = "\n".join(step.get("run", "") for step in steps)
            assert commands.index("--verify-root-overrides") < commands.index("npm ci --ignore-scripts")
            assert commands.index("--gitlink ../forks/pi") < commands.index("pytest scenarios/")
        else:
            assert [step["name"] for step in token_steps] == ["Install"]
        assert all(step["env"]["GH_TOKEN"] == "${{ github.token }}" for step in token_steps)
    wrapper = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    assert "GH_TOKEN/u" in wrapper
    assert "Get-ChildItem Env:" not in wrapper
    capture = (ROOT / ".github/actions/capture-ci-wsl/action.yml").read_text()
    assert '--exec bash -euo pipefail "$capture" "$env:WSL_CAPTURE_MODE"' in capture
    assert "-- bash" not in capture
    for boundary in (wrapper, capture, (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()):
        assert "--exec wslpath -u" in boundary
        assert "--exec bash -euo pipefail" in boundary
        assert " -c " not in boundary
        assert "--user pi-ci --exec bash -euo pipefail" in boundary
    setup = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    assert "--user root --exec /usr/sbin/useradd --create-home --shell /bin/bash pi-ci" in setup
    guest_setup = yaml.safe_load(setup)
    distribution = next(
        step for step in guest_setup["runs"]["steps"] if "Vampire/setup-wsl@" in step.get("uses", "")
    )
    # install-action needs jq; install system prerequisites before dropping root.
    assert "jq" in distribution["with"]["additional-packages"].split()


def test_guest_preflight_failure_is_recorded(tmp_path: Path) -> None:
    """Retain missing-toolchain failure before attempting an ordinary script.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    worktree, env = guest_fixture(tmp_path)
    (worktree / ".ci-temp/tool-path").unlink()
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert (worktree / ".ci-temp/first-failure").read_text() == "1\n"


@pytest.mark.parametrize("script", ["wsl2_setup.sh", "wsl2_run.sh"])
def test_guest_refuses_root_before_copy_or_gate(tmp_path: Path, script: str) -> None:
    """Reject privileged execution rather than skipping permission-error tests.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        script (str): Guest bootstrap or ordinary execution boundary.
    """
    worktree, env = guest_fixture(tmp_path)
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "id").write_text("#!/bin/sh\nprintf '0\\n'\n")
    (commands / "id").chmod(0o755)
    env["PATH"] = f"{commands}{os.pathsep}{env['PATH']}"
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"])
    Path(env["WSL_STEP_SCRIPT"]).write_text("echo unexpected-gate\n")
    env["WSL_HOST_WORKSPACE"] = "/mnt/c/synthetic-checkout"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts" / script)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "unprivileged Linux user" in result.stderr
    assert "unexpected-gate" not in result.stdout


@pytest.mark.parametrize("filesystem", ["drvfs", ""])
def test_setup_refuses_non_linux_filesystem(tmp_path: Path, filesystem: str) -> None:
    """Execute setup's mount refusal before any download or install.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        filesystem (str): Unsupported findmnt result.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "cp").write_text("#!/bin/sh\nexit 0\n")
    (commands / "findmnt").write_text(f"#!/bin/sh\nprintf '%s' '{filesystem}'\n")
    (commands / "curl").write_text("#!/bin/sh\necho unexpected-download >&2\nexit 99\n")
    for command in commands.iterdir():
        command.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    env = dict(os.environ) | {
        "HOME": str(home),
        "WSL_HOST_WORKSPACE": "/mnt/c/synthetic-checkout",
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
    }
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_setup.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "not on a Linux filesystem" in result.stderr
    assert "unexpected-download" not in result.stderr


def test_docs_list_every_benchmark_input() -> None:
    """Pin the `benchmark_inputs` bullet in `docs/ci.md` to the classifier's constants."""
    bullet = next(
        line
        for line in (ROOT / "docs/ci.md").read_text().splitlines()
        if line.startswith("- `benchmark_inputs`")
    )
    for entry in sorted(ci_paths.BENCHMARK_INPUT_FILES) + list(ci_paths.BENCHMARK_INPUT_PREFIXES):
        assert f"`{entry}`" in bullet


SETUP_CI_TOOLS = "./.github/actions/setup-ci-tools"
# A command that starts a shell line, never one inside a comment or an echoed string.
NPM_INSTALL_COMMAND = re.compile(r"^\s*(?:npm ci|make install-owned)\b", re.MULTILINE)


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
    gate = "inputs.guest != 'wsl2' && inputs.npm-cache == 'true'"
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


def lexical_path(path: str) -> Path:
    """Normalize a workflow path lexically without resolving symlinks or accessing the filesystem."""
    source = Path(path)
    parts: list[str] = []
    for part in source.parts:
        if part == source.anchor:
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
        elif part != ".." or not source.anchor:
            parts.append(part)
    return Path(source.anchor, *parts)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("./a//b/../package-lock.json", "a/package-lock.json"),
        ("a/../../package-lock.json", "../package-lock.json"),
        ("/../../a/../package-lock.json", "/package-lock.json"),
        ("//a/../package-lock.json", "//package-lock.json"),
        ("a/..", "."),
    ],
)
def test_lexical_path(value: str, expected: str) -> None:
    """Normalize dot segments without following filesystem links."""
    assert lexical_path(value) == Path(expected)


def installed_lockfiles(job: dict[str, Any]) -> set[Path]:
    """Return the lockfile each `npm ci` step of a job installs, from its working directory.

    Parameters:
        job (dict[str, Any]): One workflow job.

    Returns:
        set[Path]: Lexically normalized `package-lock.json` paths.
    """
    default = job.get("defaults", {}).get("run", {}).get("working-directory", ".")
    return {
        lexical_path(f"{step.get('working-directory', default)}/package-lock.json")
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
            lockfile = lexical_path(options.get("cache-dependency-path", "package-lock.json"))
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
