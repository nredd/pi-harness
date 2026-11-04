"""Exercise fail-closed accounting with LCOV and disposable Git base policies.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import Policy, account, check_ratchet, git_read, inventory, parse_lcov

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


def test_passing_lines_and_functions_branches_report_only(tmp_path: Path) -> None:
    """Keep branches reported without gating primary coverage.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Integer line/function counters pass despite an uncovered branch.
    Raises:
        AssertionError: Branch-only misses fail accounting.
    """
    setup_report(tmp_path)
    results, errors = account(tmp_path, policy())
    assert not errors
    assert results[0]["uncovered_branches"] == 1
    assert results[0]["uncovered_lines"] == 0


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
        (FIXTURES / "passing.info").read_text().replace("BRH:1", "BRH:2"),
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
