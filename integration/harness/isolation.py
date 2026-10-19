"""Prefixture admission for serial, explicitly quiet benchmarks and cost-capped live tests.

References:
- https://pytest-xdist.readthedocs.io/en/stable/distribution.html
"""

from __future__ import annotations

import os


def admit_serial_tier(tier: str, workers: int | str | None, *, quiet: bool, load: float, cpus: int) -> None:
    """Reject expensive or shared-state tiers before package installation or process creation.

    Parameters:
        tier (str): `bench` or `live`.
        workers (int | str | None): xdist worker request, zero/None for serial.
        quiet (bool): explicitly identified quiet benchmark runner.
        load (float): one-minute load average.
        cpus (int): logical CPU count.

    Raises:
        ValueError: parallel live/bench, unidentified bench runner or excessive load.
    """
    if workers not in {None, 0, "0"}:
        raise ValueError(f"`{tier}` is serial; remove xdist workers")
    if tier != "bench":
        return
    if not quiet:
        raise ValueError("Bench NOT RUN: requires explicit `PI_BENCH_QUIET_RUNNER=1`, never a hosted runner")
    if cpus < 1 or load / cpus > 0.5:
        raise ValueError(f"Bench runner is busy: load={load}, cpus={cpus}")


def check_tier(tier: str, workers: int | str | None) -> None:
    """Apply real runner admission, independently testable through pure `admit_serial_tier`.

    Parameters:
        tier (str): selected serial tier.
        workers (int | str | None): configured workers.
    """
    admit_serial_tier(
        tier,
        workers,
        quiet=os.environ.get("PI_BENCH_QUIET_RUNNER") == "1",
        load=os.getloadavg()[0],
        cpus=os.cpu_count() or 1,
    )
