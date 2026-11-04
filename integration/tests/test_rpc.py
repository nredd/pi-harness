"""`Rpc`/`rpc` and `RpcProcess` against the stub `pi` speaking the JSONL RPC protocol.

No test signals a real process. Live sessions end on their own (EOF or `/exit`) before the
driver's teardown, so its `terminate()` finds a reaped child and sends nothing; the
terminate/kill fallbacks and the output-cap kill run against injected recording fakes.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
"""

from __future__ import annotations

import io
import json
import subprocess
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest

from harness import rpc
from tests.stub_pi import EARLY_EXIT, FLOOD_BYTES, stub_pi_command
from tests.stub_pi_session import stub_sandbox

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": [{"text": "first reply"}]}}}
# Long enough for any live wait in this file; every negative wait below uses a short explicit one.
EXIT_WAIT_S = 30
NO_EVENT_S = 0.2


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Sandbox:
    """Bare sandbox, with both RPC drivers launching the stub.

    Parameters:
        tmp_path (Path): test scratch.
        monkeypatch (pytest.MonkeyPatch): test patcher.

    Returns:
        Sandbox: fresh home.
    """
    monkeypatch.setattr(rpc, "pi_command", stub_pi_command)
    return stub_sandbox(tmp_path)


def finish_on_eof(client: rpc.Rpc) -> int:
    """Close stdin and reap the stub, so the driver's teardown has nothing left to signal.

    Parameters:
        client (rpc.Rpc): live client.

    Returns:
        int: stub exit status.
    """
    assert client.process.stdin is not None
    client.process.stdin.close()
    return client.process.wait(timeout=EXIT_WAIT_S)


def test_rpc_command_round_trip_skips_non_events(box: Sandbox) -> None:
    """Commands are acknowledged by id; banner and non-object JSON lines are not events."""
    script = box.root / "script.json"
    script.write_text(json.dumps(SCRIPT))
    env = {"STUB_PI_NOISE": "1", "HARNESS_SCRIPT": str(script)}
    with rpc.rpc(box, ["-e", "ext.ts"], "faux/main", env) as client:
        client.command("/hello")
        end = client.wait(lambda event: event.get("type") == "agent_end")
        assert client.wait(lambda event: event.get("type") == "agent_end") is end
        replies = [event for event in client.events if event.get("type") == "message_end"]
        assert replies[0]["message"]["content"] == [{"type": "text", "text": "first reply"}]
        assert all(isinstance(event, dict) for event in client.events)
        assert client.events[0] == {"type": "response", "id": "/hello", "command": "prompt", "success": True}
        assert finish_on_eof(client) == 0
    assert client.process.returncode == 0
    assert not client.reader.is_alive()
    assert client.process.stdout is not None
    assert client.process.stdout.closed
    assert (box.root / "quota-rpc.stderr").read_text() == "stub rpc ready\n"


def test_rpc_command_refusal_fails_with_the_reply(box: Sandbox) -> None:
    """An unsuccessful acknowledgement is an assertion naming the reply."""
    with rpc.rpc(box, [], "faux/main", {}) as client:
        with pytest.raises(AssertionError, match="'success': False"):
            client.command("/reject")
        assert finish_on_eof(client) == 0


def test_rpc_wait_deadline_reports_early_exit(box: Sandbox) -> None:
    """A stub that exits without answering fails the wait with its exit status and events."""
    with rpc.rpc(box, [], "faux/main", {}) as client:
        assert client.process.stdin is not None
        client.process.stdin.write(json.dumps({"type": "prompt", "message": "/exit"}) + "\n")
        client.process.stdin.flush()
        assert client.process.wait(timeout=EXIT_WAIT_S) == EARLY_EXIT
        client.reader.join(timeout=EXIT_WAIT_S)
        with pytest.raises(
            pytest.fail.Exception, match=rf"RPC deadline expired; exit={EARLY_EXIT}, events=\[\]"
        ):
            client.wait(lambda _: True, timeout=NO_EVENT_S)
    assert "stub rpc early exit" in (box.root / "quota-rpc.stderr").read_text()


class FakeRpcChild:
    """Recording `Popen` stand-in that ignores `terminate()` until `kill()`."""

    def __init__(self, argv: list[str], **kwargs: Any) -> None:
        """Record the launch.

        Parameters:
            argv (list[str]): command.
            **kwargs (Any): `Popen` options.
        """
        self.argv = argv
        self.kwargs = kwargs
        self.stdin = io.StringIO()
        self.stdout = io.StringIO(json.dumps({"type": "ready"}) + "\n")
        self.calls: list[str] = []
        self.returncode: int | None = None

    def terminate(self) -> None:
        """Record a SIGTERM request; the fake keeps running."""
        self.calls.append("terminate")

    def kill(self) -> None:
        """Record a SIGKILL request; the fake dies."""
        self.calls.append("kill")
        self.returncode = -9

    def wait(self, timeout: float) -> int:
        """Time out while alive, return the status once killed.

        Parameters:
            timeout (float): requested bound.

        Returns:
            int: exit status.

        Raises:
            subprocess.TimeoutExpired: still alive.
        """
        self.calls.append(f"wait {timeout}")
        if self.returncode is None:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        return self.returncode

    def poll(self) -> int | None:
        """Return the status without waiting.

        Returns:
            int | None: status, None while alive.
        """
        return self.returncode


def test_rpc_teardown_escalates_to_kill(box: Sandbox, monkeypatch: pytest.MonkeyPatch) -> None:
    """A child that ignores terminate is killed and reaped, and its pipes are closed."""
    children: list[FakeRpcChild] = []

    def spawn(argv: list[str], **kwargs: Any) -> FakeRpcChild:
        children.append(FakeRpcChild(argv, **kwargs))
        return children[-1]

    fake = SimpleNamespace(Popen=spawn, PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired)
    monkeypatch.setattr(rpc, "subprocess", fake)
    with rpc.rpc(box, ["-e", "ext.ts"], "faux/model", {"K": "V"}) as client:
        assert client.wait(lambda event: event["type"] == "ready") == {"type": "ready"}
    (child,) = children
    assert child.argv == [*stub_pi_command(), "-e", "ext.ts", "--model", "faux/model", "--mode", "rpc"]
    assert child.kwargs["env"]["K"] == "V"
    assert child.kwargs["cwd"] == box.workdir
    assert child.calls == ["terminate", "wait 10", "kill", "wait 5"]
    assert child.stdin.closed
    assert child.stdout.closed


def test_rpc_process_prompt_round_trip(box: Sandbox) -> None:
    """`RpcProcess` sends the script, waits for `agent_end`, and logs events on EOF exit."""
    with rpc.RpcProcess(box, SCRIPT, ["--extra"]) as session:
        session.prompt("hi")
        assert session.events[-1] == {"type": "agent_end"}
        texts = [event["message"]["content"][0]["text"] for event in session.events if "message" in event]
        assert texts == ["first reply"]
    assert session.process.returncode == 0
    logged = [json.loads(line) for line in session.log_path.read_text().splitlines()]
    assert logged == session.events
    assert "".join(session.stderr) == "stub rpc ready\n"


@pytest.mark.parametrize(("command", "reader"), [("/flood", 0), ("/flood-stderr", 1)])
def test_rpc_process_output_cap_kills_through_the_driver(
    box: Sandbox, monkeypatch: pytest.MonkeyPatch, command: str, reader: int
) -> None:
    """An oversized stdout line or stderr chunk trips the cap: that reader asks for one kill and stops."""
    # The unread rest of the flood stays far below any pipe buffer, so the stub never blocks.
    monkeypatch.setattr(rpc, "MAX_OUTPUT", FLOOD_BYTES // 4)
    session = rpc.RpcProcess(box, SCRIPT)
    kills: list[str] = []
    monkeypatch.setattr(session.process, "kill", lambda: kills.append("kill"))
    with session:
        assert session.readers[reader].is_alive()
        session.send({"type": "prompt", "message": command})
        session.readers[reader].join(timeout=EXIT_WAIT_S)
        assert not session.readers[reader].is_alive()
        assert kills == ["kill"]
        if command == "/flood":
            with pytest.raises(AssertionError, match="RPC exited before expected event"):
                session.receive(lambda _: True, timeout_s=EXIT_WAIT_S)
        else:
            # The over-cap chunk is dropped, never appended.
            assert "x" * rpc.MAX_OUTPUT not in "".join(session.stderr)
    assert session.process.returncode == 0
