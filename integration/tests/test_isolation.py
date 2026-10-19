"""Pure prefixture benchmark/live admission checks, never a benchmark run."""

from __future__ import annotations

import pytest

from harness.isolation import admit_serial_tier, process_tag


def test_process_tags_have_disjoint_worker_slots_and_exact_width() -> None:
    tags = [process_tag(worker, nonce) for worker in ("master", "gw0", "gw1") for nonce in (0, 99999)]
    assert len(set(tags)) == 6
    assert all(len(str(tag)) == 9 for tag in tags)
    assert process_tag("master", 99999) < process_tag("gw0", 0)
    assert process_tag("gw0", 99999) < process_tag("gw1", 0)
    for worker, nonce in (("other", 0), ("gw999", 0), ("master", -1), ("master", 100000)):
        with pytest.raises(ValueError, match=r"worker|overflow"):
            process_tag(worker, nonce)


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
