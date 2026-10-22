"""Lock down the native WSL2 workflow's platform and harness boundaries.

References:
    https://learn.microsoft.com/windows/wsl/basic-commands
    https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "wsl2.yml"
CLEANUP = WORKFLOW.parents[2] / "scripts" / "wsl2_cleanup.sh"


def workflow_text() -> str:
    """Return the native WSL2 workflow text.

    Returns:
        str: UTF-8 workflow contents.
    """
    return WORKFLOW.read_text(encoding="utf-8")


def test_wsl2_workflow_runs_for_pull_requests_and_main() -> None:
    """Keep the stable WSL2 check present on every review and merged tree."""
    workflow = workflow_text()
    assert "  pull_request:" in workflow
    assert "    branches: [main]" in workflow
    assert "name: wsl2 (windows-2022)" in workflow
    assert "runs-on: windows-2022" in workflow
    assert "timeout-minutes: 45" in workflow
    assert "contents: read" in workflow
    assert "additional-packages: curl git libatomic1 tmux unzip xz-utils" in workflow


def test_wsl2_workflow_fails_closed_on_platform_or_mount_mismatch() -> None:
    """Require explicit WSL2 proof and Linux-filesystem execution."""
    workflow = workflow_text()
    assert "wsl-version: '2'" in workflow
    assert "wsl --list --verbose" in workflow
    assert "$listing = $listing -replace ([char]0), ''" in workflow
    assert "Ubuntu-24\\.04" in workflow
    assert "Record Windows checkout path for WSL" in workflow
    assert "wsl2-source-checkout.txt" in workflow
    assert 'source_checkout=$(wslpath -u "$(tr -d \'\\r\\n\' < "$wsl_source_file")")' in workflow
    assert "Expected the Windows checkout below /mnt" in workflow
    assert "Harness worktree must be on the WSL Linux filesystem" in workflow
    assert "findmnt --noheadings --output FSTYPE" in workflow
    assert "drvfs|''" in workflow


def run_cleanup(
    tmp_path: Path,
    status: int,
    command_dir: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """Run the workflow's real cleanup trap against a disposable harness worktree.

    Parameters:
        tmp_path: Root for the disposable worktree and diagnostics directory.
        status: Harness exit status to preserve through the cleanup trap.
        command_dir: Optional directory of failing command fixtures prepended to `PATH`.

    Returns:
        tuple[CompletedProcess[str], Path, Path]: Shell outcome, worktree, and diagnostics paths.
    """
    worktree = tmp_path / "worktree"
    artifacts = worktree / "integration" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "wsl2-personal.xml").write_text("<testsuite/>\n", encoding="utf-8")
    diagnostics = tmp_path / "wsl2-diagnostics"
    diagnostics.mkdir()
    script = "\n".join(
        [
            "set -euo pipefail",
            f"source {shlex.quote(str(CLEANUP))}",
            f"worktree={shlex.quote(str(worktree))}",
            f"diagnostics_dir={shlex.quote(str(diagnostics))}",
            "trap cleanup_wsl2_worktree EXIT",
            f"exit {status}",
        ]
    )
    env = dict(os.environ)
    if command_dir is not None:
        env["PATH"] = f"{command_dir}{os.pathsep}{env['PATH']}"
    completed = subprocess.run(
        ["/bin/bash", "-c", script], capture_output=True, check=False, env=env, text=True
    )
    return completed, worktree, diagnostics


def write_failing_command(directory: Path, name: str) -> None:
    """Create a `PATH` fixture that causes one cleanup command to fail.

    Parameters:
        directory: Fixture command directory.
        name: Command name intercepted by the fixture.

    Returns:
        None: The executable fixture is created.
    """
    command = directory / name
    command.write_text("#!/bin/sh\nexit 92\n", encoding="utf-8")
    command.chmod(0o755)


def test_wsl2_cleanup_preserves_failure_artifacts_before_deleting_worktree(tmp_path: Path) -> None:
    """Copy bounded artifacts before removing a failed harness worktree."""
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47)
    assert completed.returncode == 47
    assert not worktree.exists()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").read_text(encoding="utf-8") == "<testsuite/>\n"
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"


def test_wsl2_cleanup_preserves_success_status_and_artifacts(tmp_path: Path) -> None:
    """Keep normal cleanup successful after retaining the bounded diagnostics."""
    completed, worktree, diagnostics = run_cleanup(tmp_path, 0)
    assert completed.returncode == 0
    assert not worktree.exists()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").is_file()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 0.\n"


def test_wsl2_cleanup_retains_harness_failure_when_copying_artifacts_fails(tmp_path: Path) -> None:
    """Do not replace the harness failure when diagnostic preservation fails."""
    commands = tmp_path / "commands"
    commands.mkdir()
    write_failing_command(commands, "cp")
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47, commands)
    assert completed.returncode == 47
    assert "WARNING: could not preserve WSL failure artifacts" in completed.stderr
    assert not worktree.exists()
    assert not (diagnostics / "artifacts" / "wsl2-personal.xml").exists()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"


def test_wsl2_cleanup_retains_harness_failure_when_worktree_removal_fails(tmp_path: Path) -> None:
    """Do not replace the harness failure when disposable-worktree removal fails."""
    commands = tmp_path / "commands"
    commands.mkdir()
    write_failing_command(commands, "rm")
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47, commands)
    assert completed.returncode == 47
    assert "WARNING: could not remove disposable WSL worktree" in completed.stderr
    assert worktree.is_dir()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").is_file()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"
    shutil.rmtree(worktree)


def test_wsl2_workflow_preserves_and_uploads_bounded_diagnostics() -> None:
    """Keep the executable cleanup and bounded upload attached to the native job."""
    workflow = workflow_text()
    assert "Prepare WSL diagnostics directory" in workflow
    assert "wsl2-diagnostics" in workflow
    assert 'diagnostics_dir="$(dirname "$wsl_source_file")/wsl2-diagnostics"' in workflow
    assert 'source "$source_checkout/scripts/wsl2_cleanup.sh"' in workflow
    assert "trap cleanup_wsl2_worktree EXIT" in workflow
    assert "name: wsl2-diagnostics" in workflow
    assert "if: always()" in workflow
    assert "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" in workflow
    assert "path: ${{ runner.temp }}/wsl2-diagnostics/" in workflow
    assert "if-no-files-found: warn" in workflow
    assert "PI_BIN" in workflow
    assert "Core Gitlink:" in workflow


def test_wsl2_workflow_reuses_the_release_and_stack_entrypoints() -> None:
    """Require actual Pi startup, RPC, extension, and stack process coverage."""
    workflow = workflow_text()
    assert "git submodule update --init forks/pi" in workflow
    assert 'test "$(bun --version)" = "$bun_version"' in workflow
    assert "bun-v$bun_version" in workflow
    assert "uv_version=0.13.1" in workflow
    assert '"uv $uv_version"*' in workflow
    assert "uv run --locked python -m harness.release" in workflow
    assert "--gitlink ../forks/pi" in workflow
    assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in workflow
    assert "--stack stacks/personal.json -m stack -n 2 --dist loadfile" in workflow
