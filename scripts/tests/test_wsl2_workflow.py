"""Lock down the native WSL2 workflow's platform and harness boundaries.

References:
    https://learn.microsoft.com/windows/wsl/basic-commands
    https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
"""

from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "wsl2.yml"


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


def test_wsl2_workflow_preserves_and_uploads_bounded_diagnostics() -> None:
    """Keep JUnit, synthetic failure artifacts, and explicit identities after cleanup."""
    workflow = workflow_text()
    assert "Prepare WSL diagnostics directory" in workflow
    assert "wsl2-diagnostics" in workflow
    assert 'diagnostics_dir="$(dirname "$wsl_source_file")/wsl2-diagnostics"' in workflow
    assert 'cp -a "$worktree/integration/artifacts/." "$diagnostics_dir/artifacts/"' in workflow
    assert 'rm -rf "$worktree" || printf' in workflow
    assert 'return "$status"' in workflow
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
