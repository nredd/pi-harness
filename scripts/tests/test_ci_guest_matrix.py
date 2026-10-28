"""Pin the CI matrix and exercise the guest adapter without pretending to run WSL.

References:
    https://docs.github.com/actions/using-jobs/using-a-matrix-for-your-jobs
    https://learn.microsoft.com/windows/wsl/filesystems
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
PLATFORMS = {
    "ubuntu-24.04": ("ubuntu-24.04", "linux", "linux-x64"),
    "macos-14": ("macos-14", "macos", "darwin-arm64"),
    "wsl2": ("windows-2022", "wsl2", "linux-x64"),
}


def jobs() -> dict[str, Any]:
    """Return parsed CI jobs, retaining GitHub expressions as strings.

    Returns:
        dict[str, Any]: YAML job records.
    """
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]


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
    assert len(matrix["include"]) == len(PLATFORMS)
    for record in matrix["include"]:
        runner, guest, platform = PLATFORMS[record["os"]]
        assert record["runner"] == runner
        assert record["guest"] == guest
        if name == "stack":
            assert record["platform"] == platform
    assert job["runs-on"] == "${{ matrix.runner }}"
    assert "wsl2_shell.ps1" in job["defaults"]["run"]["shell"]
    assert job["needs"] == "classify"
    assert job["strategy"]["fail-fast"] is False
    steps = job["steps"]
    assert steps[0]["id"] == "plan"
    assert steps[0]["shell"] == "bash"  # Guest is not initialized before checkout.
    setup = next(i for i, step in enumerate(steps) if step.get("id") == "tools")
    assert steps[setup]["uses"] == "./.github/actions/setup-ci-tools"
    assert steps[setup]["with"]["guest"] == "${{ matrix.guest }}"
    assert all("shell" not in step for step in steps[setup + 1 :] if "run" in step)
    assert "!= wsl2" in steps[0]["run"]  # Retain old always-run WSL acceptance.
    assert any(step.get("with", {}).get("cleanup") == "cleanup" for step in steps)
    diagnostics = [
        step for step in steps if step.get("with", {}).get("path", "").endswith("/wsl2-diagnostics/")
    ]
    assert len(diagnostics) == 1
    assert "always()" in diagnostics[0]["if"]


def test_all_original_cases_and_new_applicable_gates_share_the_boundary() -> None:
    """Keep exact scenario selectors and gates, with no WSL-only reduced suite."""
    cfg = jobs()
    assert set(cfg) == {"classify", "owned", "contracts", "stack", "bench"}
    owned = cfg["owned"]["steps"]
    assert any(step.get("run") == "make check-ts check-scripts check-integration" for step in owned)
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
    scenarios = [step for step in stack["steps"] if "pytest scenarios/" in step.get("run", "")]
    assert len(scenarios) == 3
    for step in scenarios:
        assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in step["run"]
        assert "-m stack -n 2 --dist loadfile" in step["run"]
        assert "matrix.os" not in step["if"]  # No WSL-only elision.
    assert '--stack "stacks/${{ matrix.stack }}.json"' in scenarios[0]["run"]
    assert "stacks/personal.json --runtime bun-standalone" in scenarios[1]["run"]
    assert "stacks/local.json --runtime bun-standalone" in scenarios[2]["run"]
    uploads = [step for step in stack["steps"] if "upload-artifact@" in step.get("uses", "")]
    assert all("always()" in step["if"] for step in uploads)
    standalone = next(step for step in uploads if step["with"]["name"].startswith("standalone-"))
    assert "${{ matrix.os }}" in standalone["with"]["name"]
    assert "integration/artifacts-node/" in standalone["with"]["path"]
    assert "integration/artifacts-personal/" in standalone["with"]["path"]
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


def test_guest_adapter_refuses_escaping_directory(tmp_path: Path) -> None:
    """Fail before running a host script outside the guest checkout.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    _, env = guest_fixture(tmp_path)
    env["WSL_STEP_DIRECTORY"] = "../escape"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "escapes guest checkout" in result.stderr


def test_capture_retains_first_failure_and_only_explicit_reports(tmp_path: Path) -> None:
    """Run real export/cleanup against successively failed/successful guest steps.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    worktree, env = guest_fixture(tmp_path)
    ti = worktree / ".ci-temp"
    (ti / "first-failure").write_text("47\n")
    (ti / "package-contracts.json").write_text("{}\n")
    (ti / "secret.txt").write_text("must not upload")
    artifacts = worktree / "integration/artifacts"
    artifacts.mkdir()
    (artifacts / "wsl2-personal.xml").write_text("<testsuite/>\n")
    scripts = worktree / "scripts"
    scripts.mkdir()
    shutil.copyfile(ROOT / "scripts/wsl2_cleanup.sh", scripts / "wsl2_cleanup.sh")
    host = tmp_path / "host"
    host_temp = host / "temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    env |= {"WSL_HOST_WORKSPACE": str(host), "WSL_HOST_TEMP": str(host_temp), "RUNNER_TEMP": str(ti)}
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh"), "cleanup"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 47
    assert not worktree.exists()
    assert (host / "integration/artifacts/wsl2-personal.xml").is_file()
    assert (host_temp / "package-contracts.json").is_file()
    assert not (host_temp / "secret.txt").exists()
    assert "status 47" in (host_temp / "wsl2-diagnostics/capture-status.txt").read_text()
