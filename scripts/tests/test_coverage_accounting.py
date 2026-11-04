"""Exercise fail-closed accounting with LCOV and disposable Git base policies.

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
from coverage_accounting import (
    Package,
    Policy,
    account,
    check_ratchet,
    git_read,
    inventory,
    parse_lcov,
    signal_comparisons,
)

FIXTURES = Path(__file__).parent / "fixtures" / "coverage"
SCRIPT = Path(__file__).resolve().parents[1] / "coverage_accounting.py"


def policy() -> Policy:
    """Return a measured miniature policy.

    Parameters:
        None.
    Returns:
        Policy: Validated fixture ownership and budgets.
    Raises:
        ValidationError: The fixture policy is invalid.
    """
    return Policy.model_validate(
        {
            "version": 2,
            "target": {"lines": 0, "functions": 0},
            "enforce_target": False,
            "packages": {
                "example": {
                    "root": "packages/example",
                    "owned": ["src/*.ts"],
                    "exclusions": [],
                    "status": "measured",
                    "note": "",
                    "signals": {
                        "primary": {
                            "report": "coverage/lcov.info",
                            "files": ["src/index.ts"],
                            "max_uncovered": {
                                "darwin": {"lines": 0, "functions": 0},
                                "linux": {"lines": 0, "functions": 0},
                            },
                            "reporters": ["text", "lcov"],
                        }
                    },
                }
            },
        }
    )


def setup_report(tmp_path: Path, fixture: str = "passing.info") -> Path:
    """Create disposable source paths and a real LCOV fixture.

    Parameters:
        tmp_path (Path): Disposable source root.
        fixture (str): Stored LCOV fixture filename.
    Returns:
        Path: Created LCOV report path.
    Raises:
        OSError: Fixture files cannot be created or read.
    """
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["packages/*"]}))
    directory = tmp_path / "packages/example"
    (directory / "src").mkdir(parents=True)
    (directory / "package.json").write_text("{}\n")
    (directory / "src/index.ts").write_text("export function answer() { return 42; }\n")
    (directory / "coverage").mkdir()
    report = directory / "coverage/lcov.info"
    shutil.copyfile(FIXTURES / fixture, report)
    return report


def branch_policy(cap: int | None, **package: object) -> Policy:
    """Return the miniature policy with a branch cap on the active OS.

    Parameters:
        cap (int | None): Uncovered-branch cap, or None for no `branches` key.
        **package (object): Package fields to override, e.g. `goal`.
    Returns:
        Policy: Validated fixture policy.
    Raises:
        ValidationError: The overridden fixture policy is invalid.
    """
    data = policy().model_dump(exclude_none=True)
    data["packages"]["example"] |= package
    data["packages"]["example"]["signals"]["primary"]["max_uncovered"][sys.platform]["branches"] = cap
    if package.get("goal") not in {None, "100-percent"}:
        data["packages"]["example"]["signals"]["primary"] |= {
            "enforcement": "report-only",
            "reason": "Fixture.",
        }
    return Policy.model_validate(data)


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


def test_excluded_goal_needs_no_branch_cap(tmp_path: Path) -> None:
    """Accept uncapped branch records only for an owner-excluded package.

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
    with pytest.raises(ValueError, match="Cannot remove the branch target"):
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


def test_real_coveragepy_branch_report_parses(tmp_path: Path) -> None:
    """Parse the branch rows coverage.py writes for `--cov-branch`, including never-reached `-` rows.

    Parameters:
        tmp_path (Path): Disposable module and report directory.
    Returns:
        None: Named branch identities and `-` counts parse into exact counters.
    Raises:
        AssertionError: A real coverage.py branch row is rejected or miscounted.
    """
    module = tmp_path / "mod.py"
    module.write_text(
        "def sign(value):\n    if value:\n        return 1\n    return 0\n\n\n"
        "def never(value):\n    if value:\n        return 1\n    return 0\n\n\n"
        "if sign(1):\n    sign(0)\n"
    )
    for argv in (["run", "--branch", "mod.py"], ["lcov", "-o", "lcov.info"]):
        subprocess.run(
            [sys.executable, "-m", "coverage", *argv], cwd=tmp_path, check=True, capture_output=True
        )
    text = (tmp_path / "lcov.info").read_text()
    assert "BRDA:8,0,jump to line 9,-" in text
    counters = parse_lcov(text, bare_sources=True)["mod.py"]
    assert (counters.branches, counters.uncovered_branches) == (6, 3)
    assert (counters.lines, counters.uncovered_lines) == (10, 3)
    with pytest.raises(ValueError, match="branch"):
        parse_lcov(text.replace(",-\n", ",x\n", 1), bare_sources=True)


def test_uncovered_counts_fail(tmp_path: Path) -> None:
    """Reject independently counted uncovered execution.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Both uncovered counters are reported exactly.
    Raises:
        AssertionError: Uncovered execution is accepted.
    """
    setup_report(tmp_path, "uncovered.info")
    results, errors = account(tmp_path, policy())
    assert results[0]["uncovered_functions"] == 1
    assert "Budget exceeded: 1 lines, 1 functions" in errors[0]


@pytest.mark.parametrize("mode", ["missing-report", "empty", "missing-file", "unknown-file"])
def test_fail_closed(tmp_path: Path, mode: str) -> None:
    """Fail closed on unavailable or inconsistent report membership.

    Parameters:
        tmp_path (Path): Disposable report root.
        mode (str): Report or expected-file failure to introduce.
    Returns:
        None: The accounting failure is retained explicitly.
    Raises:
        AssertionError: Missing or unexpected source becomes successful coverage.
    """
    report = setup_report(tmp_path)
    if mode == "missing-report":
        report.unlink()
    elif mode == "empty":
        report.write_text("")
    elif mode == "missing-file":
        (tmp_path / "packages/example/src/never.ts").write_text("export const never = 1;\n")
        cfg = policy()
        files = cfg.packages["example"].signals["primary"].files
        assert files is not None
        files.append("src/never.ts")
        assert "Expected files missing" in account(tmp_path, cfg)[1][0]
        return
    else:
        report.write_text(report.read_text().replace("src/index.ts", "src/unknown.ts"))
    assert account(tmp_path, policy())[1]


@pytest.mark.parametrize(
    "text",
    [
        "",
        "SF:src/index.ts\n",
        "DA:1,1\n",
        "SF:a\nLF:0\nLH:0\nFNF:0\nFNH:0\nend_of_record\n",
        (FIXTURES / "passing.info").read_text().replace("LF:2", "LF:3"),
        (FIXTURES / "passing.info").read_text().replace("DA:2,1", "DA:1,1"),
        (FIXTURES / "passing.info").read_text().replace("FNDA:1,answer", "FNDA:-1,answer"),
        (FIXTURES / "branches.info").read_text().replace("BRH:1", "BRH:2"),
        (FIXTURES / "passing.info").read_text().replace("FNF:1\n", ""),
        (FIXTURES / "passing.info").read_text() * 2,
    ],
)
def test_malformed_lcov_rejected(text: str) -> None:
    """Reject malformed or internally inconsistent LCOV.

    Parameters:
        text (str): Invalid LCOV document.
    Returns:
        None: Parsing raises a semantic validation failure.
    Raises:
        AssertionError: Invalid counters are accepted.
    """
    with pytest.raises(ValueError, match=r"LCOV|counter|line|branch|function"):
        parse_lcov(text)


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


@pytest.mark.parametrize("reason", ["", "   "])
def test_exclusion_requires_a_reason(reason: str) -> None:
    """Require substantive exclusion explanations.

    Parameters:
        reason (str): Empty or whitespace-only justification.
    Returns:
        None: Policy validation rejects the exclusion.
    Raises:
        AssertionError: An unreasoned exclusion passes.
    """
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "src/types.ts", "kind": "type-only", "reason": reason},
    ]
    with pytest.raises(ValidationError):
        Policy.model_validate(data)


def test_excluded_declaration_is_not_executable_scope(tmp_path: Path) -> None:
    """Keep genuine declarations outside executable measurement.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: A reasoned declaration exclusion leaves executable accounting intact.
    Raises:
        AssertionError: A declaration is measured as production execution.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/types.ts").write_text("export type Value = string;\n")
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "src/types.ts", "kind": "type-only", "reason": "No executable JavaScript."},
    ]
    cfg = Policy.model_validate(data)
    assert inventory(tmp_path, cfg.packages["example"]) == {"src/index.ts"}
    assert not account(tmp_path, cfg)[1]


def test_new_owned_file_requires_measurement(tmp_path: Path) -> None:
    """Detect never-imported source newly matched by ownership.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: An incomplete primary measurement fails.
    Raises:
        AssertionError: Newly owned source silently disappears from the denominator.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/new.ts").write_text("export const value = 0;\n")
    assert "Primary signal must measure every owned" in account(tmp_path, policy())[1][0]


def test_lcov_only_threshold_bypass_is_rejected() -> None:
    """Require both machine and visible threshold reporting.

    Parameters:
        None.
    Returns:
        None: LCOV-only reporting fails policy validation.
    Raises:
        AssertionError: The reporter requirement is weakened.
    """
    data = policy().model_dump()
    data["packages"]["example"]["signals"]["primary"]["reporters"] = ["lcov"]
    with pytest.raises(ValidationError, match="both text and lcov"):
        Policy.model_validate(data)


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


def test_aggregate_function_lcov_is_validated() -> None:
    """Validate aggregate-only function LCOV without losing its denominator.

    Parameters:
        None.
    Returns:
        None: Valid aggregate counters pass and inconsistent totals fail.
    Raises:
        AssertionError: Aggregate function misses are dropped.
    """
    text = (FIXTURES / "bun-aggregate.info").read_text()
    counters = parse_lcov(text)["source.ts"]
    assert counters.functions == 2
    assert counters.uncovered_functions == 1
    with pytest.raises(ValueError, match="function totals"):
        parse_lcov(text.replace("FNH:1", "FNH:3"))


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


def test_unknown_sibling_is_not_silently_discarded(tmp_path: Path) -> None:
    """Require reviewed ownership for imported sibling source.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Unknown sibling production source fails.
    Raises:
        AssertionError: Uninventoried imported source is discarded silently.
    """
    report = setup_report(tmp_path)
    report.write_text(report.read_text().replace("src/index.ts", "../unknown/src/index.ts"))
    assert "Report file not in policy" in account(tmp_path, policy())[1][0]


def test_generated_artifact_exclusions_need_not_be_owned_source(tmp_path: Path) -> None:
    """Allow reviewed generated-output duplicates outside production scope.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Generated output is not added to production counters.
    Raises:
        AssertionError: A justified generated duplicate corrupts accounting.
    """
    report = setup_report(tmp_path)
    generated = report.read_text().replace("src/index.ts", "dist/chunks/generated.ts")
    report.write_text(report.read_text() + generated)
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "dist/**/*.ts", "kind": "generated", "reason": "Builder duplicates src/."},
    ]
    assert not account(tmp_path, Policy.model_validate(data))[1]


def test_test_helper_cannot_overlap_owned_inventory(tmp_path: Path) -> None:
    """Reject overlap between explicit helper and production declarations.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Inventory validation rejects the overlap.
    Raises:
        AssertionError: A helper declaration bypasses owned production scope.
    """
    setup_report(tmp_path)
    cfg = policy()
    cfg.packages["example"].test_helpers = ["src/index.ts"]
    with pytest.raises(ValueError, match="overlap"):
        inventory(tmp_path, cfg.packages["example"])


def test_parse_lcov_accepts_real_coveragepy_report() -> None:
    """Parse a coverage.py 7.17.1 LCOV capture without rewriting it.

    Parameters:
        None.
    Returns:
        None: `FN:<line>,<end>,<name>` rows, nested names and empty sources parse into exact counters.
    Raises:
        AssertionError: A coverage.py row shape is rejected or miscounted.
    """
    records = parse_lcov((FIXTURES / "coveragepy-7.17.1.info").read_text(), bare_sources=True)
    assert records["__init__.py"].lines == 0
    module = records["mod.py"]
    assert (module.lines, module.uncovered_lines) == (9, 1)
    assert (module.functions, module.uncovered_functions) == (4, 1)


@pytest.mark.parametrize(
    "mutation",
    [
        ("FN:4,5,covered", "FN:x,5,covered"),
        ("FNDA:0,uncovered", "FNDA:0,missing"),
        ("FN:4,5,covered", "FN:4,5,"),
    ],
)
def test_parse_lcov_rejects_malformed_coveragepy_functions(mutation: tuple[str, str]) -> None:
    """Keep the stricter validation for malformed coverage.py function rows.

    Parameters:
        mutation (tuple[str, str]): Real row and its corrupted replacement.
    Returns:
        None: Every corruption is rejected.
    Raises:
        AssertionError: A corrupted row is accepted.
    """
    text = (FIXTURES / "coveragepy-7.17.1.info").read_text().replace(*mutation)
    with pytest.raises(ValueError, match="function"):
        parse_lcov(text, bare_sources=True)


def test_parse_lcov_reads_a_coveragepy_module_without_functions_as_zero_functions() -> None:
    """Accept coverage.py 7.17.1's record for a module with no functions, which carries no FN totals.

    Parameters:
        None.
    Returns:
        None: The real `benchmarks/comparison` `__main__.py` record parses with zero functions under
            coverage.py, and stays a truncated report for every other producer.
    Raises:
        AssertionError: The record is rejected for coverage.py or accepted for another producer.
    """
    text = "\n".join(
        [
            "SF:src/pi_harness_benchmark/__main__.py",
            "DA:7,1",
            "DA:9,1",
            "DA:11,1",
            "DA:12,0",
            "LF:4",
            "LH:3",
            "BRDA:11,0,jump to line 12,1",
            "BRDA:11,0,exit the module,1",
            "BRF:2",
            "BRH:2",
            "end_of_record",
            "",
        ]
    )
    counters = parse_lcov(text, bare_sources=True)["src/pi_harness_benchmark/__main__.py"]
    assert (counters.lines, counters.uncovered_lines, counters.functions, counters.uncovered_functions) == (
        4,
        1,
        0,
        0,
    )
    assert (counters.branches, counters.uncovered_branches) == (2, 0)
    # Other producers keep strict numbered branches and required FN totals.
    with pytest.raises(ValueError, match="Malformed branch counter"):
        parse_lcov(text)
    unbranched = text.replace("BRDA:11,0,jump to line 12,1\nBRDA:11,0,exit the module,1\nBRF:2\nBRH:2\n", "")
    with pytest.raises(ValueError, match="Missing LCOV totals"):
        parse_lcov(unbranched)
    # A record with function rows still needs coverage.py's own totals.
    with pytest.raises(ValueError, match="Missing LCOV totals"):
        parse_lcov(text.replace("LF:4", "FN:9,12,main\nFNDA:1,main\nLF:4"), bare_sources=True)


@pytest.mark.parametrize(
    "row",
    [
        "BRDA:3,0,,1",
        "BRDA:3,0, ,1",
        "BRDA:x,0,jump to line 4,1",
        "BRDA:3,0,jump to line 4",
        "BRDA:3,0,jump,x",
    ],
)
def test_parse_lcov_rejects_malformed_coveragepy_branches(row: str) -> None:
    """Keep named coverage.py branches strict about location, name and hit count.

    Parameters:
        row (str): A corrupted coverage.py branch row.
    Returns:
        None: Every corruption is rejected.
    Raises:
        AssertionError: A corrupted branch is accepted.
    """
    text = "\n".join(["SF:a.py", "DA:3,1", "LF:1", "LH:1", row, "end_of_record", ""])
    with pytest.raises(ValueError, match="branch"):
        parse_lcov(text, bare_sources=True)


def test_skipped_host_reports_not_run_but_other_hosts_still_fail_closed(tmp_path: Path) -> None:
    """Scope a signal to hosts that run its producer without loosening anyone else.

    Parameters:
        tmp_path (Path): Disposable source root with no LCOV report.
    Returns:
        None: The skipped host reports nothing, every other host still fails on the missing report.
    Raises:
        AssertionError: A skipped host is gated or a non-skipped host is exempt.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/coverage/lcov.info").unlink()
    scoped = policy()
    scoped.packages["example"].signals["primary"].skip_hosts = ["wsl2"]
    assert account(tmp_path, scoped, host="wsl2") == ([], [])
    for host in (None, "linux", "macos"):
        _, errors = account(tmp_path, scoped, host=host)
        assert errors, host


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


def test_skipped_producer_gate_reports_not_run_but_a_run_gate_requires_its_report(tmp_path: Path) -> None:
    """Report a path-gated signal NOT RUN only on a run whose plan skipped its producer gate.

    Parameters:
        tmp_path (Path): Disposable source root with no LCOV report.
    Returns:
        None: A skipped gate reports nothing; an unskipped gate fails on the missing report.
    Raises:
        AssertionError: A skipped gate is gated, or a run gate's missing report passes.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/coverage/lcov.info").unlink()
    gated = policy()
    gated.packages["example"].signals["primary"].gate = "check-benchmark"
    assert account(tmp_path, gated, skipped_gates=frozenset({"check-benchmark"})) == ([], [])
    _, errors = account(tmp_path, gated)
    missing = tmp_path / "packages/example/coverage/lcov.info"
    assert errors == [f"example/primary: [Errno 2] No such file or directory: '{missing}'"]


@pytest.mark.parametrize(
    "skipped", [frozenset({"check-benchmrk"}), frozenset({"check-benchmark", "check-ts"})]
)
def test_skipped_gates_reject_a_gate_no_signal_declares(tmp_path: Path, skipped: frozenset[str]) -> None:
    """Fail closed on a skipped-gate token no policy signal declares, so a typo cannot skip nothing silently.

    Parameters:
        tmp_path (Path): Disposable source root with a passing report.
        skipped (frozenset[str]): Skipped gates holding at least one undeclared token.
    Returns:
        None: Accounting refuses the whole gate list before reading any report.
    Raises:
        AssertionError: An undeclared token is ignored.
    """
    setup_report(tmp_path)
    gated = policy()
    gated.packages["example"].signals["primary"].gate = "check-benchmark"
    unknown = sorted(skipped - {"check-benchmark"})
    with pytest.raises(ValueError, match=re.escape(f"Skipped gates no policy signal declares: {unknown}")):
        account(tmp_path, gated, skipped_gates=skipped)


def test_skipped_gates_cli_reports_not_run(tmp_path: Path) -> None:
    """Drive `--skipped-gates` through the real command line against a gated signal with no report.

    Parameters:
        tmp_path (Path): Disposable repository root with no LCOV report.
    Returns:
        None: The skipped run exits 0 with a NOT RUN line; the same run without the flag fails.
    Raises:
        AssertionError: The flag is ignored or the missing report passes without it.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/coverage/lcov.info").unlink()
    gated = policy().model_dump(mode="json")
    gated["packages"]["example"]["signals"]["primary"]["gate"] = "check-benchmark"
    (tmp_path / "coverage").mkdir()
    (tmp_path / "coverage/policy.json").write_text(json.dumps(gated))
    git_read(tmp_path, ["init", "-q", "--template="])
    command = [sys.executable, str(SCRIPT), "--root", str(tmp_path), "--measure", "--os", "linux"]
    skipped = subprocess.run(
        [*command, "--skipped-gates", "check-benchmark"], capture_output=True, text=True, check=False
    )
    assert skipped.returncode == 0, skipped.stderr
    assert (
        "NOT RUN: 'example/primary': this run skipped its producer gate 'check-benchmark'" in skipped.stderr
    )
    required = subprocess.run(command, capture_output=True, text=True, check=False)
    assert required.returncode == 1
    assert "example/primary: [Errno 2] No such file or directory" in required.stderr
    typo = subprocess.run(
        [*command, "--skipped-gates", "check-benchmrk"], capture_output=True, text=True, check=False
    )
    assert typo.returncode == 1
    assert "Skipped gates no policy signal declares: ['check-benchmrk']" in typo.stderr


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


def test_parse_lcov_keeps_commas_in_lcov_style_function_names() -> None:
    """Treat everything after `FN:<line>,` as the name when no end line is present.

    Parameters:
        None.
    Returns:
        None: A comma-bearing identity matches between its FN and FNDA rows.
    Raises:
        AssertionError: The identity is split or mismatched.
    """
    text = "\n".join(
        ["SF:a.ts", "DA:1,1", "FN:1,f,g", "FNDA:1,f,g", "FNF:1", "FNH:1", "LF:1", "LH:1", "end_of_record", ""]
    )
    assert parse_lcov(text)["a.ts"].functions == 1


def test_bare_source_record_is_only_accepted_from_coveragepy() -> None:
    """Keep a truncated Istanbul/Bun record from parsing as a zero-line source.

    Parameters:
        None.
    Returns:
        None: coverage.py's empty-source record passes only when the producer is declared `coverage.py`.
    Raises:
        AssertionError: A bare record is accepted for a plain LCOV producer.
    """
    bare = "TN:\nSF:src/a.ts\nend_of_record\nSF:src/b.ts\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"
    with pytest.raises(ValueError, match="Missing LCOV totals"):
        parse_lcov(bare)
    assert parse_lcov(bare, bare_sources=True)["src/a.ts"].lines == 0


@pytest.mark.parametrize(("producer", "error"), [("lcov", "Missing LCOV totals"), ("coverage.py", None)])
def test_account_scopes_bare_records_by_signal_producer(
    tmp_path: Path, producer: str, error: str | None
) -> None:
    """Gate the coverage.py-only bare-record acceptance at `account()`, where the policy is read.

    Parameters:
        tmp_path (Path): Disposable source root.
        producer (str): The signal's declared report writer.
        error (str | None): Expected accounting error, or None when the bare record is accepted.
    Returns:
        None: Only a `coverage.py` signal accepts a bare `SF`/`end_of_record` record.
    Raises:
        AssertionError: The producer check is bypassed or over-applied.
    """
    report = setup_report(tmp_path)
    directory = tmp_path / "packages/example"
    (directory / "src/other.ts").write_text("export const other = 1;\n")
    report.write_text(
        "SF:src/index.ts\nend_of_record\nSF:src/other.ts\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"
    )
    data = policy().model_dump()
    signal = data["packages"]["example"]["signals"]["primary"]
    signal |= {"files": ["src/index.ts", "src/other.ts"], "producer": producer}
    data["packages"]["example"]["owned"] = ["src/*.ts"]
    _, errors = account(tmp_path, Policy.model_validate(data))
    if error is None:
        assert not errors
    else:
        assert any(error in item for item in errors)
