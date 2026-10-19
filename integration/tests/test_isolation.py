"""Pure prefixture benchmark/live admission checks, never a benchmark run."""

from __future__ import annotations

import pytest

from harness.isolation import admit_serial_tier


@pytest.mark.parametrize("tier", ["bench", "live"])
@pytest.mark.parametrize("workers", [2, "auto", "logical"])
def test_shared_state_tiers_refuse_parallel(tier: str, workers: int | str) -> None:
    with pytest.raises(ValueError, match="serial"):
        admit_serial_tier(tier, workers, quiet=True, load=0, cpus=8)


def test_bench_refuses_unidentified_or_busy_runner() -> None:
    with pytest.raises(ValueError, match="NOT RUN"):
        admit_serial_tier("bench", None, quiet=False, load=0, cpus=8)
    with pytest.raises(ValueError, match="busy"):
        admit_serial_tier("bench", None, quiet=True, load=5, cpus=8)
    admit_serial_tier("bench", 0, quiet=True, load=1, cpus=8)
    admit_serial_tier("live", None, quiet=False, load=100, cpus=1)
