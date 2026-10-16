"""The quota footer is TUI only: headless runs never issue the usage RPC.

Uses `providers/usage_fixture.ts` and the fast timers (see `scenarios/tui/test_quota_footer.py`).
RPC startup is exercised with a tool-free `get_state` command and EOF, with no model calls.
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.headless import run_headless
from harness.paths import FAUX_EXTENSION, pi_command
from harness.quota import (
    FAST_POLL_MS,
    FAST_TIMERS,
    USAGE_FIXTURE_EXTENSION,
    fixture_env,
    install_usage_fixture,
)

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration


def test_rpc_mode_never_mounts_quota_poller(sandbox: Sandbox) -> None:
    """RPC initialization and a state query must not mount a footer or request subscription usage."""
    usage = install_usage_fixture(sandbox)
    result = subprocess.run(
        [*pi_command(), "--no-session", "--mode", "rpc", "-e", str(USAGE_FIXTURE_EXTENSION)],
        input=json.dumps({"id": "quota-state", "type": "get_state"}) + "\n",
        cwd=sandbox.workdir,
        env=sandbox.env(fixture_env(usage, FAST_TIMERS)),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    responses = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    assert any(response.get("id") == "quota-state" and response.get("success") for response in responses)
    assert usage.requests() == []


def test_plain_print_mode_never_polls(sandbox: Sandbox) -> None:
    """Plain-text print mode stays tool-free and never starts the TUI footer timer."""
    usage = install_usage_fixture(sandbox)
    script_path = sandbox.root / "quota-print-script.json"
    script_path.write_text(
        json.dumps(
            {
                "providers": {
                    "faux": {"models": ["main"], "steps": [{"delayMs": 4000, "text": "QUOTA PRINT OK"}]}
                }
            }
        )
    )
    result = subprocess.run(
        [
            *pi_command(),
            "--no-session",
            "-e",
            str(FAUX_EXTENSION),
            "-e",
            str(USAGE_FIXTURE_EXTENSION),
            "--model",
            "faux/main",
            "--mode",
            "text",
            "-p",
            "hi",
        ],
        cwd=sandbox.workdir,
        env=sandbox.env(fixture_env(usage, FAST_TIMERS) | {"HARNESS_SCRIPT": str(script_path)}),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "QUOTA PRINT OK" in result.stdout
    assert usage.requests() == []


def test_json_print_mode_never_polls(sandbox: Sandbox) -> None:
    """JSON print mode has no footer: no `router:rpc:usage` request, even past several poll intervals."""
    usage = install_usage_fixture(sandbox)
    script = {"providers": {"faux": {"models": ["main"], "steps": [{"delayMs": 4000, "text": "OK"}]}}}
    result = run_headless(
        sandbox,
        script,
        ["hi"],
        extra_args=["-e", str(USAGE_FIXTURE_EXTENSION)],
        env=fixture_env(usage, FAST_TIMERS),
    )
    assert result.returncode == 0, result.transcript()
    assert result.assistant_texts() == ["OK"], result.transcript()
    assert result.duration_s > FAST_POLL_MS / 1000 * 2
    assert usage.requests() == []
