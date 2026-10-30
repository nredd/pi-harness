"""Pin the CI matrix and exercise the guest adapter without pretending to run WSL.

References:
    https://docs.github.com/actions/using-jobs/using-a-matrix-for-your-jobs
    https://learn.microsoft.com/windows/wsl/filesystems
"""

from __future__ import annotations

import itertools
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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
PLAN_ONLY = {"Report execution plan"}
PERSONAL_STEPS = {
    "Replay source-selected installer runtime locks without lifecycle scripts",
    "Strict standalone startup with failure-only diagnostics",
    "Standalone D and E (personal)",
    "Candidate compiled-core auth adapter (personal)",
}
LOCAL_STEPS = {"Standalone D and E (local)", "Candidate compiled-core auth adapter (local)"}
BUILD_AND_NODE = {"Assembled D and E boundaries (explicit stack, no machine config)", "Build standalone"}


@dataclass(frozen=True)
class Trigger:
    """One workflow trigger and the `classify` outputs it produced.

    Parameters:
        event (str): Triggering event.
        docs_only (str): `classify` output.
        wsl_inputs (str): `classify` output, empty modelling a missing output.
        stack_inputs (str): `classify` output.
    """

    event: str = "pull_request"
    docs_only: str = "false"
    wsl_inputs: str = "true"
    stack_inputs: str = "true"


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


def expand(name: str) -> dict[str, dict[str, str]]:
    """Expand a job matrix with GitHub's `include` rules, keyed by the check name it reports.

    Parameters:
        name (str): Workflow job name.

    Returns:
        dict[str, dict[str, str]]: Each reported check name and its cell values.
    """
    job = jobs()[name]
    matrix = job["strategy"]["matrix"]
    axes = {key: value for key, value in matrix.items() if key != "include"}
    cells: dict[str, dict[str, str]] = {}
    for values in itertools.product(*axes.values()):
        cell = dict(zip(axes, values, strict=True))
        for record in matrix["include"]:
            # An include applies unless it would overwrite an original axis value.
            if all(cell.get(key) == value for key, value in record.items() if key in axes):
                cell |= record
        cells[
            job["name"]
            .replace("${{ matrix.os }}", cell["os"])
            .replace("${{ matrix.stack }}", cell.get("stack", ""))
        ] = cell
    return cells


def evaluate(expression: str, context: dict[str, str]) -> Any:
    """Evaluate the GitHub expression subset `ci.yml` uses with its real operators.

    Parameters:
        expression (str): `if`, `runs-on` or scalar expression, with or without `${{ }}`.
        context (dict[str, str]): Dotted context values; a missing property is an empty string.

    Returns:
        Any: The expression's value, keeping GitHub's operand-returning `&&` and `||`.
    """
    body = expression.strip().removeprefix("${{").removesuffix("}}")
    body = body.replace("!cancelled()", "True").replace("always()", "True")
    body = re.sub(r"(?<!['\w])[a-z]+(?:\.[a-z_]+)+", lambda match: repr(context.get(match[0], "")), body)
    return eval(body.replace("&&", " and ").replace("||", " or "), {"__builtins__": {}})


def runner_for(name: str, cell: dict[str, str], event: str, wsl_inputs: str) -> str:
    """Return the runner one cell really selects.

    Parameters:
        name (str): Workflow job name.
        cell (dict[str, str]): Expanded matrix cell.
        event (str): Triggering event.
        wsl_inputs (str): `classify` output.

    Returns:
        str: Selected runner label.
    """
    context = {f"matrix.{key}": value for key, value in cell.items()}
    context |= {"github.event_name": event, "needs.classify.outputs.wsl_inputs": wsl_inputs}
    return evaluate(jobs()[name]["runs-on"], context)


def run_plan(
    name: str, check: str, tmp_path: Path, trigger: Trigger = PULL_REQUEST
) -> tuple[dict[str, str], str, str]:
    """Execute a cell's real `plan` step on the runner that cell selects.

    Parameters:
        name (str): Workflow job name.
        check (str): Required check name selecting the cell.
        tmp_path (Path): Disposable output directory.
        trigger (Trigger): Event and `classify` outputs.

    Returns:
        tuple[dict[str, str], str, str]: Step outputs, stdout and the step summary.
    """
    cell = expand(name)[check]
    step = next(step for step in jobs()[name]["steps"] if step.get("id") == "plan")
    body = re.sub(r"\$\{\{ matrix\.(\w+) \}\}", lambda match: cell.get(match[1], ""), step["run"])
    script = tmp_path / "plan.sh"
    script.write_text(body)
    output = tmp_path / "output"
    summary = tmp_path / "summary"
    output.write_text("")
    summary.write_text("")
    values = {
        "needs.classify.outputs.docs_only": trigger.docs_only,
        "needs.classify.outputs.stack_inputs": trigger.stack_inputs,
        "needs.classify.outputs.changed_files": "a.txt",
    }
    values |= {f"matrix.{key}": value for key, value in cell.items()}
    env = {key: evaluate(value, values) for key, value in step["env"].items()}
    result = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ
        | env
        | {
            "GITHUB_EVENT_NAME": trigger.event,
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(summary),
            "RUNNER_OS": RUNNER_OS[runner_for(name, cell, trigger.event, trigger.wsl_inputs)],
        },
        capture_output=True,
        text=True,
        check=True,
    )
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return outputs, result.stdout, summary.read_text()


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
        "github.event_name": trigger.event,
        "runner.os": RUNNER_OS[runner_for(name, cell, trigger.event, trigger.wsl_inputs)],
    }
    executed: set[str] = set()
    for step in jobs()[name]["steps"]:
        if "if" in step and not evaluate(step["if"], context):
            continue
        executed.add(step.get("name") or step["uses"])
        if "id" in step:
            context[f"steps.{step['id']}.outcome"] = "success"
    return executed


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
    assert runner_for("stack", cell, "pull_request", "true") == runner
    assert bool(cell.get("not_run")) is stack_cell_not_run


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
    assert "::notice title=stack cell NOT RUN::" in stdout
    assert "### stack: NOT RUN" in summary
    assert "not a pass" in summary
    assert expand("stack")[check]["not_run"] in summary
    assert executed_steps("stack", check, tmp_path, trigger) == PLAN_ONLY


@pytest.mark.parametrize("name", ["owned", "contracts"])
@pytest.mark.parametrize(
    ("trigger", "runner", "runs"),
    [
        (Trigger(wsl_inputs="false"), "ubuntu-24.04", False),
        (Trigger(wsl_inputs="false", docs_only="true"), "ubuntu-24.04", False),
        (Trigger(wsl_inputs="true"), "windows-2025", True),
        (Trigger(wsl_inputs=""), "windows-2025", True),
        (Trigger(event="push", wsl_inputs="false"), "windows-2025", True),
        (Trigger(event="push", wsl_inputs="false", docs_only="true"), "windows-2025", True),
    ],
)
def test_wsl_cells_run_on_main_and_for_wsl_inputs(
    tmp_path: Path, name: str, trigger: Trigger, runner: str, runs: bool
) -> None:
    """Hold Windows slots only for `main` and PRs touching WSL inputs, failing closed.

    Parameters:
        tmp_path (Path): Disposable output directory.
        name (str): Ordinary CI gate job.
        trigger (Trigger): Event and `classify` outputs.
        runner (str): Expected runner.
        runs (bool): Whether the cell does real work.
    """
    check = f"{name} (wsl2)"
    assert runner_for(name, expand(name)[check], trigger.event, trigger.wsl_inputs) == runner
    outputs, stdout, summary = run_plan(name, check, tmp_path, trigger)
    assert outputs["run"] == str(runs).lower()
    steps = executed_steps(name, check, tmp_path, trigger)
    assert ("Select and verify Git Bash on the Windows host" in steps) is runs
    if runs:
        assert "NOT RUN" not in stdout + summary
        assert "./.github/actions/setup-ci-tools" in steps
        return
    assert steps == PLAN_ONLY
    assert f"::notice title={name} (wsl2) NOT RUN::" in stdout
    assert f"### {name} (wsl2): NOT RUN" in summary
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
    assert runner_for(name, expand(name)[check], "pull_request", "false") == PLATFORMS[os_name][0]
    outputs, stdout, _ = run_plan(name, check, tmp_path, Trigger(wsl_inputs="false"))
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
    assert "docs-only CI bypass" in stdout
    assert executed_steps("stack", check, tmp_path, trigger) == PLAN_ONLY


def test_personal_cell_keeps_setup_but_skips_personal_work_without_stack_inputs(tmp_path: Path) -> None:
    """Gate the personal steps, never the whole cell, on a PR with no stack inputs.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    check = "stack (ubuntu-24.04, personal)"
    trigger = Trigger(stack_inputs="false")
    outputs, stdout, summary = run_plan("stack", check, tmp_path, trigger)
    assert outputs == {"run": "true", "scenarios": "false"}
    assert "::notice title=personal stack NOT RUN::" in stdout
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
    assert "main CI smoke" in stdout


def test_standalone_uploads_cannot_collide_between_stack_cells() -> None:
    """Both Ubuntu cells now build, so the artifact name must include the stack."""
    steps = jobs()["stack"]["steps"]
    upload = next(step for step in steps if step.get("with", {}).get("name", "").startswith("standalone-${{"))
    running = [cell for cell in expand("stack").values() if not cell.get("not_run")]
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
    assert "wsl-inputs=true stack-inputs=false" in result.stdout
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
    for name in ("owned", "contracts"):
        install = next(step for step in cfg[name]["steps"] if step.get("name") == "Install")
        assert install["run"] == "make install-owned"
    gate = next(step for step in cfg["owned"]["steps"] if step.get("name") == "Benchmark unit gate")
    assert "runner.os == 'macOS'" in gate["if"]
    assert gate["run"].index("make install-benchmark") < gate["run"].index("make check-benchmark")


def test_wsl_guest_gates_skip_duplicate_pytest_and_keep_lcov_producers() -> None:
    """Keep every LCOV producer in the guest and drop only the Python unit suites."""
    gates = {cell["os"]: cell["gates"] for cell in expand("owned").values()}
    native = "check-ts check-scripts check-integration"
    assert gates == {
        "ubuntu-24.04": native,
        "macos-14": native,
        "wsl2": "check-ts check-probes check-import-audit",
    }
    owned = jobs()["owned"]["steps"]
    assert any(step.get("run") == "make ${{ matrix.gates }}" for step in owned)
    setup = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    assert "update: 'false'" in setup


@pytest.mark.parametrize("name", ["owned", "contracts", "stack"])
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
        if cell.get("not_run"):
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
    assert plan["shell"] == "bash -e {0}"
    setup = next(i for i, step in enumerate(steps) if step.get("id") == "tools")
    assert steps[setup]["uses"] == "./.github/actions/setup-ci-tools"
    assert steps[setup]["with"]["guest"] == "${{ matrix.guest }}"
    shell_overrides = [step for step in steps[setup + 1 :] if "run" in step and "shell" in step]
    if name == "stack":
        # WSL runs no stack cell, so this job has no guest boundary to preserve.
        assert job["runs-on"] == "${{ matrix.runner }}"
        assert job["defaults"]["run"]["shell"] == "bash -e {0}"
        assert "wsl" not in yaml.safe_dump(steps).lower().replace("wsl2_host", "")
        assert shell_overrides == [
            next(step for step in steps if step.get("name") == "Report coverage exclusions")
        ]
        assert shell_overrides[0]["shell"] == "bash -e {0}"
        return
    assert not shell_overrides
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
    assert steps[1] is plan
    assert job["defaults"]["run"]["shell"].endswith("|| 'bash -e {0}' }}")
    assert "!= wsl2" in plan["run"]  # A real WSL cell on `main` keeps its docs-only acceptance.
    assert any(step.get("with", {}).get("cleanup") == "cleanup" for step in steps)
    diagnostics = [
        step for step in steps if step.get("with", {}).get("path", "").endswith("/wsl2-diagnostics/")
    ]
    assert len(diagnostics) == 1
    assert "always()" in diagnostics[0]["if"]


def test_git_bash_selection_is_one_ordered_candidate_in_every_job() -> None:
    """Avoid treating Get-Command's application collection as one resolved path."""
    cfg = jobs()
    selections = {cfg[name]["steps"][0]["run"] for name in ("owned", "contracts")}
    assert len(selections) == 1
    selection = selections.pop()
    assert "Get-Command bash.exe -All -CommandType Application | Select-Object -First 1).Source" in selection
    assert "if ($resolved -ne $bash)" in selection
    assert "(Get-Command bash -CommandType Application).Source -ne $bash" not in selection


def test_all_original_cases_and_new_applicable_gates_share_the_boundary() -> None:
    """Keep exact scenario selectors and gates."""
    cfg = jobs()
    assert set(cfg) == {"classify", "owned", "contracts", "stack"}
    owned = cfg["owned"]["steps"]
    arm = next(step for step in owned if step.get("name") == "Add the aarch64 Linux compile target")
    assert "matrix.guest != 'macos'" in arm["if"]
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
    for name in ("owned", "contracts", "stack"):
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
