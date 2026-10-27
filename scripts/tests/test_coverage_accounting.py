"""Exercise fail-closed accounting with LCOV and disposable Git base policies."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import Policy, account, check_ratchet, inventory, parse_lcov

FIXTURES = Path(__file__).parent / "fixtures" / "coverage"
SCRIPT = Path(__file__).resolve().parents[1] / "coverage_accounting.py"


def policy() -> Policy:
    """Return a fully measured miniature package policy."""
    return Policy.model_validate(
        {
            "version": 1,
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
                            "max_uncovered": {"lines": 0, "functions": 0},
                            "reporters": ["text", "lcov"],
                        }
                    },
                }
            },
        }
    )


def setup_report(tmp_path: Path, fixture: str = "passing.info") -> Path:
    """Create real source paths and an LCOV fixture in a disposable repository tree."""
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
    """An uncovered branch alone must not fail the line/function gate."""
    setup_report(tmp_path)
    results, errors = account(tmp_path, policy())
    assert not errors
    assert results[0]["uncovered_branches"] == 1
    assert results[0]["uncovered_lines"] == 0


def test_uncovered_counts_fail(tmp_path: Path) -> None:
    """Compare integer uncovered counts, not rounded percentages."""
    setup_report(tmp_path, "uncovered.info")
    results, errors = account(tmp_path, policy())
    assert results[0]["uncovered_functions"] == 1
    assert "Budget exceeded: 1 lines, 1 functions" in errors[0]


@pytest.mark.parametrize("mode", ["missing-report", "empty", "missing-file", "unknown-file"])
def test_fail_closed(tmp_path: Path, mode: str) -> None:
    """Missing input, absent source and unexpected source never count as covered."""
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
    """Reject malformed, inconsistent, zero-line and duplicate counters."""
    with pytest.raises(ValueError, match=r"LCOV|counter|line|branch|function"):
        parse_lcov(text)


@pytest.mark.parametrize("metric", ["lines", "functions"])
def test_ratchet_cannot_increase_uncovered_budget(metric: str) -> None:
    """Each independent metric must ratchet against the Git base."""
    current, base = policy(), policy()
    setattr(current.packages["example"].signals["primary"].max_uncovered, metric, 1)
    with pytest.raises(ValueError, match="Ratchet violation"):
        check_ratchet(current, base)
    check_ratchet(base, current)


def test_ratchet_cannot_remove_a_signal_or_package() -> None:
    """Removing accounting is not a legitimate way to satisfy the ratchet."""
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
    """Every exclusion must carry a substantive reviewed explanation."""
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "src/types.ts", "kind": "type-only", "reason": reason},
    ]
    with pytest.raises(ValidationError):
        Policy.model_validate(data)


def test_excluded_declaration_is_not_executable_scope(tmp_path: Path) -> None:
    """Explicitly justified type declarations need no executable report record."""
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
    """An owned glob cannot silently omit never-imported source."""
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/new.ts").write_text("export const value = 0;\n")
    assert "Primary signal must measure every owned" in account(tmp_path, policy())[1][0]


def test_lcov_only_threshold_bypass_is_rejected() -> None:
    """Runner-independent policy rejects lcov-only threshold declarations."""
    data = policy().model_dump()
    data["packages"]["example"]["signals"]["primary"]["reporters"] = ["lcov"]
    with pytest.raises(ValidationError, match="both text and lcov"):
        Policy.model_validate(data)


def test_global_flip_requires_no_uncovered_or_pending(tmp_path: Path) -> None:
    """The final policy-only flip must reject transitional budgets and missing coverage."""
    setup_report(tmp_path, "uncovered.info")
    cfg = policy()
    cfg.packages["example"].signals["primary"].max_uncovered.lines = 1
    cfg.packages["example"].signals["primary"].max_uncovered.functions = 1
    assert not account(tmp_path, cfg)[1]
    cfg.enforce_target = True
    assert account(tmp_path, cfg)[1]
    cfg.packages["example"].status = "pending"
    cfg.packages["example"].signals.clear()
    assert "Unmeasured package" in account(tmp_path, cfg)[1][0]


def test_cli_uses_real_git_base_and_always_writes_summary(tmp_path: Path) -> None:
    """A policy increase fails using the committed base, not a supplied replacement file."""
    setup_report(tmp_path)
    (tmp_path / "coverage").mkdir()
    path = tmp_path / "coverage/policy.json"
    cfg = policy()
    path.write_text(cfg.model_dump_json())
    for argv in [
        ["init", "-q"],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Base policy",
        ],
    ]:
        subprocess.check_output(["/usr/bin/git", "-C", str(tmp_path), *argv], text=True)
    cfg.packages["example"].signals["primary"].max_uncovered.lines = 1
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
    """Accept summary-only LCOV without losing its uncovered-function denominator."""
    text = (FIXTURES / "bun-aggregate.info").read_text()
    counters = parse_lcov(text)["source.ts"]
    assert counters.functions == 2
    assert counters.uncovered_functions == 1
    with pytest.raises(ValueError, match="function totals"):
        parse_lcov(text.replace("FNH:1", "FNH:3"))


def test_global_primary_target_does_not_replace_independent_runtime_ratchet(tmp_path: Path) -> None:
    """A final primary-100% flip must not silently redefine a separate runtime signal."""
    report = setup_report(tmp_path)
    runtime = report.with_name("runtime.info")
    shutil.copyfile(FIXTURES / "uncovered.info", runtime)
    cfg = policy()
    runtime_signal = cfg.packages["example"].signals["primary"].model_copy(deep=True)
    runtime_signal.report = "coverage/runtime.info"
    runtime_signal.max_uncovered.lines = 1
    runtime_signal.max_uncovered.functions = 1
    cfg.packages["example"].signals["runtime"] = runtime_signal
    cfg.enforce_target = True
    results, errors = account(tmp_path, cfg)
    assert not errors
    assert {row["signal"] for row in results} == {"primary", "runtime"}


def test_unknown_sibling_is_not_silently_discarded(tmp_path: Path) -> None:
    """A cross-package import needs its own reviewed inventory."""
    report = setup_report(tmp_path)
    report.write_text(report.read_text().replace("src/index.ts", "../unknown/src/index.ts"))
    assert "Report file not in policy" in account(tmp_path, policy())[1][0]


def test_generated_artifact_exclusions_need_not_be_owned_source(tmp_path: Path) -> None:
    """Explicit justified generated globs cover imported hashed build artifacts only."""
    report = setup_report(tmp_path)
    generated = report.read_text().replace("src/index.ts", "dist/chunks/generated.ts")
    report.write_text(report.read_text() + generated)
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "dist/**/*.ts", "kind": "generated", "reason": "Builder duplicates src/."},
    ]
    assert not account(tmp_path, Policy.model_validate(data))[1]


def test_test_helper_cannot_overlap_owned_inventory(tmp_path: Path) -> None:
    """A helper declaration must not become a back-door production exclusion."""
    setup_report(tmp_path)
    cfg = policy()
    cfg.packages["example"].test_helpers = ["src/index.ts"]
    with pytest.raises(ValueError, match="overlap"):
        inventory(tmp_path, cfg.packages["example"])
