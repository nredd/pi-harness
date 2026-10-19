"""Bounded RPC driver retained for the remaining Plan confirmation scenarios.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
"""

from __future__ import annotations

import json
import subprocess
import time
from contextlib import contextmanager
from queue import Empty, Queue
from threading import Thread
from typing import TYPE_CHECKING, Any

import pytest

from harness.paths import pi_command

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from harness.sandbox import Sandbox


class Rpc:
    """Bounded JSON RPC reader; stdout is drained while the caller waits for events."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        """Attach a queue reader to a running faux pi process.

        Parameters:
            process (subprocess.Popen[str]): process with piped stdout/stdin.
        """
        self.process = process
        self.events: list[dict[str, Any]] = []
        self.queue: Queue[dict[str, Any]] = Queue()
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        """Drain JSON stdout until process exit; non-JSON diagnostics are not RPC events."""
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                self.queue.put(event)

    def wait(self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 30) -> dict[str, Any]:
        """Collect events until a predicate matches, with an absolute deadline.

        Parameters:
            predicate (Callable[[dict[str, Any]], bool]): matching event condition.
            timeout (float): maximum seconds.

        Returns:
            dict[str, Any]: matched event.
        """
        for event in self.events:
            if predicate(event):
                return event
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.queue.get(timeout=max(0.001, deadline - time.monotonic()))
            except Empty:
                break
            self.events.append(event)
            if predicate(event):
                return event
        pytest.fail(f"RPC deadline expired; exit={self.process.poll()}, events={self.events}")

    def command(self, text: str) -> None:
        """Execute an actual extension slash command and await RPC acknowledgement.

        Parameters:
            text (str): command including slash.
        """
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"id": text, "type": "prompt", "message": text}) + "\n")
        self.process.stdin.flush()
        reply = self.wait(lambda e: e.get("type") == "response" and e.get("id") == text)
        assert reply.get("success"), reply


@contextmanager
def rpc(box: Sandbox, args: list[str], model: str, env: dict[str, str]) -> Iterator[Rpc]:
    """Keep a real RPC session alive, then terminate it without leaking parked children.

    Parameters:
        box (Sandbox): isolated home.
        args (list[str]): explicit extension flags.
        model (str): faux or faux-chain virtual model.
        env (dict[str, str]): fixture settings.

    Yields:
        Rpc: live client.
    """
    stderr_path = box.root / "quota-rpc.stderr"
    with stderr_path.open("w") as stderr:
        process = subprocess.Popen(
            [*pi_command(), *args, "--model", model, "--mode", "rpc"],
            cwd=box.workdir,
            env=box.env(env),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )
        client = Rpc(process)
        try:
            yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            client.reader.join(timeout=5)
            if process.stdin is not None:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()
