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
        steps += [tool("monitor_stop", id="lifetime"), tool("monitor_stop", id="lifetime")]
    return {"providers": {"faux": {"models": ["main"], "steps": [*steps, {"text": "STARTED"}]}}}


def alive(tag: int) -> list[str]:
    """Inspect exact tagged descendants, never substring-match another worker's process.

    Parameters:
        tag (int): exact sleep argument.

    Returns:
        list[str]: matching process lines.
    """
    output = subprocess.check_output(["/bin/ps", "-axo", "pid=,command="], text=True)
    return [line for line in output.splitlines() if line.split()[1:] == ["/bin/sleep", str(tag)]]


def wait_until(check: Callable[[], bool], what: str) -> None:
    """Poll real OS readiness with one bounded deadline.

    Parameters:
        check (Callable[[], bool]): condition.
        what (str): failure diagnostic.
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
    base = 900_000_000 + (os.getpid() % 10_000) * 1000
    values = (base + secrets.randbelow(500), base + 500 + secrets.randbelow(500))
    yield values
    for tag in values:
        subprocess.run(["/usr/bin/pkill", "-f", f"^/bin/sleep {tag}$"], check=False)


@pytest.mark.parametrize("mode", ["print", "rpc", "stop"])
def test_children_die_when_pi_quits_mid_monitor(sandbox: Sandbox, tags: tuple[int, int], mode: str) -> None:
    """Print completion, RPC EOF and explicit stop reap descendants/pidfiles without a wake."""
    tag = tags[0]
    payload = script(tag, stop=mode == "stop")
    if mode == "print":
        result = run_headless(sandbox, payload, ["go"])
        assert result.returncode == 0, result.transcript()
        assert "STARTED" in result.assistant_texts(), result.transcript()
    else:
        with RpcProcess(sandbox, payload) as rpc:
            rpc.prompt()
            if mode == "stop":
                wait_until(lambda: not alive(tag), "explicit stop to reap descendants")
                assert not list((sandbox.root / "tmp").glob("pi-monitors-*/*/*.json"))
            else:
                assert alive(tag), "monitor must exist before graceful EOF"
        assert rpc.process.returncode == 0, "".join(rpc.stderr)
    wait_until(lambda: not alive(tag), "shutdown to reap monitor group")
    assert not list((sandbox.root / "tmp").glob("pi-monitors-*/*/*.json"))


def test_next_session_sweeps_only_dead_owners(
    sandbox: Sandbox, template_home: Path, tags: tuple[int, int]
) -> None:
    """Three RPC owners share one tmp root; SIGKILL orphans A and C sweeps A, never live B."""
    tag_a, tag_b = tags
    boxes = [
        sandbox,
        build_sandbox(sandbox.root / "b", template_home),
        build_sandbox(sandbox.root / "c", template_home),
    ]
    shared_tmp = sandbox.root / "tmp"
    for box in boxes:
        box.env_overrides["TMPDIR"] = str(shared_tmp)
    with ExitStack() as lifetime:
        owner_a = lifetime.enter_context(RpcProcess(boxes[0], script(tag_a)))
        owner_a.prompt()
        owner_b = lifetime.enter_context(RpcProcess(boxes[1], script(tag_b)))
        owner_b.prompt()
        wait_until(lambda: len(list(shared_tmp.glob("pi-monitors-*/*/*.json"))) == 2, "two owner pidfiles")
        files = list(shared_tmp.glob("pi-monitors-*/*/*.json"))
        records = {json.loads(path.read_text())["ownerPid"]: path for path in files}
        assert set(records) == {owner_a.process.pid, owner_b.process.pid}
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
