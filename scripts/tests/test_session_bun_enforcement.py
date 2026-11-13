"""Exercise the session-kit Bun zero-floor contract through production accounting.

References:
    ../../docs/coverage.md
    https://github.com/nredd/pi-harness/issues/836
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import ROOT, setup_report, write_summary

from coverage_accounting import Policy, account, inventory


def bun_policy() -> Policy:
    """Build the shipped Bun signal on a disposable inventory.

    Parameters:
        None.
    Returns:
        Policy: Miniature policy retaining the shipped signal and floors.
    Raises:
        ValidationError: The shipped declaration is invalid.
    """
    shipped = json.loads((ROOT / "coverage/policy.json").read_text())
    signal = shipped["packages"]["session-kit"]["signals"]["bun"]
    signal["report"] = "coverage/lcov.info"
    return Policy.model_validate(
        {
            "version": 2,
            "target": {"lines": 0, "functions": 0, "branches": 0, "statements": 0},
            "enforce_target": True,
            "packages": {
                "example": {
                    "root": "packages/example",
                    "owned": ["src/*.ts"],
                    "exclusions": [],
                    "status": "measured",
                    "note": "",
                    "signals": {"primary": signal, "bun": signal},
                }
            },
        }
    )


@pytest.mark.parametrize(
    "failure", ["line", "function", "branch", "statement", "source", "map", "summary", "unknown"]
)
def test_bun_zero_floor_rejects_missing_and_uncovered(tmp_path: Path, failure: str) -> None:
    """Reject each independent missing or uncovered Bun accounting input.

    Parameters:
        tmp_path (Path): Disposable report root.
        failure (str): Counter or producer to mutate.
    Returns:
        None: The Bun signal rejects the mutation.
    Raises:
        AssertionError: An invalid report passes.
    """
    report = setup_report(tmp_path, "branches.info")
    clean = report.read_text().replace("BRDA:1,0,1,0", "BRDA:1,0,1,1").replace("BRH:1", "BRH:2")
    report.write_text(clean)
    write_summary(tmp_path, total=2, covered=2)
    cfg = bun_policy()
    assert inventory(tmp_path, cfg.packages["example"]) == {"src/index.ts"}
    assert account(tmp_path, cfg)[1] == []
    if failure == "line":
        report.write_text(clean.replace("DA:2,1", "DA:2,0").replace("LH:2", "LH:1"))
    elif failure == "function":
        report.write_text(clean.replace("FNDA:1,answer", "FNDA:0,answer").replace("FNH:1", "FNH:0"))
    elif failure == "branch":
        report.write_text(clean.replace("BRDA:1,0,1,1", "BRDA:1,0,1,0").replace("BRH:2", "BRH:1"))
    elif failure == "statement":
        write_summary(tmp_path, total=2, covered=1)
    elif failure == "source":
        (tmp_path / "packages/example/src/other.ts").write_text("export const other = 1;\n")
    elif failure == "map":
        report.unlink()
    elif failure == "summary":
        (report.parent / "coverage-summary.json").unlink()
    else:
        report.write_text(clean.replace("BRDA:1,0,1,1", "BRDA:1,0,1,-").replace("BRH:2", "BRH:1"))
    assert any(error.startswith("example/bun:") for error in account(tmp_path, cfg)[1])


def test_bun_branchless_source_is_not_unknown(tmp_path: Path) -> None:
    """Accept a legitimate B0 record without treating unknown branches as covered.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: A branchless source remains valid alongside measured branches.
    Raises:
        AssertionError: Branchless coverage is rejected or miscounted.
    """
    report = setup_report(tmp_path, "branches.info")
    clean = report.read_text().replace("BRDA:1,0,1,0", "BRDA:1,0,1,1").replace("BRH:1", "BRH:2")
    (tmp_path / "packages/example/src/other.ts").write_text("export const other = 1;\n")
    branchless = clean.replace("src/index.ts", "src/other.ts")
    branchless = "\n".join(
        line for line in branchless.split("\n") if not line.startswith(("BRDA:", "BRF:", "BRH:"))
    )
    report.write_text(clean + branchless)
    summary = write_summary(tmp_path, total=2, covered=2)
    document = json.loads(summary.read_text())
    document[str(tmp_path / "packages/example/src/other.ts")] = document[
        str(tmp_path / "packages/example/src/index.ts")
    ]
    summary.write_text(json.dumps(document))
    cfg = bun_policy()
    rows, errors = account(tmp_path, cfg)
    assert not errors
    branchless_row = next(
        row for row in rows if row["signal"] == "bun" and str(row["file"]).endswith("other.ts")
    )
    assert branchless_row["branches"] == 0
    assert branchless_row["uncovered_branches"] == 0
