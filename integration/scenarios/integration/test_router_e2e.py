"""Pass through to the router repo's own faux e2e, against the pi under test."""

from __future__ import annotations

import os
import shlex
import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.paths import pi_command
from harness.stack import find_package

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

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


def test_router_e2e_all(tmp_path: Path, rendered_settings: dict[str, Any], sandbox: Sandbox) -> None:
    """The remaining `no-router` shell case passes on explicitly installed packages.

    Parameters:
        tmp_path (Path): private executable shim directory.
        rendered_settings (dict[str, Any]): settings from the explicit installed stack fixture.
        sandbox (Sandbox): private stack resolving package locations.
    """
    packages = rendered_settings.get("packages", [])
    router_dir = find_package("pi-subscription-router", packages, sandbox.agent_dir)
    subagents_dir = find_package("pi-subagents", packages, sandbox.agent_dir)
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
