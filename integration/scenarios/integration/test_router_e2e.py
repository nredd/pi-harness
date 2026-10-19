"""Pass through to the router repo's own faux e2e, against the pi under test."""

from __future__ import annotations

import os
import shlex
import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.paths import pi_command
from harness.pinned import pinned_checkout
from harness.sandbox import local_overrides_from_env

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.integration


def pi_shim(directory: Path) -> Path:
    """Write a `pi` executable that runs the pi under test, for scripts that call bare `pi`.

    Parameters:
        directory (Path): directory to put first on `PATH`.

    Returns:
        Path: the directory.
    """
    shim = directory / "pi"
    shim.write_text(f'#!/bin/sh\nexec {shlex.join(pi_command())} "$@"\n')
    shim.chmod(0o755)
    return directory


def test_router_e2e_all(tmp_path: Path, rendered_settings: dict[str, Any]) -> None:
    """The remaining wait/no-router shell cases pass on the pinned repos."""
    packages = rendered_settings.get("packages", [])
    overrides = local_overrides_from_env()
    router_dir = pinned_checkout("pi-subscription-router", packages, overrides)
    subagents_dir = pinned_checkout("pi-subagents", packages, overrides)
    env = os.environ | {
        "PATH": os.pathsep.join([str(pi_shim(tmp_path)), os.environ.get("PATH", "")]),
        "PI_SUBAGENTS_DIR": str(subagents_dir),
        "PI_OFFLINE": "1",
    }
    completed = subprocess.run(
        [str(router_dir / "e2e" / "run.sh"), "all"],
        cwd=router_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
    )
    assert completed.returncode == 0, f"{completed.stdout}\n--- stderr\n{completed.stderr}"
