"""Tests for the shared `contract_helpers.FifoWitness` timeout path."""

from __future__ import annotations

import os
from pathlib import Path

from contract_helpers import FifoWitness


def test_fifo_witness_waits_time_out_while_the_writer_holds_the_fifo(tmp_path: Path) -> None:
    """A connected writer is not started until it writes, and not gone while it holds the FIFO open.

    Parameters:
        tmp_path (Path): Writer working directory.

    Returns:
        None: `started` times out before the byte; `gone` times out after it, with the writer still open.
    """
    with FifoWitness(tmp_path) as witness:
        writer = os.open(witness.path, os.O_WRONLY | os.O_NONBLOCK)
        try:
            assert not witness.started(0.05)
            assert witness.started_at is None
            os.write(writer, b"x")
            assert witness.started(1)
            assert not witness.gone(0.05)
        finally:
            os.close(writer)
