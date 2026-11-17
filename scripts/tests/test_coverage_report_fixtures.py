"""Reproduce the real fan-in summaries of one hosted run through the presentation interface.

The retained fixtures are trimmed copies (see `fixtures/coverage-report/provenance.json`): every signal and
its totals are real, only a handful of per-file rows per signal are kept. The original row counts live here
as constants so "reproduces the real counts" stays checkable without retaining ~33k pretty-printed lines.

References:
    https://github.com/nredd/pi-harness/actions/runs/44104072624
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as report

DIRECTORY = Path(__file__).parent / "fixtures/coverage-report"
HEAD = "a8622f3551585ac84f9edc840bf684f86cd9e43b"
# host -> (signals, original file rows, enforced signals), from the original artifacts of run 44104072624.
REAL = {"ubuntu-24.04": (36, 735, 34), "macos-14": (37, 744, 35), "wsl2": (32, 663, 31)}


def test_provenance_sidecar_matches_constants_and_fixtures() -> None:
    """The sidecar names the original run and artifacts, and the retained bytes match their recorded hash.

    Parameters:
        None.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    sidecar = json.loads((DIRECTORY / "provenance.json").read_text())
    assert sidecar["run_id"] == 44104072624
    assert sidecar["head_and_tested_sha"] == HEAD
    for host, (signals, rows, _) in REAL.items():
        entry = sidecar["artifacts"][host]
        assert (entry["original_signals"], entry["original_file_rows"]) == (signals, rows)
        retained = (DIRECTORY / f"coverage-{host}.json").read_bytes()
        assert hashlib.sha256(retained).hexdigest() == entry["fixture_sha256"]
        assert len(retained) < 100_000


@pytest.mark.parametrize("host", sorted(REAL))
def test_real_fan_in_counts(host: str) -> None:
    """Every real signal total renders independently, without aggregation, for each OS.

    Parameters:
        host (str): Artifact host.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    signals, _, enforced = REAL[host]
    raw: Any = report.read_summary(DIRECTORY / f"coverage-{host}.json")
    summary = report.Summary.parse(raw)
    assert len(summary.packages) == signals
    assert summary.errors == ()
    uncovered_rows = [f for f in summary.files if any(u for _, _, u in f.counters.values)]
    # The original WSL artifact has no uncovered file row at all; the other two keep real ones.
    assert bool(uncovered_rows) is (host != "wsl2")
    declaration = {
        "state": "available",
        "signals": {
            name: {
                "enforcement": meta["enforcement"],
                "reason": meta["reason"],
                "semantics": "fixture-run-44104072624",
                "state": "planned",
            }
            for name, meta in summary.signals.items()
        },
    }
    cell = report.Evidence.parse(host, declaration, summary)
    provenance = report.Provenance("nredd/pi-harness", HEAD, HEAD, 44104072624, 1)
    rendered = report.render_markdown((cell,), provenance)
    assert len(rendered) <= 60_000
    assert f"{enforced}/{enforced} zero uncovered" in rendered
    assert "REPORT-ONLY (outside headline)" in rendered
    for name, counters in summary.packages.items():
        for metric, total, uncovered in counters.values:
            assert raw["packages"][name][metric] == total
            assert raw["packages"][name][f"uncovered_{metric}"] == uncovered
        assert f"{report.escape(name)} | {counters.cells()}" in rendered
    assert "1605/1605 (0) | 282/282 (0) | 1534/1534 (0) | 1975/1975 (0)" in rendered
