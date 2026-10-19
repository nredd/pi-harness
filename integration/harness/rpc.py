"""Bounded RPC process driver for startup and actual OS lifetime boundaries.

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

from harness.paths import FAUX_EXTENSION, pi_command

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from types import TracebackType

    from harness.sandbox import Sandbox

MAX_OUTPUT = 8 * 1024 * 1024


class Rpc:
    """Bounded JSON RPC reader retained for the remaining Plan confirmation scenarios."""

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


class RpcProcess:
    """One real CLI, private script, concurrent bounded stdout/stderr readers and hard deadlines."""

    def __init__(self, box: Sandbox, script: dict[str, Any], extra_args: list[str] | None = None) -> None:
        """Start a real RPC CLI without consulting any installed machine config.

        Parameters:
            box (Sandbox): explicit installed tree.
            script (dict[str, Any]): faux provider script.
            extra_args (list[str] | None): fixture extensions.
        """
        path = box.root / f"rpc-{time.monotonic_ns()}.json"
        path.write_text(json.dumps(script))
        self.log_path = path.with_suffix(".events.jsonl")
        self.stderr_path = path.with_suffix(".stderr")
        self.lines: Queue[str | None] = Queue()
        self.stderr: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.process = subprocess.Popen(
            [
                *pi_command(),
                "-e",
                str(FAUX_EXTENSION),
                "--model",
                "faux/main",
                "--mode",
                "rpc",
                "--no-approve",
                *(extra_args or []),
            ],
            cwd=box.workdir,
            env=box.env({"HARNESS_SCRIPT": str(path)}),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.readers = [Thread(target=self._stdout, daemon=True), Thread(target=self._stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _stdout(self) -> None:
        """Read bounded stdout independently of stderr and prompt deadlines."""
        stdout = self.process.stdout
        assert stdout is not None
        size = 0
        for line in iter(lambda: stdout.readline(MAX_OUTPUT + 1), ""):
            size += len(line.encode())
            if size > MAX_OUTPUT:
                self.process.kill()
                break
            self.lines.put(line)
        self.lines.put(None)

    def _stderr(self) -> None:
        """Drain diagnostics so a failed loader cannot block startup."""
        stderr = self.process.stderr
        assert stderr is not None
        size = 0
        for chunk in iter(lambda: stderr.read(4096), ""):
            size += len(chunk.encode())
            if size > MAX_OUTPUT:
                self.process.kill()
                break
            self.stderr.append(chunk)

    def send(self, command: dict[str, Any]) -> None:
        """Send one RPC JSON record.

        Parameters:
            command (dict[str, Any]): public RPC command.
        """
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()

    def receive(self, predicate: Callable[[dict[str, Any]], bool], timeout_s: float = 60) -> dict[str, Any]:
        """Wait for one matching record with a wall-clock deadline, even on silent stdout.

        Parameters:
            predicate (Callable[[dict[str, Any]], bool]): desired event.
            timeout_s (float): maximum seconds.

        Returns:
            dict[str, Any]: matching event.

        Raises:
            AssertionError: process ended or timed out before the record.
        """
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            except Empty:
                break
            if line is None:
                raise AssertionError(f"RPC exited before expected event: {''.join(self.stderr)}")
            event = json.loads(line)
            self.events.append(event)
            if predicate(event):
                return event
        raise AssertionError(f"RPC deadline waiting for event: {''.join(self.stderr)}")

    def prompt(self, message: str = "go") -> None:
        """Submit a public prompt and wait for agent_end.

        Parameters:
            message (str): user input.
        """
        self.send({"type": "prompt", "message": message})
        self.receive(lambda event: event.get("type") == "agent_end")

    def __enter__(self) -> RpcProcess:
        """Return the running process.

        Returns:
            RpcProcess: this driver.
        """
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        """Close stdin gracefully, force cleanup only on failure/timeout."""
        assert self.process.stdin is not None
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
            if exc is None:
                raise TimeoutError("RPC did not exit on EOF") from None
        finally:
            for reader in self.readers:
                reader.join(timeout=5)
            assert self.process.stdout is not None
            assert self.process.stderr is not None
            self.process.stdout.close()
            self.process.stderr.close()
            self.log_path.write_text("".join(json.dumps(event) + "\n" for event in self.events))
            self.stderr_path.write_text("".join(self.stderr))
