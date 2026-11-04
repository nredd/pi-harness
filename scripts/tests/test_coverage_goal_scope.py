"""Keep owner-approved goal scope separate from mandatory source/report accounting.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError
from test_coverage_accounting import policy, setup_report

from coverage_accounting import Counts, Policy, account, check_ratchet, inventory

ROOT = Path(__file__).resolve().parents[2]

# Uncovered (lines, functions) measured on `primary` by CI run 41767456760 (darwin) and 41773210529 (linux).
VERIFICATION_FLOORS = {
    "probes": {"darwin": (0, 0), "linux": (0, 0)},
}


def report_only_policy() -> Policy:
    """Return a reasoned verification-only policy with the global goal enabled.

    Parameters:
        None.
    Returns:
        Policy: Validated report-only fixture policy.
    Raises:
        ValidationError: The fixture declaration is invalid.
    """
    data = policy().model_dump()
    data["enforce_target"] = True
    package = data["packages"]["example"]
    package["goal"] = "report-only"
    package["goal_reason"] = "Verification-only fixture, outside the owned package goal."
    package["signals"]["primary"]["enforcement"] = "report-only"
    package["signals"]["primary"]["reason"] = "Diagnostic verification coverage."
    return Policy.model_validate(data)


def test_report_only_primary_still_validates_missing_reports(tmp_path: Path) -> None:
    """Require reports outside the global goal, without enforcing uncovered counters.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Uncovered diagnostics pass and a missing report fails closed.
    Raises:
        AssertionError: Diagnostics enforce budgets or waive report validation.
    """
    report = setup_report(tmp_path, "passing.info")
    report.write_text(report.read_text().replace("DA:1,1", "DA:1,0").replace("LH:2", "LH:1"))
    cfg = report_only_policy()
    assert not account(tmp_path, cfg)[1]
    report.unlink()
    assert account(tmp_path, cfg)[1]


def test_excluded_pending_inventory_does_not_block_target(tmp_path: Path) -> None:
    """Keep excluded source visible without inventing measurements or blocking the goal.

    Parameters:
        tmp_path (Path): Disposable source root.
    Returns:
        None: Excluded pending source passes; eligible pending source fails.
    Raises:
        AssertionError: Pending scope is ignored or misapplied.
    """
    setup_report(tmp_path)
    data = report_only_policy().model_dump()
    package = data["packages"]["example"]
    package |= {"goal": "excluded", "status": "pending", "note": "Owner exclusion.", "signals": {}}
    assert not account(tmp_path, Policy.model_validate(data))[1]
    package |= {"goal": "100-percent", "goal_reason": ""}
    assert "Unmeasured package" in account(tmp_path, Policy.model_validate(data))[1][0]


def test_goal_downgrade_cannot_bypass_base_ratchet() -> None:
    """Reject removal of eligible packages from an established global goal.

    Parameters:
        None.
    Returns:
        None: A scope downgrade cannot waive an enforced or pending package.
    Raises:
        AssertionError: The base goal can be silently weakened.
    """
    data = policy().model_dump()
    data["packages"]["example"] |= {"status": "pending", "note": "Awaiting clean producer.", "signals": {}}
    previous = Policy.model_validate(data)
    data["packages"]["example"] |= {"goal": "excluded", "goal_reason": "Attempt to bypass pending source."}
    with pytest.raises(ValueError, match="Cannot remove package from global goal"):
        check_ratchet(Policy.model_validate(data), previous)


def test_goal_exceptions_require_reason_and_report_only_signals() -> None:
    """Reject blank scope explanations and enforced signals outside the goal.

    Parameters:
        None.
    Returns:
        None: Invalid scope declarations fail schema validation.
    Raises:
        AssertionError: Invalid declarations pass schema validation.
    """
    data = report_only_policy().model_dump()
    package = data["packages"]["example"]
    package["goal_reason"] = " "
    with pytest.raises(ValidationError, match="goal_reason"):
        Policy.model_validate(data)
    package["goal_reason"] = "Verification infrastructure."
    package["signals"]["primary"]["enforcement"] = "enforced"
    with pytest.raises(ValidationError, match="outside the global goal"):
        Policy.model_validate(data)


def ratchet_policy(lines: int = 1, functions: int = 1) -> Policy:
    """Return an enforced nonzero-floor package outside the zero target.

    Parameters:
        lines (int): Uncovered-line floor on every OS.
        functions (int): Uncovered-function floor on every OS.
    Returns:
        Policy: Validated `ratchet` fixture with the global target enabled.
    Raises:
        ValidationError: The fixture declaration is invalid.
    """
    data = policy().model_dump()
    data["enforce_target"] = True
    package = data["packages"]["example"]
    package["goal"] = "ratchet"
    package["goal_reason"] = "Owner-approved downward ratchet at measured floors."
    package["signals"]["primary"]["max_uncovered"] = {
        host: {"lines": lines, "functions": functions} for host in ("darwin", "linux")
    }
    return Policy.model_validate(data)


def test_ratchet_goal_enforces_its_nonzero_floor_not_the_zero_target(tmp_path: Path) -> None:
    """Hold the measured floor exactly: at it passes, above it fails, even with the target enabled.

    Parameters:
        tmp_path (Path): Disposable report root with one uncovered line and function.
    Returns:
        None: The floor, not the zero target, is the budget in both directions.
    Raises:
        AssertionError: A regression passes or the zero target replaces the floor.
    """
    setup_report(tmp_path, "uncovered.info")
    assert not account(tmp_path, ratchet_policy(1, 1))[1]
    for lines, functions in ((0, 1), (1, 0)):
        errors = account(tmp_path, ratchet_policy(lines, functions))[1]
        assert "Budget exceeded: 1 lines, 1 functions" in errors[0]


def test_ratchet_floor_only_goes_down() -> None:
    """Allow a lower floor, reject a higher one, and refuse to leave the mode.

    Parameters:
        None.
    Returns:
        None: Floors ratchet per counter and the package cannot leave `ratchet`.
    Raises:
        AssertionError: A floor is raised or the goal is downgraded.
    """
    base = ratchet_policy(5, 5)
    check_ratchet(ratchet_policy(4, 5), base)
    check_ratchet(ratchet_policy(5, 5), base)
    for lines, functions in ((6, 5), (5, 6)):
        with pytest.raises(ValueError, match="Ratchet violation"):
            check_ratchet(ratchet_policy(lines, functions), base)
    data = ratchet_policy(5, 5).model_dump()
    data["packages"]["example"]["goal"] = "report-only"
    data["packages"]["example"]["signals"]["primary"]["enforcement"] = "report-only"
    data["packages"]["example"]["signals"]["primary"]["reason"] = "Downgrade attempt."
    enforcement = {
        "enforcement_changes": [{"package": "example", "signal": "primary", "reason": "Downgrade."}]
    }
    with pytest.raises(ValueError, match="Cannot remove package from global goal"):
        check_ratchet(Policy.model_validate(data | enforcement), base)


def test_ratchet_may_graduate_to_the_zero_target() -> None:
    """Allow the one upward move: a ratchet package joining the 100-percent goal.

    Parameters:
        None.
    Returns:
        None: `ratchet` -> `100-percent` passes the goal check.
    Raises:
        AssertionError: Graduation is rejected.
    """
    data = ratchet_policy(5, 5).model_dump()
    data["packages"]["example"]["goal"] = "100-percent"
    check_ratchet(Policy.model_validate(data), ratchet_policy(5, 5))


def test_ratchet_goal_requires_a_measured_enforced_signal() -> None:
    """Keep `ratchet` from becoming a label that enforces nothing.

    Parameters:
        None.
    Returns:
        None: Pending status or only report-only signals are rejected.
    Raises:
        AssertionError: An empty ratchet declaration validates.
    """
    data = ratchet_policy().model_dump()
    package = data["packages"]["example"]
    package["signals"]["primary"] |= {"enforcement": "report-only", "reason": "Diagnostic only."}
    with pytest.raises(ValidationError, match="at least one enforced signal"):
        Policy.model_validate(data)


@pytest.mark.parametrize(
    ("base_goal", "new_goal"),
    [("ratchet", "excluded"), ("ratchet", "report-only"), ("100-percent", "ratchet")],
)
def test_goal_moves_that_loosen_are_rejected(base_goal: str, new_goal: str) -> None:
    """Reject every goal move that leaves an enforced mode for a weaker one.

    Parameters:
        base_goal (str): Goal in the base policy.
        new_goal (str): Weaker goal in the current policy.
    Returns:
        None: `check_ratchet` refuses each move even with a reasoned enforcement downgrade.
    Raises:
        AssertionError: A loosening move is accepted.
    """
    base = ratchet_policy(5, 5).model_dump()
    base["packages"]["example"]["goal"] = base_goal
    current = ratchet_policy(5, 5).model_dump()
    package = current["packages"]["example"]
    package["goal"] = new_goal
    if new_goal != "ratchet":
        package["signals"]["primary"] |= {"enforcement": "report-only", "reason": "Loosening attempt."}
        current["enforcement_changes"] = [{"package": "example", "signal": "primary", "reason": "Loosening."}]
    with pytest.raises(ValueError, match="Cannot remove package from global goal"):
        check_ratchet(Policy.model_validate(current), Policy.model_validate(base))


def verification_report(files: list[Path], lines: int, functions: int) -> str:
    """Render LCOV for real owned source with an exact uncovered line and function total.

    Parameters:
        files (list[Path]): Absolute owned source paths; the first carries every miss.
        lines (int): Uncovered executable lines to report.
        functions (int): Uncovered functions to report.
    Returns:
        str: One consistent record per file, each with one covered line and function.
    Raises:
        None.
    """
    records = []
    for index, path in enumerate(files):
        missed_lines, missed_functions = (lines, functions) if index == 0 else (0, 0)
        names = [f"f{n}" for n in range(missed_functions + 1)]
        records.append(
            "\n".join(
                [f"SF:{path}"]
                + [f"FN:1,{name}" for name in names]
                + [f"FNDA:{0 if n else 1},{name}" for n, name in enumerate(names)]
                + [f"FNF:{len(names)}", "FNH:1"]
                + [f"DA:{line},{0 if line > 1 else 1}" for line in range(1, missed_lines + 2)]
                + [f"LF:{missed_lines + 1}", "LH:1", "end_of_record"]
            )
        )
    return "TN:\n" + "\n".join(records) + "\n"


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
@pytest.mark.parametrize("name", sorted(VERIFICATION_FLOORS))
def test_verification_primary_signals_enforce_measured_floors(
    tmp_path: Path, name: str, runner_os: str
) -> None:
    """Fail the real `probes` declaration one counter above their measured floor.

    Parameters:
        tmp_path (Path): Disposable reports root measured against the real source inventory.
        name (str): Verification package from the committed policy.
        runner_os (str): Measured OS whose floor is exercised.
    Returns:
        None: At the floor accounting passes; one extra line or function fails the budget.
    Raises:
        AssertionError: A regression is report-only, or the floor drifts from the CI measurement.
    """
    real = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    package = real.packages[name]
    signal = package.signals["primary"]
    cfg = real.model_copy(update={"packages": {name: package}})
    files = [ROOT / package.root / path for path in sorted(inventory(ROOT, package))]
    report = tmp_path / package.root / signal.report
    report.parent.mkdir(parents=True)
    lines, functions = VERIFICATION_FLOORS[name][runner_os]
    for extra_lines, extra_functions in ((0, 0), (1, 0), (0, 1)):
        report.write_text(verification_report(files, lines + extra_lines, functions + extra_functions))
        errors = [e for e in account(ROOT, cfg, runner_os, tmp_path)[1] if e.startswith(f"{name}/primary:")]
        if extra_lines or extra_functions:
            measured = f"{lines + extra_lines} lines, {functions + extra_functions} functions"
            assert errors == [f"{name}/primary: Budget exceeded: {measured}"]
        else:
            assert errors == []
    assert package.goal == "ratchet"
    assert signal.enforcement == "enforced"
    assert signal.max_uncovered[runner_os] == Counts(lines=lines, functions=functions)
