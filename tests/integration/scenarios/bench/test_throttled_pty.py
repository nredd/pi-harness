"""Separate synthetic PTY pressure experiment, never a replacement for existing baselines.

References:
- https://github.com/nredd/pi-harness/issues/977
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

import pytest

from harness.pty_bench import AGGREGATE_CAP, calibrate, run_cell

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)
pytestmark = [pytest.mark.bench, pytest.mark.slow]


def test_throttled_pty_fleet(sandbox: Sandbox, template_home: Path) -> None:
    """Calibrate real writer pressure and record paired 1/4/8 interactive Pi cells."""
    result = {"calibration": calibrate(sandbox.root / "calibration"), "cells": []}
    out = sandbox.root / "throttled-pty.json"
    out.write_text(json.dumps(result, indent=2))
    LOGGER.info(f"Synthetic PTY calibration: {json.dumps(result['calibration'])}")
    for count in (1, 4, 8):
        for cap in (None, AGGREGATE_CAP):
            result["cells"].append(run_cell(sandbox.root / f"pty-{count}-{cap}", template_home, count, cap))
            out.write_text(json.dumps(result, indent=2))
    LOGGER.info(f"Synthetic PTY observations: '{out}'\n{json.dumps(result)}")
