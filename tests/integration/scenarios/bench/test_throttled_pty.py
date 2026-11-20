"""Separate synthetic PTY pressure experiment, never a replacement for existing baselines.

References:
- https://github.com/nredd/pi-harness/issues/977
"""

from __future__ import annotations

import json
import logging
import warnings
from typing import TYPE_CHECKING

import pytest

from harness.pty_bench import (
    AGGREGATE_CAP,
    FLEET_SIZES,
    NOT_RUN,
    NOT_RUN_LABEL,
    calibrate,
    publish_report,
    run_cell,
)

if TYPE_CHECKING:
    from pathlib import Path

    from harness.pty_bench import FleetReport
    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)
pytestmark = [pytest.mark.bench, pytest.mark.slow]


def test_throttled_pty_fleet(sandbox: Sandbox, template_home: Path) -> None:
    """Calibrate real writer pressure and record paired 1/4/8 interactive Pi cells."""
    result: FleetReport = {"calibration": calibrate(sandbox.root / "calibration"), "cells": []}
    out = sandbox.root / "throttled-pty.json"
    publish_report(out, result)
    LOGGER.info(f"Synthetic PTY calibration: {json.dumps(result['calibration'])}")
    for count in FLEET_SIZES:
        for cap in (None, AGGREGATE_CAP):
            cell = run_cell(sandbox.root / f"pty-{count}-{cap}", template_home, count, cap)
            result["cells"].append(cell)
            publish_report(out, result)
            if cell.get("status") == NOT_RUN:
                warnings.warn(
                    pytest.PytestWarning(f"{NOT_RUN_LABEL}: {cell.get('reason')}"),
                    stacklevel=1,
                )
    LOGGER.info(f"Synthetic PTY observations: '{out}'\n{json.dumps(result)}")
