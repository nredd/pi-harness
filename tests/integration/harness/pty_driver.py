"""Bounded POSIX PTY ownership and fair aggregate byte-rate draining.

References:
- https://docs.python.org/3/library/pty.html
- https://docs.python.org/3/library/subprocess.html#subprocess.Popen
"""

from __future__ import annotations

import errno
import fcntl
import math
import os
import pty
import select
import struct
import subprocess
import termios
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Self

from harness.process_group import kill_owned_group

if TYPE_CHECKING:
    from collections.abc import Callable

CHUNK = 1024
POLL_S = 0.01
TAIL_BYTES = 65536
TEARDOWN_S = 2.0


@dataclass(frozen=True)
class Child:
    """Explicit argv, working directory and complete scrubbed child environment."""

    argv: tuple[str, ...]
    cwd: Path
    env: dict[str, str]


@dataclass(frozen=True)
class Drain:
    """Delivered bytes per child and monotonic elapsed time, excluding startup."""

    delivered: tuple[int, ...]
    elapsed_s: float

    @property
    def bytes_per_s(self) -> float:
        """Actual aggregate delivery rate, not the requested cap."""
        return sum(self.delivered) / self.elapsed_s


def _positive(value: float) -> None:
    """Reject non-finite and non-positive time or rate inputs before spawning work."""
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"Expected a finite positive value, got '{value}'")


class PtyFleet:
    """Own child process groups and master descriptors, including partial startup.

    Use as a context manager. Draining never captures unbounded output. Startup is
    deliberately uncapped; each measured drain starts a fresh, non-bursting budget.
    """

    def __init__(self, specs: list[Child]) -> None:
        """Validate commands; construction alone creates no children or descriptors."""
        if not specs or any(not spec.argv or not Path(spec.argv[0]).is_absolute() for spec in specs):
            raise ValueError("Provide children with absolute executable paths")
        self.specs = specs
        self.children: list[subprocess.Popen[bytes]] = []
        self.masters: list[int] = []
        self.tails: list[bytes] = []
        self.counts: list[int] = []
        self.cursor = 0
        self.closed = False

    def __enter__(self) -> Self:
        """Spawn a fresh fleet, closing every acquired resource on any exception."""
        if self.closed or self.children:
            raise RuntimeError("A `PtyFleet` cannot be entered twice")
        try:
            for spec in self.specs:
                master, slave = pty.openpty()
                self.masters.append(master)
                try:
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                    os.set_blocking(master, False)
                    proc = subprocess.Popen(
                        list(spec.argv),
                        cwd=spec.cwd,
                        env=spec.env,
                        stdin=slave,
                        stdout=slave,
                        stderr=slave,
                        start_new_session=True,
                    )
                    self.children.append(proc)
                finally:
                    os.close(slave)
                self.tails.append(b"")
                self.counts.append(0)
        except BaseException:
            self.close()
            raise
        return self

    def __exit__(self, *_exc: object) -> None:
        """Release every child and descriptor, also on cancellation."""
        self.close()

    def close(self) -> None:
        """KILL every owned group before reaping any leader, then close all masters."""
        if self.closed:
            return
        self.closed = True
        try:
            errors: list[OSError | subprocess.TimeoutExpired] = []
            killed = []
            for proc in self.children:
                try:
                    kill_owned_group(proc.pid, TEARDOWN_S)
                    killed.append(proc)
                except (OSError, subprocess.TimeoutExpired) as error:
                    errors.append(error)
            deadline = time.monotonic() + TEARDOWN_S
            for proc in killed:
                try:
                    proc.wait(timeout=max(0, deadline - time.monotonic()))
                except subprocess.TimeoutExpired as error:
                    errors.append(error)
            if errors:
                raise errors[0]
        finally:
            for fd in self.masters:
                os.close(fd)

    def _alive(self) -> None:
        """Refuse an inactive fleet or an exited child instead of reporting zero latency."""
        if self.closed or not self.children:
            raise RuntimeError("The PTY fleet is not active")
        for index, proc in enumerate(self.children):
            status = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if status is not None:
                raise RuntimeError(f"PTY child '{index}' exited with '{status.si_status}'")

    def send(self, index: int, data: bytes, *, timeout_s: float = 1.0) -> None:
        """Write all input with a bounded wait, refusing exited children and blocked input."""
        _positive(timeout_s)
        deadline = time.monotonic() + timeout_s
        while data:
            self._alive()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("PTY input stalled")
            fd = self.masters[index]
            if select.select([], [fd], [], min(POLL_S, remaining))[1]:
                try:
                    data = data[os.write(fd, data) :]
                except BlockingIOError:
                    continue

    def wait_for(self, marker: bytes, *, timeout_s: float = 60.0) -> None:
        """Drain uncapped until every bounded output tail contains the readiness marker."""
        _positive(timeout_s)
        if not marker or len(marker) > TAIL_BYTES:
            raise ValueError("Provide a nonempty bounded readiness marker")
        deadline = time.monotonic() + timeout_s
        while not all(marker in tail for tail in self.tails):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                tails = [tail[-512:] for tail in self.tails]
                raise TimeoutError(f"PTY startup marker missing; bounded output tails: {tails!r}")
            self.drain(min(0.05, remaining))
        self._alive()

    def drain(
        self,
        duration_s: float,
        *,
        bytes_per_s: float | None = None,
        tick: Callable[[PtyFleet], None] | None = None,
    ) -> Drain:
        """Fairly drain for a bounded window, optionally injecting input at each poll.

        Parameters:
            duration_s (float): positive monotonic window.
            bytes_per_s (float | None): aggregate cap across all children, not per PTY.
            tick (Callable[[PtyFleet], None] | None): bounded caller input callback.

        Returns:
            Drain: actual per-child delivery; callers must reject missing expected output.
        """
        _positive(duration_s)
        if bytes_per_s is not None:
            _positive(bytes_per_s)
        self._alive()
        before = tuple(self.counts)
        started = time.monotonic()
        deadline = started + duration_s
        next_read = started if bytes_per_s is None else started + CHUNK / bytes_per_s
        while time.monotonic() < deadline:
            self._alive()
            if tick is not None:
                tick(self)
            now = time.monotonic()
            if now < next_read:
                time.sleep(min(POLL_S, next_read - now, max(0, deadline - now)))
                continue
            ready = select.select(self.masters, [], [], min(POLL_S, max(0, deadline - now)))[0]
            for offset in range(len(self.masters)):
                index = (self.cursor + offset) % len(self.masters)
                fd = self.masters[index]
                if fd not in ready:
                    continue
                delivered = self._read(index, CHUNK)
                self.cursor = (index + 1) % len(self.masters)
                if bytes_per_s is not None:
                    next_read = time.monotonic() + delivered / bytes_per_s
                break
        self._alive()
        return Drain(
            tuple(a - b for a, b in zip(self.counts, before, strict=True)),
            time.monotonic() - started,
        )

    def _read(self, index: int, budget: int) -> int:
        """Read one fair quantum, refusing closed PTYs and preserving other OS errors."""
        try:
            data = os.read(self.masters[index], budget)
        except BlockingIOError:
            return 0
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            raise RuntimeError(f"PTY child '{index}' closed output") from error
        if not data:
            raise RuntimeError(f"PTY child '{index}' closed output")
        self.counts[index] += len(data)
        self.tails[index] = (self.tails[index] + data)[-TAIL_BYTES:]
        return len(data)
