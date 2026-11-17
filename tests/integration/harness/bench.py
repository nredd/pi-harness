"""Benchmarks: median of N samples, compared against `baselines/bench.<system>.json`.

Baselines are per OS (`darwin`, `linux`); they only mean something on the machine that recorded them.

A metric fails when its median exceeds the baseline by more than `REGRESSION_THRESHOLD`.
`UPDATE_BASELINES=1` records the current medians instead of comparing.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
from typing import TYPE_CHECKING

from harness.paths import BASELINES_PATH, environment_meta

if TYPE_CHECKING:
    from collections.abc import Callable

LOGGER = logging.getLogger(__name__)

META_KEY = "_meta"
SAMPLES = 5
REGRESSION_THRESHOLD = 0.20


def measure(sample: Callable[[], float], samples: int = SAMPLES) -> float:
    """Return the median of `samples` calls to `sample`.

    Parameters:
        sample (Callable[[], float]): one measurement, lower is better.
        samples (int): number of runs.

    Returns:
        float: median.

    Raises:
        ValueError: `samples` is not positive.
    """
    if samples < 1:
        raise ValueError(f"`samples` must be positive, got '{samples}'")
    return statistics.median(sample() for _ in range(samples))


def measure_many(sample: Callable[[], dict[str, float]], samples: int = SAMPLES) -> dict[str, float]:
    """Return the per-metric median of `samples` calls that each measure several metrics.

    Parameters:
        sample (Callable[[], dict[str, float]]): one run, metric name -> value, lower is better.
        samples (int): number of runs.

    Returns:
        dict[str, float]: metric name -> median.

    Raises:
        ValueError: `samples` is not positive, or the runs reported different metrics.
    """
    if samples < 1:
        raise ValueError(f"`samples` must be positive, got '{samples}'")
    runs = [sample() for _ in range(samples)]
    names = set(runs[0])
    if any(set(run) != names for run in runs):
        raise ValueError(f"Runs reported different metrics: {[sorted(run) for run in runs]}")
    return {name: statistics.median(run[name] for run in runs) for name in sorted(names)}


def check_against_baseline(metric: str, value: float) -> None:
    """Fail when `value` regressed past the stored baseline, or record it when updating.

    Parameters:
        metric (str): baseline key, e.g. `startup_first_frame_s`.
        value (float): measured median.

    Raises:
        AssertionError: no baseline exists, or the regression exceeds the threshold.
    """
    LOGGER.info(f"Measured `{metric}`: {value:.4f}")
    baselines = json.loads(BASELINES_PATH.read_text()) if BASELINES_PATH.is_file() else {}
    if os.environ.get("UPDATE_BASELINES") == "1":
        baselines[metric] = round(value, 4)
        baselines[META_KEY] = environment_meta()
        BASELINES_PATH.parent.mkdir(parents=True, exist_ok=True)
        BASELINES_PATH.write_text(json.dumps(baselines, indent=2, sort_keys=True) + "\n")
        return
    recorded = baselines.get(META_KEY)
    if recorded is not None and recorded.get("wsl") != environment_meta()["wsl"]:
        LOGGER.warning(f"Baselines were recorded with wsl={recorded.get('wsl')}, this run differs")
    if metric not in baselines:
        raise AssertionError(
            f"No baseline for `{metric}`; run with UPDATE_BASELINES=1 (measured {value:.3f})"
        )
    baseline = float(baselines[metric])
    limit = baseline * (1 + REGRESSION_THRESHOLD)
    assert value <= limit, f"`{metric}` regressed: {value:.3f} > {limit:.3f} (baseline {baseline:.3f} + 20%)"


def check_ceiling(metric: str, value: float, ceiling: float) -> None:
    """Fail when `value` exceeds a fixed `ceiling`; for ratios and rates that need no baseline.

    The same bound holds on every OS and machine, so it is not stored in a baseline file.

    Parameters:
        metric (str): name, for the message.
        value (float): measured value.
        ceiling (float): inclusive upper bound.

    Raises:
        AssertionError: `value` is above `ceiling`.
    """
    assert value <= ceiling, f"`{metric}` is {value:.3f}, above its ceiling {ceiling:.3f}"
