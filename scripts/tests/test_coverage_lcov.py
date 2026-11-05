"""Parse LCOV and account each report fail-closed against its signal.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import (
    FIXTURES,
    SCRIPT,
    policy,
    setup_report,
)

from coverage_accounting import (
    Policy,
    account,
    git_read,
    parse_lcov,
    scoped_records,
)


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


def test_valid_raw_report_filters_to_zero_owned_lines(tmp_path: Path) -> None:
    """Exercise the owned-zero guard separately from raw LCOV's zero-total rejection.

    Parameters:
        tmp_path (Path): Disposable report/source root.
    Returns:
        None: Valid positive-total LCOV with zero owned lines fails closed.
    Raises:
        AssertionError: Filtering nonowned counters can fabricate successful empty coverage.
    """
    report = setup_report(tmp_path)
    helper = (FIXTURES / "passing.info").read_text().replace("src/index.ts", "test/helper.ts")
    owned = "SF:src/index.ts\nFNF:0\nFNH:0\nLF:0\nLH:0\nend_of_record\n"
    report.write_text(helper + owned)
    assert sum(counter.lines for counter in parse_lcov(report.read_text()).values()) == 2
    assert account(tmp_path, policy())[1] == ["example/primary: Zero total owned lines"]


@pytest.mark.parametrize(
    ("row", "message"),
    [
        ("BOGUS", "Malformed LCOV row: 'BOGUS'"),
        ("LF:x", "Malformed or duplicate LCOV summary: 'LF:x'"),
        ("DA:1", "Malformed line counter: 'DA:1'"),
        ("XX:1", "Unsupported LCOV row: 'XX:1'"),
        ("FN:1,answer\nFN:2,answer", "Duplicate function counter: '2,answer'"),
    ],
)
def test_parse_lcov_names_each_rejected_row(row: str, message: str) -> None:
    """Name the exact malformed, unsupported or duplicate LCOV row.

    Parameters:
        row (str): Invalid row(s) placed inside an otherwise open source record.
        message (str): Exact parser refusal.
    Returns:
        None: Parsing raises the named refusal.
    Raises:
        AssertionError: An invalid row is accepted or misreported.
    """
    with pytest.raises(ValueError, match=re.escape(message)):
        parse_lcov(f"SF:src/index.ts\n{row}\nend_of_record\n")


def test_report_rejects_two_spellings_of_one_source(tmp_path: Path) -> None:
    """Reject two LCOV records that normalize to the same package-relative source.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: Accounting reports the duplicate instead of merging or overwriting counters.
    Raises:
        AssertionError: A second spelling of one file is silently accepted.
    """
    report = setup_report(tmp_path)
    text = report.read_text()
    report.write_text(text + text.replace("SF:src/index.ts", "SF:./src/index.ts"))
    assert account(tmp_path, policy())[1] == ["example/primary: Duplicate normalized source: 'src/index.ts'"]


def test_report_skips_sibling_owned_source_and_test_helpers(tmp_path: Path) -> None:
    """Skip another package's owned source and this package's named test helpers in a report.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: Only the signal's own expected source is accounted.
    Raises:
        AssertionError: Reviewed sibling or helper records are rejected or counted.
    """
    report = setup_report(tmp_path)
    other = tmp_path / "packages/other"
    (other / "src").mkdir(parents=True)
    (other / "src/index.ts").write_text("export const other = 1;\n")
    helper = tmp_path / "packages/example/support/helper.ts"
    helper.parent.mkdir()
    helper.write_text("export const helper = 1;\n")
    text = report.read_text()
    report.write_text(
        text
        + text.replace("src/index.ts", "../other/src/index.ts")
        + text.replace("src/index.ts", "support/helper.ts")
    )
    data = policy().model_dump()
    data["packages"]["example"]["test_helpers"] = ["support/helper.ts"]
    data["packages"]["other"] = data["packages"]["example"] | {"root": "packages/other", "test_helpers": []}
    cfg = Policy.model_validate(data)
    package = cfg.packages["example"]
    assert scoped_records(tmp_path, cfg, package, package.signals["primary"]).keys() == {"src/index.ts"}
