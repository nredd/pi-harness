"""Declared package discovery, process modes and model-visible schemas at the assembled boundary.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
"""

from __future__ import annotations

import json
import subprocess
import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.golden import assert_golden
from harness.headless import run_headless
from harness.paths import FAUX_EXTENSION, pi_command
from harness.rpc import RpcProcess

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.stack
SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": [{"text": "STACK-OK"}]}}}


def wait_dead(pane: TmuxPane) -> int:
    """Require a real TUI process to exit and expose its exit status.

    Parameters:
        pane (TmuxPane): private tmux pane.

    Returns:
        int: child's status.
    """
    deadline = time.monotonic() + 30
    assert pane.exit_status_path is not None
    while time.monotonic() < deadline:
        if pane.exit_status_path.is_file() and not pane.is_alive():
            return int(pane.exit_status_path.read_text().strip())
        time.sleep(0.05)
    raise AssertionError(f"TUI never reported its exit status: {pane.capture()}")


@pytest.mark.parametrize("mode", ["text", "json", "rpc", "tui"])
def test_extensions_load_without_warnings(sandbox: Sandbox, tui: Callable[..., TmuxPane], mode: str) -> None:
    """Actual package discovery is quiet in every CLI mode, with no GUI-helper side effects."""
    if mode == "json":
        result = run_headless(sandbox, SCRIPT, ["hi"], extra_args=["--no-approve"])
        assert result.returncode == 0, result.transcript()
        assert result.assistant_texts() == ["STACK-OK"], result.transcript()
        assert not result.stdout_noise
        assert not result.stderr.strip(), result.stderr
    elif mode == "text":
        script = sandbox.root / "text.json"
        script.write_text(json.dumps(SCRIPT))
        done = subprocess.run(
            [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", "faux/main", "--no-approve", "-p", "hi"],
            cwd=sandbox.workdir,
            env=sandbox.env({"HARNESS_SCRIPT": str(script)}),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert done.returncode == 0, done.stderr
        assert done.stdout.strip() == "STACK-OK"
        assert not done.stderr.strip(), done.stderr
    elif mode == "rpc":
        with RpcProcess(sandbox, SCRIPT) as rpc:
            rpc.send({"id": "state", "type": "get_state"})
            state = rpc.receive(lambda event: event.get("id") == "state")
            assert state["success"], state
            rpc.prompt()
        assert rpc.process.returncode == 0
        assert not "".join(rpc.stderr).strip()
    else:
        pane = tui(SCRIPT, extra_args=["--no-approve"])
        pane.send_keys("C-d")
        assert wait_dead(pane) == 0
        assert not (sandbox.root / "pi0.stderr").read_text().strip()
    assert not list((sandbox.home / "Applications").glob("*.app"))


def test_tool_set(sandbox: Sandbox) -> None:
    """The stack's exact schema golden and deferred monitor/worktree promotion survive the real loader."""
    searches = [
        {"name": "search_tools", "args": {"query": query, "kind": "tool"}}
        for query in ("background monitor process watcher", "git worktree add remove")
    ]
    script = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [
                    {"listTools": True},
                    {"tools": searches},
                    {"listTools": True},
                ],
            }
        }
    }
    result = run_headless(sandbox, script, ["before", "promote"], extra_args=["--no-approve"])
    assert result.returncode == 0, result.transcript()
    texts = [text for text in result.assistant_texts() if text.startswith("TOOLS ")]
    assert len(texts) == 2, result.transcript()
    before, after = (set(text.removeprefix("TOOLS ").split(",")) for text in texts)
    name = (sandbox.agent_dir / "stack-name").read_text()
    assert_golden(f"{name}-tools.txt", "\n".join(sorted(before)) + "\n")
    promoted = {"monitor_start", "monitor_stop", "git_worktree_add", "git_worktree_remove"}
    assert not before & promoted, before
    assert promoted <= after, after
    assert {"monitor_read", "git_worktree_list"} <= before
    found = [outcome for outcome in result.tool_outcomes() if outcome.name == "search_tools"]
    assert len(found) == 2, result.transcript()
    assert all(not outcome.is_error for outcome in found), found
    text = "\n".join(outcome.text for outcome in found)
    assert all(tool in text for tool in promoted), text
