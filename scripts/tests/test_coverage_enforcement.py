"""Verify report-only signals retain fail-closed evidence and reviewed enforcement changes.

References:
    ../../docs/coverage.md
    https://github.com/nredd/pi-harness/issues/160
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import (
    EnforcementChange,
    Policy,
    account,
    check_inventory_ratchet,
    check_ratchet,
    signal_comparisons,
)
from tests.test_coverage_accounting import FIXTURES, SCRIPT, policy, setup_report
from tests.test_coverage_round2 import commit_base

ROOT = Path(__file__).resolve().parents[2]
REASON = (
    "Compatibility subset until the full source-complete port: https://github.com/nredd/pi-harness/issues/160"
)


def report_only_policy(root: Path, fixture: str = "uncovered.info") -> Policy:
    """Create passing primary coverage and an independently uncovered Bun report.

    Parameters:
        root (Path): Disposable source/report root.
        fixture (str): Real LCOV fixture for the Bun signal.
    Returns:
        Policy: Validated enforced primary and reasoned report-only Bun declarations.
    Raises:
        OSError: Reports cannot be written.
        ValidationError: Fixture policy is invalid.
    """
    primary = setup_report(root)
    shutil.copyfile(FIXTURES / fixture, primary.with_name("bun.info"))
    data = policy().model_dump()
    data["packages"]["example"]["signals"]["bun"] = data["packages"]["example"]["signals"]["primary"] | {
        "report": "coverage/bun.info",
        "enforcement": "report-only",
        "reason": REASON,
    }
    return Policy.model_validate(data)


@pytest.mark.parametrize("fixture", ["uncovered.info", "function-only.info", "line-only.info"])
@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
@pytest.mark.parametrize("global_target", [False, True])
def test_report_only_excess_and_deltas(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, fixture: str, runner_os: str, global_target: bool
) -> None:
    """Report excess without gating it, including with the global primary target enabled.

    Parameters:
        tmp_path (Path): Disposable source/report root.
        caplog (pytest.LogCaptureFixture): Captured accounting logs.
        fixture (str): LCOV with independently uncovered counters.
        runner_os (str): OS whose stored reference is compared.
        global_target (bool): Whether the final primary zero target is enabled.
    Returns:
        None: Excess counts, references and signed deltas remain visible without failure.
    Raises:
        AssertionError: Report-only excess is gated or its diagnostics disappear.
    """
    cfg = report_only_policy(tmp_path, fixture)
    cfg.enforce_target = global_target
    caplog.set_level(logging.INFO, logger="coverage_accounting")
    results, errors = account(tmp_path, cfg, runner_os)
    assert not errors
    row = next(row for row in results if row["signal"] == "bun")
    assert row["uncovered_lines"] or row["uncovered_functions"]
    assert "(report-only)" in caplog.text
    assert "reference lines=0, functions=0; delta lines=" in caplog.text
    comparisons = signal_comparisons(
        cfg, {"example/bun": {"uncovered_lines": 1, "uncovered_functions": 1}}, runner_os
    )
    assert comparisons["example/bun"] == {
        "enforcement": "report-only",
        "reason": REASON,
        "reference": {"lines": 0, "functions": 0},
        "delta": {"lines": 1, "functions": 1},
    }


@pytest.mark.parametrize(
    "failure", ["missing", "empty", "malformed", "absent-file", "partial-report", "unknown", "missing-os"]
)
def test_report_only_still_fails_closed(tmp_path: Path, failure: str) -> None:
    """Never turn missing or invalid compatibility evidence into successful coverage.

    Parameters:
        tmp_path (Path): Disposable source/report root.
        failure (str): Report or reference failure to introduce.
    Returns:
        None: The specific Bun signal fails independently of its report-only budget.
    Raises:
        AssertionError: Report-only mode suppresses validation failures.
    """
    cfg = report_only_policy(tmp_path)
    report = tmp_path / "packages/example/coverage/bun.info"
    if failure == "missing":
        report.unlink()
    elif failure == "empty":
        report.write_text("")
    elif failure == "malformed":
        report.write_text(report.read_text().replace("LF:2", "LF:3"))
    elif failure == "absent-file":
        report.write_text(report.read_text().replace("src/index.ts", "test/helper.ts"))
    elif failure == "partial-report":
        (tmp_path / "packages/example/src/other.ts").write_text("export const other = 1;\n")
        primary = report.with_name("lcov.info")
        primary.write_text(primary.read_text() + primary.read_text().replace("src/index.ts", "src/other.ts"))
        cfg.packages["example"].signals["primary"].files = None
        cfg.packages["example"].signals["bun"].files = ["src/index.ts", "src/other.ts"]
    elif failure == "unknown":
        report.write_text(report.read_text().replace("src/index.ts", "src/unknown.ts"))
    else:
        cfg.packages["example"].signals["bun"].max_uncovered.clear()
    _, errors = account(tmp_path, cfg)
    assert len(errors) == 1
    assert errors[0].startswith("example/bun:")
    if failure in {"absent-file", "partial-report"}:
        assert "Expected files missing" in errors[0]


@pytest.mark.parametrize("fixture", ["uncovered.info", "function-only.info", "line-only.info"])
def test_enforced_signal_still_rejects_excess(tmp_path: Path, fixture: str) -> None:
    """Keep both integer predicates enforced when a signal explicitly opts in.

    Parameters:
        tmp_path (Path): Disposable source/report root.
        fixture (str): LCOV with independently uncovered counters.
    Returns:
        None: Enforced compatibility budgets fail on uncovered execution.
    Raises:
        AssertionError: Report-only behavior leaks into an enforced signal.
    """
    cfg = report_only_policy(tmp_path, fixture)
    cfg.packages["example"].signals["bun"].enforcement = "enforced"
    assert "example/bun: Budget exceeded" in account(tmp_path, cfg)[1][0]


def test_enforcement_downgrade_requires_new_entry(tmp_path: Path) -> None:
    """Distinguish a standing signal reason from an explicit base-relative downgrade.

    Parameters:
        tmp_path (Path): Disposable real LCOV/source root.
    Returns:
        None: A missing entry fails; a fresh reasoned entry authorizes only this downgrade.
    Raises:
        AssertionError: A standing note or historical entry silently weakens enforcement.
    """
    current = report_only_policy(tmp_path)
    base = current.model_copy(deep=True)
    base.packages["example"].signals["bun"].enforcement = "enforced"
    with pytest.raises(ValueError, match="Enforcement downgrade requires"):
        check_ratchet(current, base)
    entry = EnforcementChange(package="example", signal="bun", reason=REASON)
    current.enforcement_changes = [entry]
    check_ratchet(current, base)
    base.enforcement_changes = [entry.model_copy(deep=True)]
    with pytest.raises(ValueError, match="Enforcement downgrade requires"):
        check_ratchet(current, base)


@pytest.mark.parametrize("invalid", ["duplicate", "stale"])
def test_downgrade_entries_are_exact(tmp_path: Path, invalid: str) -> None:
    """Reject duplicate and unrelated entries instead of granting blanket waivers.

    Parameters:
        tmp_path (Path): Disposable LCOV/source root.
        invalid (str): Invalid change-ledger declaration to introduce.
    Returns:
        None: Invalid ledger declarations fail closed.
    Raises:
        AssertionError: An unrelated or ambiguous declaration authorizes enforcement loss.
    """
    current = report_only_policy(tmp_path)
    base = current.model_copy(deep=True)
    base.packages["example"].signals["bun"].enforcement = "enforced"
    entry = EnforcementChange(package="example", signal="bun", reason=REASON)
    current.enforcement_changes = (
        [entry, entry]
        if invalid == "duplicate"
        else [EnforcementChange(package="unknown", signal="bun", reason=REASON)]
    )
    with pytest.raises(ValueError, match="Duplicate or stale"):
        check_ratchet(current, base)


@pytest.mark.parametrize("reason", ["", "   "])
def test_report_only_and_downgrade_reasons_are_mandatory(reason: str) -> None:
    """Require separate substantive explanations for report-only status and downgrades.

    Parameters:
        reason (str): Empty or whitespace-only explanation.
    Returns:
        None: Both serialized declarations reject blank reasons.
    Raises:
        AssertionError: A report-only signal or downgrade lacks its mandatory reason.
    """
    data = policy().model_dump()
    signal = data["packages"]["example"]["signals"]["primary"]
    signal |= {"enforcement": "report-only", "reason": reason}
    with pytest.raises(ValidationError, match="nonblank"):
        Policy.model_validate(data)
    with pytest.raises(ValidationError):
        EnforcementChange(package="example", signal="bun", reason=reason)


def test_primary_cannot_be_report_only() -> None:
    """Keep the final 100-percent goal attached to enforced primary signals.

    Parameters:
        None.
    Returns:
        None: A reason cannot waive primary enforcement.
    Raises:
        AssertionError: Primary coverage can be made advisory by editing policy.
    """
    data = policy().model_dump()
    data["packages"]["example"]["signals"]["primary"] |= {"enforcement": "report-only", "reason": REASON}
    with pytest.raises(ValidationError, match="Primary signals must remain enforced"):
        Policy.model_validate(data)


def test_initial_introduction_and_enforcement_promotion(tmp_path: Path) -> None:
    """Allow new advisory signals and later full-source enforcement without fake history.

    Parameters:
        tmp_path (Path): Disposable LCOV/source root.
    Returns:
        None: New signals and report-only-to-enforced promotions establish their own budgets.
    Raises:
        AssertionError: An initial signal is mistaken for an enforcement downgrade.
    """
    current = report_only_policy(tmp_path)
    check_ratchet(current, policy())
    base = current.model_copy(deep=True)
    current.packages["example"].signals["bun"].enforcement = "enforced"
    for budget in current.packages["example"].signals["bun"].max_uncovered.values():
        budget.lines = 1
        budget.functions = 1
    check_ratchet(current, base)
    assert not account(tmp_path, current)[1]


def test_enforced_bun_requires_complete_source_inventory(tmp_path: Path) -> None:
    """Do not promote a partial source subset into an enforced Bun measurement.

    Parameters:
        tmp_path (Path): Disposable two-source LCOV fixture root.
    Returns:
        None: Enforcing only a subset fails even with valid LCOV for that subset.
    Raises:
        AssertionError: Partial Bun inventory can represent complete enforced coverage.
    """
    cfg = report_only_policy(tmp_path, "passing.info")
    primary = tmp_path / "packages/example/coverage/lcov.info"
    (tmp_path / "packages/example/src/other.ts").write_text("export const other = 1;\n")
    primary.write_text(primary.read_text() + primary.read_text().replace("src/index.ts", "src/other.ts"))
    cfg.packages["example"].signals["primary"].files = None
    cfg.packages["example"].signals["bun"].enforcement = "enforced"
    assert account(tmp_path, cfg)[1] == [
        "example/bun: Enforced Bun signal must measure every owned executable file"
    ]


def test_report_only_reference_is_not_a_budget_ratchet(tmp_path: Path) -> None:
    """Keep advisory references editable while retaining OS membership and inventory checks.

    Parameters:
        tmp_path (Path): Disposable LCOV/source root.
    Returns:
        None: Changed references pass, but losing an OS declaration still fails.
    Raises:
        AssertionError: Advisory references act as budgets or bypass declared OS membership.
    """
    base = report_only_policy(tmp_path)
    current = base.model_copy(deep=True)
    for budget in current.packages["example"].signals["bun"].max_uncovered.values():
        budget.lines = 100
    check_ratchet(current, base)
    current.packages["example"].signals["bun"].max_uncovered.clear()
    with pytest.raises(ValueError, match="Missing OS floor"):
        check_ratchet(current, base)


def test_cli_report_only_summary_and_immutable_base(tmp_path: Path) -> None:
    """Run real Git-base gating and retain advisory deltas in its JSON summary.

    Parameters:
        tmp_path (Path): Disposable Git/source/report root.
    Returns:
        None: Advisory excess exits zero and exposes exact reference deltas.
    Raises:
        AssertionError: CLI suppresses validation or fails report-only excess.
    """
    cfg = report_only_policy(tmp_path)
    commit_base(tmp_path, cfg)
    summary = tmp_path / "summary.json"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(tmp_path), "--base", "HEAD", "--summary", str(summary)],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
    data = json.loads(summary.read_text())
    assert data["signals"]["example/bun"]["delta"] == {"lines": 1, "functions": 1}
    assert data["signals"]["example/primary"]["enforcement"] == "enforced"


def test_report_only_retains_inventory_ratchet(tmp_path: Path) -> None:
    """Reject disappearing compatibility source even when budget excess is advisory.

    Parameters:
        tmp_path (Path): Disposable Git/source root with real LCOV.
    Returns:
        None: A report-only subset cannot silently drop previous source membership.
    Raises:
        AssertionError: Advisory budget mode disables the immutable-tree inventory ratchet.
    """
    base = report_only_policy(tmp_path)
    (tmp_path / "packages/example/src/other.ts").write_text("export const other = 1;\n")
    base.packages["example"].signals["bun"].files = ["src/index.ts", "src/other.ts"]
    commit_base(tmp_path, base)
    current = base.model_copy(deep=True)
    current.packages["example"].signals["bun"].files = ["src/index.ts"]
    with pytest.raises(ValueError, match="Inventory ratchet"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")


def test_report_only_keeps_both_reporters(tmp_path: Path) -> None:
    """Keep the pinned LCOV-only threshold-bypass defense independent of budget mode.

    Parameters:
        tmp_path (Path): Disposable source/report root.
    Returns:
        None: A report-only signal still rejects LCOV-only producer declarations.
    Raises:
        AssertionError: Report-only mode permits the known reporter bypass.
    """
    data = report_only_policy(tmp_path).model_dump()
    data["packages"]["example"]["signals"]["bun"]["reporters"] = ["lcov"]
    with pytest.raises(ValidationError, match="both text and lcov"):
        Policy.model_validate(data)


def test_cli_downgrade_against_real_base_requires_entry(tmp_path: Path) -> None:
    """Exercise downgrade authorization through the real Git-base CLI path.

    Parameters:
        tmp_path (Path): Disposable committed policy and real LCOV fixtures.
    Returns:
        None: Missing downgrade entries fail; a new reasoned entry authorizes report-only excess.
    Raises:
        AssertionError: The CLI omits its enforcement-transition ratchet.
    """
    current = report_only_policy(tmp_path)
    base = current.model_copy(deep=True)
    base.packages["example"].signals["bun"].enforcement = "enforced"
    commit_base(tmp_path, base)
    summary = tmp_path / "summary.json"
    for authorized in [False, True]:
        current.enforcement_changes = (
            [EnforcementChange(package="example", signal="bun", reason=REASON)] if authorized else []
        )
        (tmp_path / "coverage/policy.json").write_text(current.model_dump_json())
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(tmp_path),
                "--base",
                "HEAD",
                "--summary",
                str(summary),
            ],
            capture_output=True,
            check=False,
        )
        assert result.returncode == (0 if authorized else 1), result.stderr.decode()
        errors = json.loads(summary.read_text())["errors"]
        if not authorized:
            assert "Enforcement downgrade requires" in errors[0]
        else:
            assert not errors


def test_current_bun_policy_is_explicit_and_links_migration() -> None:
    """Keep every current Bun signal explicitly advisory until its source-complete port.

    Parameters:
        None.
    Returns:
        None: All current Bun declarations carry an explicit mode and #160 rationale.
    Raises:
        AssertionError: A current signal silently defaults to enforcement or lacks its reason.
    """
    data = json.loads((ROOT / "coverage/policy.json").read_text())
    signals = [pkg["signals"]["bun"] for pkg in data["packages"].values() if "bun" in pkg["signals"]]
    assert len(signals) == 8
    for signal in signals:
        assert signal["enforcement"] == "report-only"
        assert "https://github.com/nredd/pi-harness/issues/160" in signal["reason"]
        assert "enforced" in signal["reason"]
