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
    """Real CLI modes distinguish ordinary errors from fatal startup, with zero fatal provider dispatch.

    Parameters:
        sandbox (Sandbox): private stack receiving the failing extension.
        mode (str): text, JSON, RPC or TUI CLI entry.
        phase (str): extension factory or session-start handler.
        fatal (bool): use ExtensionStartupError instead of an ordinary Error.
    """
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
    # Factory failures abort CLI resource loading regardless of error class; only ordinary
    # session_start errors are warning-only. Core's CLI, not the factory loader alone, owns this.
    fail_closed = fatal or phase == "factory"
    if mode == "tui":
        pane = launch_tui(
            sandbox,
            {"providers": {"faux": {"models": ["main"], "steps": [{"text": "STARTUP-OK"}]}}},
            extra_args=extra,
            env=env,
            wait_pattern=None,
        )
        try:
            if not fail_closed:
                pane.wait_for("STARTUP-OK")
                pane.send_keys("C-d")
            code = wait_dead(pane)
            output = pane.capture() + (sandbox.root / "pi.stderr").read_text()
        finally:
            (sandbox.root / "startup-tui.txt").write_text(pane.capture())
            (sandbox.root / "startup-tui.ansi").write_text(pane.capture(styled=True))
            pane.kill()
    else:
        args = [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", "faux/main", *extra]
        if mode == "rpc":
            args += ["--mode", "rpc"]
            stdin = json.dumps({"id": "prompt", "type": "prompt", "message": "hi"}) + "\n"
        else:
            args += (["--mode", "json"] if mode == "json" else []) + ["-p", "hi"]
            stdin = ""
        # A TimeoutExpired traceback truncates stderr, including native Bun crash reports.
        # Stream original bytes to the existing artifact allowlist, even on timeout/abnormal EOF.
        stderr_path = sandbox.root / f"startup-{mode}.stderr"
        with stderr_path.open("wb") as stderr:
            result = subprocess.run(
                args,
                cwd=sandbox.workdir,
                env=sandbox.env(env),
                input=stdin,
                stdout=subprocess.PIPE,
                stderr=stderr,
                text=True,
                timeout=60,
                check=False,
            )
        code = result.returncode
        output = result.stdout + stderr_path.read_text(errors="replace")
    if mode != "tui" or fail_closed:
        assert MESSAGE in output, output
    if fail_closed:
        assert code != 0, f"Fatal {phase} was swallowed in {mode}: {output}"
        assert not requests.exists(), requests.read_text() if requests.exists() else ""
        assert HELD not in output
        for history in (sandbox.agent_dir / "sessions").rglob("*.jsonl"):
            assert HELD not in history.read_text(), history
    else:
        assert code == 0, output
