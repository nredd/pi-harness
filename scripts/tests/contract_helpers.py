"""Shared scaffolding for per-package stock-contract scenario tests.

References:
    https://docs.pytest.org/en/stable/how-to/monkeypatch.html
"""

from __future__ import annotations

import os
import select
import sys
import time
from pathlib import Path
from types import TracebackType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import package_contracts as pc


class StubProvider:
    """Minimal provider context exposing one recorded request."""

    def __init__(self, tools: list[str]) -> None:
        """Record a model request exposing `tools`.

        Parameters:
            tools (list[str]): Tool names the fake model received.
        """
        self.requests = [fp.RecordedRequest("m", ("user",), tuple(tools), "", route=None)]

    def __enter__(self) -> StubProvider:
        """Enter the inert provider context.

        Returns:
            StubProvider: This provider.
        """
        return self

    def __exit__(self, *_args: object) -> None:
        """Leave the inert provider context.

        Parameters:
            *_args (object): Context-manager exception arguments.
        """
        return


class NoRequestProvider(StubProvider):
    """Provider context that never received a model request."""

    def __init__(self) -> None:
        """Record no requests."""
        self.requests = []


def make_context(tmp_path: Path, contract: pc.PackageContract, version: str) -> pc.Context:
    """Create the smallest scenario context for `contract`.

    Parameters:
        tmp_path (Path): Test scratch root.
        contract (pc.PackageContract): Package under test.
        version (str): Packed artifact version.

    Returns:
        pc.Context: Context with a disposable sandbox and package artifact.
    """
    work = tmp_path / "work"
    work.mkdir()
    return pc.Context(
        Path("pi"),
        pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()),
        tmp_path / "installed",
        pc.PackedArtifact(contract, tmp_path / "package.tgz", version, "sha512-x", "0" * 40, 1, ()),
        work,
        (),
    )


# Bounded self-exit, so a regressed runner cannot leave this writer behind: `FifoWitness` checks finish
# well inside it, and nothing ever signals a PID that could have been reused.
WITNESS_EXIT_S = 20


class FifoWitness:
    """FIFO whose only writer is the process under test: EOF proves every writer exited.

    The writer opens `alive.fifo` in its working directory, writes one byte, then lives at most
    `WITNESS_EXIT_S` seconds. No PID is probed or signalled.
    """

    PYTHON_WRITER = (
        f"import os, time; os.write(os.open('alive.fifo', os.O_WRONLY), b'x'); time.sleep({WITNESS_EXIT_S})"
    )
    NODE_WRITER = (
        "const fs = require('node:fs'); fs.writeSync(fs.openSync('alive.fifo', 'w'), 'x'); "
        f"setTimeout(() => process.exit(0), {WITNESS_EXIT_S * 1000});"
    )

    def __init__(self, directory: Path) -> None:
        """Create the FIFO and open its non-blocking reader before any writer starts.

        Parameters:
            directory (Path): Writer's working directory.
        """
        self.path = directory / "alive.fifo"
        os.mkfifo(self.path)
        self.reader = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK)
        self.created_at = time.monotonic()

    def __enter__(self) -> FifoWitness:
        """Return the open witness.

        Returns:
            FifoWitness: This witness.
        """
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the reader; a surviving writer still exits on its own bound.

        Parameters:
            exc_type (type[BaseException] | None): Exception type, if any.
            exc (BaseException | None): Exception, if any.
            traceback (TracebackType | None): Traceback, if any.
        """
        os.close(self.reader)

    def _read(self, seconds: float) -> bytes | None:
        """Read one byte, or `None` if nothing arrives in `seconds`.

        Parameters:
            seconds (float): Wait bound.

        Returns:
            bytes | None: One byte, `b""` at EOF, or `None` on timeout.
        """
        if not select.select([self.reader], [], [], seconds)[0]:
            return None
        return os.read(self.reader, 1)

    def started(self, seconds: float = 10) -> bool:
        """Whether the writer opened the FIFO and wrote its byte within `seconds`.

        Parameters:
            seconds (float): Wait bound.

        Returns:
            bool: True once the writer's byte arrived.
        """
        return self._read(seconds) == b"x"

    def gone(self, seconds: float = 5) -> bool:
        """Whether every writer closed the FIFO, by exiting, within `seconds`.

        Parameters:
            seconds (float): Wait bound, well under `WITNESS_EXIT_S`.

        Returns:
            bool: True at EOF, if it came within half the writer's own exit bound of creating the
                FIFO, so the writer's self-exit cannot be mistaken for a kill.
        """
        eof = self._read(seconds) == b""
        return eof and time.monotonic() - self.created_at < WITNESS_EXIT_S / 2
