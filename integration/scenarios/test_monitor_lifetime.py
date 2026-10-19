"""Real process-group cleanup and orphan ownership, not monitor wake-policy timing.

References:
- https://github.com/nredd/pi-harness/blob/main/packages/session-kit/src/monitor/pidfiles.ts
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import time
from contextlib import ExitStack
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import run_headless
from harness.isolation import process_tag
from harness.rpc import RpcProcess
from harness.sandbox import build_sandbox

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack


def tool(name: str, /, **args: Any) -> dict[str, Any]:
    """Construct a faux tool step.

    Parameters:
        name (str): tool name.
        **args (Any): real tool arguments.

    Returns:
        dict[str, Any]: scripted call.
    """
    return {"tools": [{"name": name, "args": args}]}


def script(tag: int, *, stop: bool = False) -> dict[str, Any]:
    """Start two tagged descendants in a real detached monitor process group.

    Parameters:
        tag (int): unique exact sleep argv tag.
        stop (bool): explicitly stop before EOF/exit.

    Returns:
        dict[str, Any]: faux provider script.
    """
    steps = [
        tool("search_tools", query="monitor_start monitor_stop", kind="tool"),
        tool(
            "monitor_start", name="lifetime", argv=["/bin/sh", "-c", f"/bin/sleep {tag} & /bin/sleep {tag}"]
        ),
    ]
    if stop:
        steps += [tool("monitor_stop", id="lifetime")]
    return {"providers": {"faux": {"models": ["main"], "steps": [*steps, {"text": "STARTED"}]}}}


def alive(tag: int) -> list[str]:
    """Inspect exact tagged descendants, never substring-match another worker's process.

    Parameters:
        tag (int): exact sleep argument.

    Returns:
        list[str]: matching process lines.
    """
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,command="], text=True, stderr=subprocess.STDOUT
    )
    return [line for line in output.splitlines() if line.split()[1:] == ["/bin/sleep", str(tag)]]


def wait_until(check: Callable[[], bool], what: str) -> None:
    """Poll real OS readiness with one bounded deadline.

    Parameters:
        check (Callable[[], bool]): condition.
        what (str): failure diagnostic.

    Raises:
        AssertionError: the condition does not become true before the deadline.
    """
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for '{what}'")


@pytest.fixture
def tags() -> Iterator[tuple[int, int]]:
    """Allocate worker-separated process tags and always reap only their exact argv.

    Yields:
        tuple[int, int]: independent owner tags.
    """
    worker = os.environ.get("PYTEST_XDIST_WORKER", "master")
    values = (
        process_tag(worker, secrets.randbelow(50_000)),
        process_tag(worker, 50_000 + secrets.randbelow(50_000)),
    )
    yield values
    for tag in values:
        subprocess.run(["/usr/bin/pkill", "-f", f"^/bin/sleep {tag}$"], check=False)


@pytest.mark.parametrize("mode", ["print", "rpc", "stop"])
def test_children_die_when_pi_quits_mid_monitor(sandbox: Sandbox, tags: tuple[int, int], mode: str) -> None:
    """Print completion, RPC EOF and explicit stop reap descendants/pidfiles without a wake.

    Parameters:
        sandbox (Sandbox): private installed stack.
        tags (tuple[int, int]): worker-separated process argv identities.
        mode (str): print completion, RPC EOF or explicit stop path.
    """
    tag = tags[0]
    payload = script(tag, stop=mode == "stop")
    requests = sandbox.root / "lifetime-requests.jsonl"
    sandbox.env_overrides["HARNESS_REQUEST_LOG"] = str(requests)
    if mode == "print":
        result = run_headless(sandbox, payload, ["go"])
        assert result.returncode == 0, result.transcript()
        assert "STARTED" in result.assistant_texts(), result.transcript()
    else:
        with RpcProcess(sandbox, payload) as rpc:
            rpc.prompt()
            if mode == "stop":
                stopped = [
                    event
                    for event in rpc.events
                    if event.get("type") == "tool_execution_end" and event.get("toolName") == "monitor_stop"
                ]
                assert [event["isError"] for event in stopped] == [False], stopped
                wait_until(lambda: not alive(tag), "explicit stop to reap descendants")
                assert not list((sandbox.root / "tmp").glob("pi-monitors-*/*/*.json"))
            else:
                assert alive(tag), "monitor must exist before graceful EOF"
        assert rpc.process.returncode == 0, "".join(rpc.stderr)
    wait_until(lambda: not alive(tag), "shutdown to reap monitor group")
    assert not list((sandbox.root / "tmp").glob("pi-monitors-*/*/*.json"))
    assert len(requests.read_text().splitlines()) == (4 if mode == "stop" else 3), "unexpected monitor wake"
    if mode == "stop":
        # Same-session stop is deliberately idempotent. A fresh owner must not inherit the old ID.
        fresh = {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        tool("search_tools", query="monitor_start monitor_stop", kind="tool"),
                        tool("monitor_stop", id="lifetime"),
                        {"text": "DONE"},
                    ],
                }
            }
        }
        again = run_headless(sandbox, fresh, ["stop"])
        assert again.returncode == 0, again.transcript()
        stopped = [outcome for outcome in again.tool_outcomes() if outcome.name == "monitor_stop"]
        assert len(stopped) == 1
        assert stopped[0].is_error, stopped[0]


def monitor_list(owner: RpcProcess) -> str:
    """Read the owner's public `/monitor` listing through RPC notifications.

    Parameters:
        owner (RpcProcess): live session whose registry is queried.

    Returns:
        str: command notification, not filesystem-derived ownership.
    """
    owner.send({"type": "prompt", "message": "/monitor"})
    event = owner.receive(
        lambda event: event.get("type") == "extension_ui_request" and event.get("method") == "notify"
    )
    return event["message"]


def test_next_session_sweeps_only_dead_owners(
    sandbox: Sandbox, template_home: Path, tags: tuple[int, int]
) -> None:
    """Successive startups sweep dead A, preserve live B and inherit no monitor ownership.

    Parameters:
        sandbox (Sandbox): owner A's private installed stack.
        template_home (Path): installed fixture copied for independent B, C and D sessions.
        tags (tuple[int, int]): worker-separated sleep argv identities for A and B.
    """
    tag_a, tag_b = tags
    boxes = [
        sandbox,
        build_sandbox(sandbox.root / "b", template_home),
        build_sandbox(sandbox.root / "c", template_home),
        build_sandbox(sandbox.root / "d", template_home),
    ]
    shared_tmp = sandbox.root / "tmp"
    for box in boxes:
        box.env_overrides["TMPDIR"] = str(shared_tmp)
    with ExitStack() as lifetime:
        owner_a = lifetime.enter_context(RpcProcess(boxes[0], script(tag_a)))
        owner_a.prompt()
        owner_b = lifetime.enter_context(RpcProcess(boxes[1], script(tag_b)))
        owner_b.prompt()
        for owner, tag in ((owner_a, tag_a), (owner_b, tag_b)):
            started = [
                event
                for event in owner.events
                if event.get("type") == "tool_execution_end" and event.get("toolName") == "monitor_start"
            ]
            assert len(started) == 1, owner.events
            assert not started[0]["isError"], started
            assert alive(tag), started
        wait_until(
            lambda: len(list(shared_tmp.glob("pi-monitors-*/*/*.json"))) == 2,
            f"two owner pidfiles under '{shared_tmp}', current files: {list(shared_tmp.rglob('*.json'))}",
        )
        files = list(shared_tmp.glob("pi-monitors-*/*/*.json"))
        records = {json.loads(path.read_text())["ownerPid"]: path for path in files}
        assert set(records) == {owner_a.process.pid, owner_b.process.pid}
        assert records[owner_a.process.pid].parent != records[owner_b.process.pid].parent
        owner_a.process.kill()
        owner_a.process.wait(timeout=10)
        assert alive(tag_a), "SIGKILL must leave a real orphan to exercise sweep"
        assert records[owner_a.process.pid].exists()
        owner_c = lifetime.enter_context(
            RpcProcess(boxes[2], {"providers": {"faux": {"models": ["main"], "steps": []}}})
        )
        owner_c.send({"id": "ready", "type": "get_state"})
        owner_c.receive(lambda event: event.get("id") == "ready")
        wait_until(lambda: not alive(tag_a), "new owner to sweep A's group")
        wait_until(lambda: not records[owner_a.process.pid].exists(), "dead-owner pidfile cleanup")
        assert alive(tag_b), "live B's group was swept"
        assert records[owner_b.process.pid].exists()
        assert owner_b.process.poll() is None
        assert 'm1 "lifetime" running' in monitor_list(owner_b)
        assert monitor_list(owner_c) == "no monitors"
        # A second completed startup must not sweep B either.
        owner_d = lifetime.enter_context(
            RpcProcess(boxes[3], {"providers": {"faux": {"models": ["main"], "steps": []}}})
        )
        owner_d.send({"id": "ready-again", "type": "get_state"})
        owner_d.receive(lambda event: event.get("id") == "ready-again")
        assert alive(tag_b), "another startup swept live B's group"
        assert records[owner_b.process.pid].exists()
        assert owner_b.process.poll() is None
        assert 'm1 "lifetime" running' in monitor_list(owner_b)
