"""Account Istanbul and V8 statements from `coverage-summary.json` and lock them at zero.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import ROOT, policy, setup_report, statement_policy, write_summary

from coverage_accounting import Policy, account, check_ratchet, signal_comparisons

PRODUCER_MISSING = "Statement producer missing"


def errors_of(tmp_path: Path, cfg: Policy) -> list[str]:
    """Account the fixture and return only the failure messages.

    Parameters:
        tmp_path (Path): Disposable report root.
        cfg (Policy): Fixture policy.
    Returns:
        list[str]: Accounting failures.
    Raises:
        None.
    """
    return account(tmp_path, cfg)[1]


def test_covered_lines_do_not_hide_an_uncovered_statement(tmp_path: Path) -> None:
    """Fail an enforced signal with 0 uncovered lines and 1 uncovered statement.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The LCOV is clean, the summary is one statement short, and the gate fails.
    Raises:
        AssertionError: The statement regression reads as green.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=3, covered=2)
    errors = errors_of(tmp_path, statement_policy(0))
    assert len(errors) == 1
    assert "1 statements uncovered" in errors[0]
    assert errors_of(tmp_path, statement_policy(1)) == []


def test_fully_covered_statements_pass_and_are_reported(tmp_path: Path) -> None:
    """Carry statement totals into every file record and the signal comparison.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Per-file results hold `statements`/`uncovered_statements`; the delta is signed.
    Raises:
        AssertionError: Statements are dropped from the summary data.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=3, covered=2)
    results, errors = account(tmp_path, statement_policy(1))
    assert errors == []
    assert [(r["statements"], r["uncovered_statements"]) for r in results] == [(3, 1)]
    totals = {"example/primary": {"uncovered_lines": 0, "uncovered_functions": 0, "uncovered_statements": 1}}
    comparison = signal_comparisons(statement_policy(1), totals, sys.platform)["example/primary"]
    assert comparison["reference"] == {"lines": 0, "functions": 0, "statements": 1}
    assert comparison["delta"] == {"lines": 0, "functions": 0, "statements": 0}


def test_relative_summary_keys_resolve_against_the_package_root(tmp_path: Path) -> None:
    """Match a summary keyed by a package-relative path to the LCOV record.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The relative key is accepted.
    Raises:
        AssertionError: Relative keys are not matched.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=3, covered=3, key="src/index.ts")
    assert errors_of(tmp_path, statement_policy(0)) == []


def test_summary_from_another_checkout_is_matched_by_repository_path(tmp_path: Path) -> None:
    """Replay a summary whose absolute keys name the producing runner's checkout, as the fan-in does.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The repository-relative suffix matches; a lookalike package does not.
    Raises:
        AssertionError: Cross-runner replay fails or matches the wrong file.
    """
    setup_report(tmp_path)
    write_summary(
        tmp_path, total=3, covered=2, key="/Users/runner/work/repo/repo/packages/example/src/index.ts"
    )
    results, errors = account(tmp_path, statement_policy(1))
    assert errors == []
    assert [r["uncovered_statements"] for r in results] == [1]
    write_summary(
        tmp_path, total=3, covered=3, key="/Users/runner/work/repo/repo/packages/other-example/src/index.ts"
    )
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert "Statements missing for source: 'src/index.ts'" in error


def test_ambiguous_summary_suffixes_fail(tmp_path: Path) -> None:
    """Refuse to guess between two producing checkouts' entries for one source.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Two suffix matches are an error.
    Raises:
        AssertionError: One entry silently wins.
    """
    setup_report(tmp_path)
    counter = {"statements": {"total": 1, "covered": 1}}
    document = {
        "total": counter,
        "/a/packages/example/src/index.ts": counter,
        "/b/packages/example/src/index.ts": counter,
    }
    (tmp_path / "packages/example/coverage/coverage-summary.json").write_text(json.dumps(document))
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert "Ambiguous statement summary source: 'packages/example/src/index.ts'" in error


def test_a_producer_that_stops_writing_the_summary_fails(tmp_path: Path) -> None:
    """Fail closed rather than read a missing summary as zero uncovered statements.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: A missing summary is an error.
    Raises:
        AssertionError: The signal passes without a summary.
    """
    setup_report(tmp_path)
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert PRODUCER_MISSING in error


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ("not json", "Malformed statement summary"),
        ("[]", "no `total` entry"),
        ('{"total": {}}', "Empty statement summary"),
        ('{"total": {}, "/x": {"statements": {"total": 1}}}', "Malformed statement counter"),
        ('{"total": {}, "/x": {"statements": {"total": 1, "covered": 2}}}', "Inconsistent statement counter"),
        ('{"total": {}, "/x": {"statements": {"total": true, "covered": 1}}}', "Malformed statement counter"),
    ],
)
def test_malformed_summaries_fail(tmp_path: Path, document: str, message: str) -> None:
    """Reject truncated or inconsistent summaries.

    Parameters:
        tmp_path (Path): Disposable report root.
        document (str): Summary content.
        message (str): Expected failure text.
    Returns:
        None: Each malformed summary fails accounting.
    Raises:
        AssertionError: A malformed summary is accepted.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/coverage/coverage-summary.json").write_text(document)
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert message in error


def test_duplicate_summary_sources_fail(tmp_path: Path) -> None:
    """Reject two summary keys that resolve to one file.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The duplicate is an error.
    Raises:
        AssertionError: The duplicate is accepted.
    """
    setup_report(tmp_path)
    counter = {"statements": {"total": 1, "covered": 1}}
    document = {"total": counter, "src/index.ts": counter, "src/../src/index.ts": counter}
    (tmp_path / "packages/example/coverage/coverage-summary.json").write_text(json.dumps(document))
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert "Duplicate statement summary source" in error


def test_a_source_missing_from_the_summary_fails(tmp_path: Path) -> None:
    """Fail when the LCOV names a source the summary lacks.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The gap is an error, not zero statements.
    Raises:
        AssertionError: The file is read as having no statements.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=3, covered=3, key=str(tmp_path / "packages/example/src/other.ts"))
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert "Statements missing for source: 'src/index.ts'" in error


def test_a_summary_without_statements_fails(tmp_path: Path) -> None:
    """Reject a summary whose every file has zero statements.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: A report with lines but no statements fails closed.
    Raises:
        AssertionError: The signal reads as clean.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=0, covered=0)
    (error,) = errors_of(tmp_path, statement_policy(0))
    assert PRODUCER_MISSING in error


def test_cap_and_reporter_must_move_together(tmp_path: Path) -> None:
    """Require the cap, the `json-summary` reporter and the target to agree.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Every half-declared signal fails.
    Raises:
        AssertionError: A half-declared signal passes.
    """
    setup_report(tmp_path)
    write_summary(tmp_path, total=3, covered=3)
    (error,) = errors_of(tmp_path, statement_policy(None))
    assert "Missing statement cap" in error
    (error,) = errors_of(tmp_path, statement_policy(0, reporters=["text", "lcov"]))
    assert PRODUCER_MISSING in error
    required = statement_policy(None, reporters=["text", "lcov"])
    (error,) = errors_of(tmp_path, required)
    assert "Missing statement cap" in error


def test_coverage_py_and_report_only_signals_carry_no_statement_cap(tmp_path: Path) -> None:
    """Keep coverage.py (statements are lines) and report-only signals out of the requirement.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Both carve-outs pass with `target.statements` locked.
    Raises:
        AssertionError: A carve-out is wrongly required to declare statements.
    """
    setup_report(tmp_path)
    data = statement_policy(None, producer="coverage.py", reporters=["text", "lcov"]).model_dump(
        exclude_none=True
    )
    assert errors_of(tmp_path, Policy.model_validate(data)) == []
    data = statement_policy(0).model_dump(exclude_none=True)
    data["packages"]["example"]["signals"]["bun"] = {
        "report": "coverage/lcov.info",
        "files": ["src/index.ts"],
        "max_uncovered": {sys.platform: {"lines": 0, "functions": 0}},
        "reporters": ["text", "lcov"],
        "enforcement": "report-only",
        "reason": "Fixture.",
    }
    write_summary(tmp_path, total=3, covered=3)
    assert errors_of(tmp_path, Policy.model_validate(data)) == []


def test_target_statements_must_be_zero() -> None:
    """Keep the statement target zero.

    Parameters:
        None.
    Returns:
        None: A nonzero statement target is rejected.
    Raises:
        AssertionError: The declaration validates.
    """
    data = policy().model_dump()
    data["target"]["statements"] = 1
    with pytest.raises(ValidationError, match="branches and statements"):
        Policy.model_validate(data)


def test_ratchet_rejects_raising_or_dropping_a_statement_cap() -> None:
    """Keep statement caps and the target monotonic, like branches.

    Parameters:
        None.
    Returns:
        None: Raising or dropping a cap, or dropping the target key, fails; lowering passes.
    Raises:
        AssertionError: A statement cap can be weakened.
    """
    base = statement_policy(1)
    for weaker in (statement_policy(2), statement_policy(None)):
        with pytest.raises(ValueError, match="Ratchet violation"):
            check_ratchet(weaker, base)
    check_ratchet(statement_policy(0), base)
    check_ratchet(base, statement_policy(None))
    unlocked = statement_policy(1)
    unlocked.target.statements = None
    with pytest.raises(ValueError, match="Cannot loosen the target"):
        check_ratchet(unlocked, base)


def test_shipped_policy_locks_every_enforced_vitest_signal() -> None:
    """Give each enforced Istanbul/V8 signal `json-summary` and a statement cap; lock 100-percent ones at 0.

    Parameters:
        None.
    Returns:
        None: The repository policy declares statements wherever its producers can write them.
    Raises:
        AssertionError: A signal lacks the reporter or cap, or a 100-percent cap is nonzero.
    """
    shipped = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    assert shipped.target.statements == 0
    for name, package in shipped.packages.items():
        for signal_name, signal in package.signals.items():
            label = f"{name}/{signal_name}"
            counted = signal.enforcement == "enforced" and signal.producer == "lcov"
            assert ("json-summary" in signal.reporters) == counted, label
            for runner_os, cap in signal.max_uncovered.items():
                assert (cap.statements is not None) == counted, f"{label}/{runner_os}"
                if counted and package.goal == "100-percent":
                    assert cap.statements == 0, f"{label}/{runner_os}"
