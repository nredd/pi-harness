"""CLI startup failures must not dispatch a provider request or leak held messages.

References:
- https://github.com/nredd/pi/blob/nredd/v1.3.0/packages/coding-agent/docs/extensions.md
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.interactive import launch_tui
from harness.paths import FAUX_EXTENSION, pi_command
from scenarios.test_stack import wait_dead

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack
MESSAGE = "STARTUP-BOUNDARY-FAILURE"
HELD = "HELD-MESSAGE-MUST-NOT-LEAK"


@pytest.mark.parametrize("mode", ["text", "json", "rpc", "tui"])
@pytest.mark.parametrize("phase", ["factory", "session_start"])
@pytest.mark.parametrize("fatal", [False, True], ids=["ordinary", "fatal"])
def test_fatal_startup_modes(sandbox: Sandbox, mode: str, phase: str, fatal: bool) -> None:
    """Real CLI modes distinguish ordinary errors from fatal startup, with zero fatal provider dispatch."""
    extension = sandbox.root / "startup.ts"
    error = f"new {'ExtensionStartupError' if fatal else 'Error'}({json.dumps(MESSAGE)})"
    # Use the host's symbol bridge, not a second bundled host identity.
    body = f"throw {error};"
    if phase == "session_start":
        body = f'pi.on("session_start", () => {{ pi.sendUserMessage({json.dumps(HELD)}); {body} }});'
    extension.write_text(
        'import { ExtensionStartupError } from "@earendil-works/pi-coding-agent";\n'
        f"export default function(pi) {{ {body} }}\n"
    )
    requests = sandbox.root / "provider-requests.jsonl"
    script = sandbox.root / "startup-script.json"
    script.write_text(
        json.dumps({"providers": {"faux": {"models": ["main"], "steps": [{"text": "STARTUP-OK"}]}}})
    )
    env = {"HARNESS_SCRIPT": str(script), "HARNESS_REQUEST_LOG": str(requests)}
    extra = ["-e", str(extension), "--no-approve"]
    if mode == "tui":
        pane = launch_tui(
            sandbox,
            {"providers": {"faux": {"models": ["main"], "steps": [{"text": "STARTUP-OK"}]}}},
            extra_args=extra,
            env=env,
            wait_pattern=None,
        )
        try:
            if not fatal:
                pane.wait_for(MESSAGE)
                pane.send_keys("C-d")
            code = wait_dead(pane)
            output = pane.capture() + (sandbox.root / "pi.stderr").read_text()
        finally:
            pane.kill()
    else:
        args = [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", "faux/main", *extra]
        if mode == "rpc":
            args += ["--mode", "rpc"]
            stdin = json.dumps({"id": "prompt", "type": "prompt", "message": "hi"}) + "\n"
        else:
            args += (["--mode", "json"] if mode == "json" else []) + ["-p", "hi"]
            stdin = ""
        result = subprocess.run(
            args,
            cwd=sandbox.workdir,
            env=sandbox.env(env),
            input=stdin,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        code, output = result.returncode, result.stdout + result.stderr
    assert MESSAGE in output, output
    if fatal:
        assert code != 0, f"Fatal {phase} was swallowed in {mode}: {output}"
        assert not requests.exists(), requests.read_text() if requests.exists() else ""
        assert HELD not in output
    else:
        assert code == 0, output
