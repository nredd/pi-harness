"""Compare the owned fan-in CLI with its original Bash step.

References:
- https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_require_shards

SCRIPT = Path(ci_require_shards.__file__).resolve()
# Original `Require every planned shard to succeed` run block from ci.yml.
BASH_ORACLE = [
    "/bin/bash",
    "-e",
    str(Path(__file__).resolve().parent / "fixtures/require-owned-shards.bash.txt"),
]


def execute(cmd: list[str], env: dict[str, str]) -> tuple[int, bytes, bytes]:
    """Run a guard with no inherited runner state and capture its observable result.

    Parameters:
        cmd (list[str]): Absolute interpreter path and script arguments.
        env (dict[str, str]): Synthetic runner inputs.

    Returns:
        tuple[int, bytes, bytes]: Exit status, stdout (including annotations), and stderr.
    """
    # Preserve pytest-cov's subprocess environment, not the host's runner inputs.
    inherited = {key: value for key, value in os.environ.items() if key.startswith("COVERAGE_")}
    completed = subprocess.run(cmd, env=inherited | env, capture_output=True, check=False, timeout=10)
    return completed.returncode, completed.stdout, completed.stderr


@pytest.mark.parametrize("shards_result", ["success", "failure", "cancelled", "skipped", ""])
@pytest.mark.parametrize("windows_result", ["success", "failure", "cancelled", "skipped", ""])
@pytest.mark.parametrize("windows_required", ["true", "false"])
def test_bash_parity(shards_result: str, windows_result: str, windows_required: str) -> None:
    """Keep the exact status and streams, including shard refusal taking precedence."""
    env = {
        "CELL": "owned (ubuntu-24.04)",
        "SHARDS_RESULT": shards_result,
        "WINDOWS_REQUIRED": windows_required,
        "WINDOWS_RESULT": windows_result,
    }
    assert execute([sys.executable, str(SCRIPT)], env) == execute(BASH_ORACLE, env)


def test_macos_does_not_need_a_windows_result() -> None:
    """Accept the shared step's macOS inputs, which omit `WINDOWS_RESULT`."""
    env = {"CELL": "owned (macos-14)", "SHARDS_RESULT": "success", "WINDOWS_REQUIRED": "false"}
    assert execute([sys.executable, str(SCRIPT)], env) == execute(BASH_ORACLE, env)


@pytest.mark.parametrize("windows_required", [None, "", "TRUE"])
def test_refuse_missing_or_malformed_windows_requirement(windows_required: str | None) -> None:
    """A missing or malformed requirement can no longer waive a Windows failure."""
    env = {"CELL": "owned (ubuntu-24.04)", "SHARDS_RESULT": "success", "WINDOWS_RESULT": "failure"}
    if windows_required is not None:
        env["WINDOWS_REQUIRED"] = windows_required
    assert execute(BASH_ORACLE, env)[0] == 0
    assert execute([sys.executable, str(SCRIPT)], env) == (
        1,
        b"::error title=owned (ubuntu-24.04) invalid plan::WINDOWS_REQUIRED must be true or false\n",
        b"",
    )
