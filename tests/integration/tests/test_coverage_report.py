"""Reproduce real fan-in summaries through the presentation interface.

References:
    https://github.com/nredd/pi-harness/actions/runs/44104072624
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/coverage_report.py"
SPEC = importlib.util.spec_from_file_location("coverage_report", SCRIPT)
assert SPEC is not None
assert SPEC.loader is not None
report = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = report
SPEC.loader.exec_module(report)
FIXTURES = Path(__file__).parent / "fixtures/coverage-report"


@pytest.mark.parametrize(
    ("host", "signals", "files"), [("ubuntu-24.04", 36, 735), ("macos-14", 37, 744), ("wsl2", 32, 663)]
)
def test_real_fan_in_counts(host: str, signals: int, files: int) -> None:
    """Reproduce every measured counter independently without trimming source fixtures.

    Parameters:
        host (str): Boundary input.
        signals (int): Boundary input.
        files (int): Boundary input.

    Returns:
        None: The boundary contract is satisfied.

    Raises:
        AssertionError: The boundary contract regresses.
    """
    raw = report.read_summary(FIXTURES / f"coverage-{host}.json")
    summary = report.Summary.parse(raw)
    assert len(summary.packages) == signals
    assert len(summary.files) == files
    assert summary.errors == ()
    declaration = {
        "state": "available",
        "signals": {
            name: {
                "enforcement": meta["enforcement"],
                "reason": meta["reason"],
                "semantics": "fixture-exact-run-44104072624",
                "state": "planned",
            }
            for name, meta in summary.signals.items()
        },
    }
    cell = report.Evidence.parse(host, declaration, summary)
    provenance = report.Provenance(
        "nredd/pi-harness",
        "a8622f3551585ac84f9edc840bf684f86cd9e43b",
        "a8622f3551585ac84f9edc840bf684f86cd9e43b",
        44104072624,
        1,
    )
    rendered = report.render_markdown((cell,), provenance)
    assert len(rendered) <= 60_000
    enforced = {"ubuntu-24.04": 34, "macos-14": 35, "wsl2": 31}[host]
    assert f"{enforced}/{enforced} zero uncovered" in rendered
    assert "1605/1605 (0) | 282/282 (0) | 1534/1534 (0) | 1975/1975 (0)" in rendered
    for name, counters in summary.packages.items():
        for metric, total, uncovered in counters.values:
            assert raw["packages"][name][metric] == total
            assert raw["packages"][name][f"uncovered_{metric}"] == uncovered
        assert f"{report.escape(name)} | {counters.cells()}" in rendered
    assert "REPORT-ONLY (outside headline)" in rendered
    assert "vs policy reference" in rendered
    assert "</details>" in rendered
