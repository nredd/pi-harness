"""Tests for the shared `contract_helpers.FifoWitness` timeout path."""

from __future__ import annotations

import os
from pathlib import Path

from contract_helpers import FifoWitness


def test_fifo_witness_times_out_while_a_silent_writer_holds_the_fifo(tmp_path: Path) -> None:
    """A writer that is connected but silent is neither started nor gone within the bound.

    Parameters:
        tmp_path (Path): Writer working directory.

    Returns:
        None: Both waits report `False` after their short timeout.
    """
    with FifoWitness(tmp_path) as witness:
        writer = os.open(witness.path, os.O_WRONLY | os.O_NONBLOCK)
        try:
            assert not witness.started(0.05)
            assert witness.started_at is None
            assert not witness.gone(0.05)
        finally:
            os.close(writer)
