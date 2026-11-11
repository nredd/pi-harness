"""Hold per-OS uncovered floors, the global target and the base budget ratchet.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import (
    FIXTURES,
    ROOT,
    SCRIPT,
    branch_policy,
    policy,
    setup_report,
)

from coverage_accounting import (
    Package,
    Policy,
    account,
    check_ratchet,
    git_read,
    signal_comparisons,
)


@pytest.mark.parametrize(("cap", "errors"), [(1, []), (2, [])])
def test_branch_cap_met(tmp_path: Path, cap: int, errors: list[str]) -> None:
    """Pass a signal whose uncovered branches are at or under its cap.

    Parameters:
        tmp_path (Path): Disposable report root.
        cap (int): Cap at or above the one uncovered branch.
        errors (list[str]): Expected accounting errors.
    Returns:
        None: The measured branch counter is reported and accepted.
    Raises:
        AssertionError: A branch count within its cap fails.
    """
    setup_report(tmp_path, "branches.info")
    results, actual = account(tmp_path, branch_policy(cap))
    assert actual == errors
    assert (results[0]["branches"], results[0]["uncovered_branches"]) == (2, 1)


def test_measure_without_platform_reference(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Measure a producer before its platform reference is declared.

    Parameters:
        tmp_path (Path): Disposable report root.
        caplog (pytest.LogCaptureFixture): Captured accounting log.
    Returns:
        None: Measurement succeeds without a reference or reference log.
    Raises:
        AssertionError: The unreferenced measurement fails or logs a reference.
    """
    setup_report(tmp_path, "branches.info")
    cfg = branch_policy(1)
    signal = cfg.packages["example"].signals["primary"]
    signal.max_uncovered.pop(sys.platform)
    caplog.set_level(logging.INFO)
    results, errors = account(tmp_path, cfg, measure=True)
    assert not errors
    assert results[0]["uncovered_branches"] == 1
    assert "reference lines=" not in caplog.text


def test_branch_cap_exceeded(tmp_path: Path) -> None:
    """Fail an enforced signal on one uncovered branch over its cap, naming every counter.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The failure names measured and budgeted branches next to lines and functions.
    Raises:
        AssertionError: A branch-only excess passes or the message drops a counter.
    """
    setup_report(tmp_path, "branches.info")
    assert account(tmp_path, branch_policy(0))[1] == [
        "example/primary: Budget exceeded: 0 lines, 0 functions, 1 branches uncovered, "
        "budget 0 lines, 0 functions, 0 branches"
    ]


def test_branch_records_without_cap_fail(tmp_path: Path) -> None:
    """Require a cap on every signal whose producer emits branch records.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: An uncapped branch-producing signal fails.
    Raises:
        AssertionError: Branch records go ungated for lack of a cap.
    """
    setup_report(tmp_path, "branches.info")
    assert account(tmp_path, policy())[1] == [
        "example/primary: Missing branch cap: the report has 2 branch records"
    ]


def test_enforced_excluded_signal_needs_a_branch_cap(tmp_path: Path) -> None:
    """Require a branch cap once an owner-excluded signal is enforced (#645).

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The enforced excluded signal without a cap fails; with a cap it passes.
    Raises:
        AssertionError: Enforcement on an excluded goal skips the branch cap.
    """
    setup_report(tmp_path, "branches.info")
    for cap, expected in (
        (None, ["example/primary: Missing branch cap: the report has 2 branch records"]),
        (1, []),
    ):
        cfg = branch_policy(cap, goal="excluded", goal_reason="Owner decision.")
        cfg.packages["example"].signals["primary"].enforcement = "enforced"
        assert account(tmp_path, cfg)[1] == expected


def test_excluded_goal_needs_no_branch_cap(tmp_path: Path) -> None:
    """Accept uncapped branch records only for a report-only owner-excluded signal.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: The excluded package reports its branches and passes without a cap.
    Raises:
        AssertionError: The excluded carve-out is missing or widened.
    """
    setup_report(tmp_path, "branches.info")
    results, errors = account(tmp_path, branch_policy(None, goal="excluded", goal_reason="Owner decision."))
    assert not errors
    assert results[0]["uncovered_branches"] == 1
    _, errors = account(tmp_path, branch_policy(None, goal="report-only", goal_reason="Fixture."))
    assert errors == ["example/primary: Missing branch cap: the report has 2 branch records"]


def test_branch_cap_without_branch_records_fails_closed(tmp_path: Path) -> None:
    """Reject a capped signal whose report has lines but no `BRDA` rows.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: A producer that stopped emitting branches can't read as zero uncovered.
    Raises:
        AssertionError: A branchless report passes a branch cap.
    """
    setup_report(tmp_path)
    assert account(tmp_path, branch_policy(0))[1] == [
        "example/primary: Branch producer missing: "
        "a branch cap is declared but the report has no BRDA records"
    ]


def test_report_only_branch_delta_is_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Log a report-only signal's branch reference and signed delta without gating it.

    Parameters:
        tmp_path (Path): Disposable report root.
        caplog (pytest.LogCaptureFixture): Captured accounting log.
    Returns:
        None: The over-reference branch count is logged and the JSON delta carries it.
    Raises:
        AssertionError: A report-only branch excess fails or goes unreported.
    """
    setup_report(tmp_path, "branches.info")
    cfg = branch_policy(0, goal="report-only", goal_reason="Fixture.")
    caplog.set_level(logging.INFO)
    results, errors = account(tmp_path, cfg)
    assert not errors
    assert (
        "reference lines=0, functions=0, branches=0; delta lines=+0, functions=+0, branches=+1" in caplog.text
    )
    totals = {"example/primary": {key: value for key, value in results[0].items() if isinstance(value, int)}}
    assert signal_comparisons(cfg, totals, sys.platform)["example/primary"]["delta"] == {
        "lines": 0,
        "functions": 0,
        "branches": 1,
    }
    uncapped = signal_comparisons(policy(), totals, sys.platform)["example/primary"]
    assert uncapped["reference"] == {"lines": 0, "functions": 0}
    assert uncapped["delta"] == {"lines": 0, "functions": 0}


@pytest.mark.parametrize(("target", "cap", "error"), [(None, 1, False), (None, 0, True), (0, 1, True)])
def test_global_target_uses_signal_branch_cap_until_target_is_set(
    tmp_path: Path, target: int | None, cap: int, error: bool
) -> None:
    """Gate a 100-percent primary on its own branch cap until `target.branches` locks it.

    Parameters:
        tmp_path (Path): Disposable report root.
        target (int | None): `target.branches`, unset while caps are being driven down.
        cap (int): The primary signal's branch cap.
        error (bool): Whether the one uncovered branch fails.
    Returns:
        None: The signal cap applies while the target is unset; a set target overrides it.
    Raises:
        AssertionError: The target ignores the branch cap or a set target is bypassed.
    """
    setup_report(tmp_path, "branches.info")
    cfg = branch_policy(cap)
    cfg.enforce_target = True
    cfg.target.branches = target
    assert bool(account(tmp_path, cfg)[1]) == error


def test_repository_target_holds_primaries_at_zero_branches_despite_stale_cap(tmp_path: Path) -> None:
    """Hold a 100-percent primary at 0 uncovered branches under the repository's own target.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: One uncovered branch fails even though the signal's cap is stale at 1.
    Raises:
        AssertionError: `coverage/policy.json` leaves `target.branches` unset or the cap wins.
    """
    shipped = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    assert shipped.target.branches == 0
    setup_report(tmp_path, "branches.info")
    cfg = branch_policy(1)
    cfg.enforce_target = True
    cfg.target = shipped.target
    assert account(tmp_path, cfg)[1] == [
        "example/primary: Budget exceeded: 0 lines, 0 functions, 1 branches uncovered, "
        "budget 0 lines, 0 functions, 0 branches"
    ]


def test_ratchet_rejects_raising_or_removing_a_branch_cap() -> None:
    """Keep branch caps monotonic: no raise, no removing a key the base had.

    Parameters:
        None.
    Returns:
        None: Raising or dropping a cap fails, lowering or adding one passes.
    Raises:
        AssertionError: A branch cap can be weakened.
    """
    base = branch_policy(1)
    for weaker in (branch_policy(2), policy()):
        with pytest.raises(ValueError, match="Ratchet violation"):
            check_ratchet(weaker, base)
    check_ratchet(branch_policy(0), base)
    check_ratchet(base, policy())
    locked = policy()
    locked.target.branches = 0
    with pytest.raises(ValueError, match="Cannot loosen the target"):
        check_ratchet(policy(), locked)
    check_ratchet(locked, policy())


def test_branch_target_must_be_zero() -> None:
    """Keep the branch target zero.

    Parameters:
        None.
    Returns:
        None: A nonzero branch target is rejected.
    Raises:
        AssertionError: The declaration validates.
    """
    data = policy().model_dump()
    data["target"]["branches"] = 1
    with pytest.raises(ValidationError, match="zero uncovered lines, functions and branches"):
        Policy.model_validate(data)


@pytest.mark.parametrize("metric", ["lines", "functions"])
def test_ratchet_cannot_increase_uncovered_budget(metric: str) -> None:
    """Keep each integer budget independently monotonic.

    Parameters:
        metric (str): Budget counter to increase.
    Returns:
        None: Raising the budget fails while tightening it succeeds.
    Raises:
        AssertionError: The base budget can be weakened.
    """
    current, base = policy(), policy()
    setattr(current.packages["example"].signals["primary"].max_uncovered[sys.platform], metric, 1)
    with pytest.raises(ValueError, match="Ratchet violation"):
        check_ratchet(current, base)
    check_ratchet(base, current)


def test_ratchet_cannot_remove_a_signal_or_package() -> None:
    """Reject removal of measured packages and signals.

    Parameters:
        None.
    Returns:
        None: Removing either accounting boundary fails.
    Raises:
        AssertionError: A measured package or signal can disappear.
    """
    current = policy()
    current.packages.clear()
    with pytest.raises(ValueError, match="Removed package"):
        check_ratchet(current, policy())
    current = policy()
    current.packages["example"].signals.clear()
    with pytest.raises(ValueError, match="Removed signal"):
        check_ratchet(current, policy())


def test_ratchet_allows_removing_a_pending_package() -> None:
    """Let a measurement-pending inventory go once its sources are measured elsewhere.

    A pending package has no signals, so no budget can be lost; its source membership is still
    guarded by `check_inventory_ratchet`, which demands a `reclassifications` entry per file.

    Parameters:
        None.
    Returns:
        None: Dropping a pending package passes the budget ratchet.
    Raises:
        AssertionError: A pending package cannot be retired after its sources graduate.
    """
    base = policy()
    base.packages["pending"] = Package.model_validate(
        {
            "root": "pending",
            "owned": ["*.ts"],
            "exclusions": [],
            "status": "pending",
            "note": "Later.",
            "signals": {},
        }
    )
    check_ratchet(policy(), base)


def test_global_flip_requires_no_uncovered_or_pending(tmp_path: Path) -> None:
    """Reject gaps and pending packages when the final target is enabled.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: The policy-only flip enforces the primary target.
    Raises:
        AssertionError: Transitional gaps can satisfy the final target.
    """
    setup_report(tmp_path, "uncovered.info")
    cfg = policy()
    cfg.packages["example"].signals["primary"].max_uncovered[sys.platform].lines = 1
    cfg.packages["example"].signals["primary"].max_uncovered[sys.platform].functions = 1
    assert not account(tmp_path, cfg)[1]
    cfg.enforce_target = True
    assert account(tmp_path, cfg)[1]
    cfg.packages["example"].status = "pending"
    cfg.packages["example"].signals.clear()
    assert "Unmeasured package" in account(tmp_path, cfg)[1][0]


def test_cli_uses_real_git_base_and_always_writes_summary(tmp_path: Path) -> None:
    """Read ratchet budgets from an actual committed Git policy.

    Parameters:
        tmp_path (Path): Disposable Git repository.
    Returns:
        None: The CLI rejects a budget increase and writes its summary.
    Raises:
        AssertionError: The Git base is bypassed or failure artifacts disappear.
    """
    setup_report(tmp_path)
    (tmp_path / "coverage").mkdir()
    path = tmp_path / "coverage/policy.json"
    cfg = policy()
    path.write_text(cfg.model_dump_json())
    for argv in [
        ["init", "-q", "--template="],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-qm",
            "Base policy",
        ],
    ]:
        git_read(tmp_path, argv)
    cfg.packages["example"].signals["primary"].max_uncovered[sys.platform].lines = 1
    path.write_text(cfg.model_dump_json())
    summary = tmp_path / "summary.json"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(tmp_path), "--base", "HEAD", "--summary", str(summary)],
        check=False,
        capture_output=True,
    )
    assert result.returncode == 1
    assert "Ratchet violation" in json.loads(summary.read_text())["errors"][0]


def test_cli_measure_proposes_branch_caps(tmp_path: Path) -> None:
    """Propose a branch cap from a branch-producing report and none from a branchless one.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: The measured floors and the logged policy diff carry branches only where measured.
    Raises:
        AssertionError: `--measure` drops measured branches or invents a cap.
    """
    report = setup_report(tmp_path, "branches.info")
    (tmp_path / "coverage").mkdir()
    (tmp_path / "coverage/policy.json").write_text(policy().model_dump_json())
    git_read(tmp_path, ["init", "-q", "--template="])
    git_read(tmp_path, ["add", "."])
    for fixture, floor in (("branches.info", {"branches": 1}), ("passing.info", {})):
        shutil.copyfile(FIXTURES / fixture, report)
        summary = tmp_path / f"{fixture}.json"
        argv = ["--root", str(tmp_path), "--measure", "--os", sys.platform, "--summary", str(summary)]
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *argv], check=True, capture_output=True, text=True
        )
        floors = json.loads(summary.read_text())["measured_floors"]["example/primary"][sys.platform]
        assert floors == {"lines": 0, "functions": 0} | floor
        assert bool(re.search(r'^\+\s+"branches": 1$', result.stderr, re.MULTILINE)) == bool(floor)


def test_global_primary_target_does_not_replace_independent_runtime_ratchet(tmp_path: Path) -> None:
    """Keep a runtime ratchet independent of the final primary target.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: The runtime signal retains its own budget.
    Raises:
        AssertionError: Independent runtime counters are merged or retargeted.
    """
    report = setup_report(tmp_path)
    runtime = report.with_name("runtime.info")
    shutil.copyfile(FIXTURES / "uncovered.info", runtime)
    cfg = policy()
    runtime_signal = cfg.packages["example"].signals["primary"].model_copy(deep=True)
    runtime_signal.report = "coverage/runtime.info"
    runtime_signal.max_uncovered[sys.platform].lines = 1
    runtime_signal.max_uncovered[sys.platform].functions = 1
    cfg.packages["example"].signals["runtime"] = runtime_signal
    cfg.enforce_target = True
    results, errors = account(tmp_path, cfg)
    assert not errors
    assert {row["signal"] for row in results} == {"primary", "runtime"}


def test_ratchet_rejects_adding_skipped_hosts() -> None:
    """Keep `skip_hosts` from becoming a way to exempt a host after the fact.

    Parameters:
        None.
    Returns:
        None: Widening the skipped set against the base policy fails; shrinking it passes.
    Raises:
        AssertionError: A new skipped host is accepted.
    """
    base, current = policy(), policy()
    current.packages["example"].signals["primary"].skip_hosts = ["wsl2"]
    with pytest.raises(ValueError, match="Cannot add skipped hosts"):
        check_ratchet(current, base)
    check_ratchet(base, current)


def test_ratchet_rejects_changing_a_signal_producer_gate() -> None:
    """Keep `gate` from becoming a way to exempt a signal that already has a base.

    Parameters:
        None.
    Returns:
        None: Adding, changing or dropping the gate against the base policy fails.
    Raises:
        AssertionError: A changed producer gate is accepted.
    """
    base, current = policy(), policy()
    current.packages["example"].signals["primary"].gate = "check-benchmark"
    with pytest.raises(ValueError, match="Cannot change a signal's producer gate"):
        check_ratchet(current, base)
    with pytest.raises(ValueError, match="Cannot change a signal's producer gate"):
        check_ratchet(base, current)
    check_ratchet(current, current)


@pytest.mark.parametrize(
    ("fixture", "lines", "functions"), [("function-only.info", 0, 1), ("line-only.info", 1, 0)]
)
def test_independent_counter_budget_is_enforced(
    tmp_path: Path, fixture: str, lines: int, functions: int
) -> None:
    """Catch deletion of either metric predicate independently of the other.

    Parameters:
        tmp_path (Path): Disposable report/source root.
        fixture (str): LCOV with exactly one failing metric.
        lines (int): Expected uncovered lines.
        functions (int): Expected uncovered functions.
    Returns:
        None: The independently exceeded budget fails with exact integer diagnostics.
    Raises:
        AssertionError: Either uncovered metric stops being enforced.
    """
    setup_report(tmp_path, fixture)
    results, errors = account(tmp_path, policy())
    assert results[0]["uncovered_lines"] == lines
    assert results[0]["uncovered_functions"] == functions
    assert errors == [
        f"example/primary: Budget exceeded: {lines} lines, {functions} functions uncovered, "
        "budget 0 lines, 0 functions"
    ]
