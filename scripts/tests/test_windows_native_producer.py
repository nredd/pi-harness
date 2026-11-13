"""Native Windows producer wiring and executable required-check refusal controls.

References:
    https://github.com/nredd/pi-harness/issues/696
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow_jobs() -> dict[str, Any]:
    """Read the submitted workflow, not a copied shell implementation.

    Returns:
        dict[str, Any]: CI job definitions.
    """
    return yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]


def test_windows_producer_uses_native_x64_and_preserves_reports() -> None:
    """Keep the native compiler/test producer independent of WSL pool routing."""
    jobs = workflow_jobs()
    producer = jobs["computer-use-windows"]
    assert producer["runs-on"] == "windows-2025"
    assert producer["needs"] == "classify"
    assert "packages/computer-use" in producer["if"]
    assert producer["env"]["RUSTUP_TOOLCHAIN"] == "1.97.1"
    steps = producer["steps"]
    commands = "\n".join(step.get("run", "") for step in steps)
    assert "host: x86_64-pc-windows-msvc" in commands
    assert "--version 0.9.1 --locked" in commands
    assert "cargo check --locked --all-targets" in commands
    assert "cargo clippy --locked --all-targets" in commands
    assert "rust-coverage.mjs --crate windows --output" in commands
    assert "test/windows-build-scripts.test.mjs" in commands
    assert not any(step.get("continue-on-error") for step in steps)
    upload = next(
        step for step in steps if step.get("name") == "Preserve Windows source-bound native reports"
    )
    assert upload["if"] == "always()"
    assert upload["with"]["if-no-files-found"] == "error"
    for report in ("lcov.info", "coverage.json", "metadata.json", "summary.txt", "*.log"):
        assert report in upload["with"]["path"]
    assert "computer-use-windows" in jobs["owned-ubuntu"]["needs"]


@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
@pytest.mark.parametrize("required", ["true", "false"])
def test_required_check_rejects_failed_or_missing_native_producer(
    tmp_path: Path, result: str, required: str
) -> None:
    """Execute the submitted fan-in against every terminal or missing native result.

    Parameters:
        tmp_path (Path): Disposable script directory.
        result (str): Native producer outcome.
        required (str): Whether the classified cell requires computer-use.
    """
    steps = workflow_jobs()["owned-ubuntu"]["steps"]
    step = next(step for step in steps if step.get("name") == "Require every planned shard to succeed")
    script = tmp_path / "require.sh"
    script.write_text(step["run"])
    completed = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        env=os.environ
        | {
            "SHARDS_RESULT": "success",
            "CELL": "owned (ubuntu-24.04)",
            "WINDOWS_REQUIRED": required,
            "WINDOWS_RESULT": result,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    passes = required == "false" or result == "success"
    assert (completed.returncode == 0) is passes, completed.stdout + completed.stderr
    if not passes:
        assert (
            "Native Windows x64 compiler, tests, reports and build scripts must succeed" in completed.stdout
        )
