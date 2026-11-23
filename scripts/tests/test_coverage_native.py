"""Exercise source-complete LLVM native accounting without a desktop or compiler.

References:
    ../../docs/coverage.md
    https://llvm.org/docs/CommandGuide/llvm-cov.html
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import SCRIPT, commit_base

from coverage_accounting import (
    Counts,
    MappedFile,
    Package,
    Policy,
    Remeasurement,
    Signal,
    account,
    check_ratchet,
    check_remeasurements,
    check_signal_ratchet,
    check_stale_mapped_totals,
    is_llvm_producer,
    measured_mapped_totals,
    parse_lcov,
    stale_mapped_totals,
    weakened_mapped_totals,
)


def native_fixture(root: Path) -> tuple[Policy, dict[str, Any], Path]:
    """Build a disposable raw LLVM export and real source tree.

    Parameters:
        root (Path): Isolated repository directory.
    Returns:
        tuple[Policy, dict[str, Any], Path]: Policy, mutable export and output file.
    Raises:
        OSError: Fixture files cannot be written.
    """
    source = root / "pkg/src"
    source.mkdir(parents=True)
    (source / "main.rs").write_text("fn main() {}\n")
    (source / "policy_tests.rs").write_text("#[cfg(test)] fn separately_named_test() {}\n")
    (source / "tests").mkdir()
    (source / "tests/mod.rs").write_text("#[cfg(test)] fn nested_test() {}\n")
    (source / "lib.rs").write_text("//! Library.\npub mod main;\npub use main::{Thing, Other};\n")
    metric = {"count": 3, "covered": 1, "percent": 33.3333}
    report: dict[str, Any] = {
        "type": "llvm.coverage.json.export",
        "version": "3.1.0",
        "data": [
            {
                "files": [
                    {
                        "filename": f"/runner/checkout/pkg/src/{name}",
                        "summary": {key: dict(metric) for key in ("lines", "functions", "regions")},
                    }
                    for name in ("main.rs", "policy_tests.rs", "tests/mod.rs")
                ]
            }
        ],
    }
    output = root / "pkg/coverage.json"
    output.write_text(json.dumps(report))
    signal = Signal(
        report="coverage.json",
        max_uncovered={"linux": Counts(lines=4, functions=4)},
        reporters=["text", "lcov", "json"],
        producer="llvm-cov",
        enforcement="report-only",
        reason="Native producer baseline #758",
        skip_os=["darwin"],
        skip_hosts=["wsl2"],
    )
    package = Package(
        root="pkg",
        owned=["src/**/*.rs"],
        exclusions=[],
        status="measured",
        goal="excluded",
        goal_reason="Native runtime closure #696",
        note="",
        signals={"primary": signal},
    )
    cfg = Policy(
        version=2,
        target=Counts(lines=0, functions=0, branches=0),
        enforce_target=True,
        packages={"native": package},
    )
    return cfg, report, output


def test_native_complete_source_regions_and_missing_report(tmp_path: Path) -> None:
    """Preserve test modules and region units, validate declarations, and fail without output.

    Parameters:
        tmp_path (Path): Disposable source root.
    Returns:
        None: Counts remain independent and missing reports fail closed.
    Raises:
        AssertionError: Attribution, scope, host skip or required-output checks regress.
    """
    cfg, _, output = native_fixture(tmp_path)
    results, errors = account(tmp_path, cfg, "linux")
    assert not errors
    assert len(results) == 4
    test_module = next(item for item in results if item["file"] == "src/policy_tests.rs")
    assert test_module["regions"] == 3
    assert test_module["uncovered_regions"] == 2
    assert test_module["branch_metric"] == "not-produced"
    assert next(item for item in results if item["file"] == "src/lib.rs")["regions"] == 0
    output.unlink()
    assert "No such file" in account(tmp_path, cfg, "linux", host="linux")[1][0]
    assert account(tmp_path, cfg, "darwin", host="macos") == ([], [])
    assert account(tmp_path, cfg, "linux", host="wsl2") == ([], [])


@pytest.mark.parametrize(
    "case",
    [
        "empty",
        "malformed",
        "wrong-type",
        "missing-source",
        "missing-metric",
        "duplicate",
        "invalid-count",
        "negative",
        "no-executable",
        "unknown-source",
    ],
)
def test_native_refuses_invalid_exports(tmp_path: Path, case: str) -> None:
    """Reject corruption, incomplete source maps and impossible native counters.

    Parameters:
        tmp_path (Path): Disposable source root.
        case (str): Broken producer output to exercise.
    Returns:
        None: Each invalid export yields an accounting error.
    Raises:
        AssertionError: Invalid or incomplete data reads as coverage.
    """
    cfg, report, output = native_fixture(tmp_path)
    files = report["data"][0]["files"]
    if case in {"empty", "malformed"}:
        output.write_text("" if case == "empty" else "{")
    else:
        if case == "wrong-type":
            report["type"] = "not coverage"
        elif case == "missing-source":
            files.pop()
        elif case == "missing-metric":
            del files[0]["summary"]["regions"]
        elif case == "duplicate":
            files.append(files[0])
        elif case == "invalid-count":
            files[0]["summary"]["regions"]["covered"] = 4
        elif case == "negative":
            files[0]["summary"]["lines"]["count"] = -1
        elif case == "no-executable":
            for file in files:
                for metric in file["summary"].values():
                    metric |= {"count": 0, "covered": 0}
        else:
            files[0]["filename"] = "/runner/checkout/pkg/src/unowned.rs"
        output.write_text(json.dumps(report))
    assert account(tmp_path, cfg, "linux")[1]


def test_native_present_zero_map_cannot_hide_executable_source(tmp_path: Path) -> None:
    """Reject a zero map for executable source even when other files have regions.

    Parameters:
        tmp_path (Path): Disposable source and mixed LLVM report root.
    Returns:
        None: A zeroed executable source fails while a declaration-only map passes.
    Raises:
        AssertionError: A zeroed source silently disappears from the denominator.
    """
    cfg, report, output = native_fixture(tmp_path)
    files = report["data"][0]["files"]
    for metric in files[0]["summary"].values():
        metric |= {"count": 0, "covered": 0}
    output.write_text(json.dumps(report))
    assert "zero-executable" in account(tmp_path, cfg, "linux")[1][0]
    files[0]["filename"] = "/runner/checkout/pkg/src/lib.rs"
    output.write_text(json.dumps(report))
    assert "Expected executable LLVM source missing" in account(tmp_path, cfg, "linux")[1][0]
    (tmp_path / "pkg/src/main.rs").write_text("pub mod child;\n")
    assert not account(tmp_path, cfg, "linux")[1]
    for name in ("policy_tests.rs", "tests/mod.rs"):
        (tmp_path / "pkg/src" / name).write_text("pub mod child;\n")
    for file in files:
        for metric in file["summary"].values():
            metric |= {"count": 0, "covered": 0}
    output.write_text(json.dumps(report))
    assert "Zero total native executable regions/lines" in account(tmp_path, cfg, "linux")[1][0]


def test_native_dependency_paths_and_declaration_fail_closed(tmp_path: Path) -> None:
    """Ignore external libraries, but reject executable additions to a map-free module.

    Parameters:
        tmp_path (Path): Disposable source root.
    Returns:
        None: Only structural source membership decides the native denominator.
    Raises:
        AssertionError: Dependency paths leak in or missing executable source is accepted.
    """
    cfg, report, output = native_fixture(tmp_path)
    files = report["data"][0]["files"]
    files.append({"filename": "/rustc/sysroot/library.rs", "summary": {}})
    files.append({"filename": "/runner/checkout/pkg/tests/integration.rs", "summary": {}})
    files[0]["filename"] = files[0]["filename"].replace("/", "\\")
    output.write_text(json.dumps(report))
    assert not account(tmp_path, cfg, "linux")[1]
    lib = tmp_path / "pkg/src/lib.rs"
    lib.write_text(lib.read_text() + "/* Embedded reference: examples can include fn f() {}. */\n")
    assert "Expected executable LLVM source missing: 'src/lib.rs'" in account(tmp_path, cfg, "linux")[1][0]
    lib.write_text("pub fn not_a_declaration() {}")
    assert "Expected executable LLVM source missing" in account(tmp_path, cfg, "linux")[1][0]


def test_native_cannot_be_enforced_or_add_skips(tmp_path: Path) -> None:
    """Keep native attribution report-only and prevent silently losing a platform.

    Parameters:
        tmp_path (Path): Disposable source root.
    Returns:
        None: Invalid schema and skip-ratchet changes fail.
    Raises:
        AssertionError: Native output gains an unjustified coverage target or platform skip.
    """
    cfg, _, _ = native_fixture(tmp_path)
    old = cfg.packages["native"].signals["primary"]
    with pytest.raises(ValidationError, match="remain report-only"):
        Signal.model_validate(old.model_dump() | {"enforcement": "enforced"})
    new = old.model_copy(deep=True)
    new.skip_os.append("linux")
    with pytest.raises(ValueError, match="Cannot add skipped platforms"):
        check_signal_ratchet("native/primary", new, old)


def test_native_cli_retains_region_totals_and_missing_output_control(tmp_path: Path) -> None:
    """Exercise the real accounting entrypoint, artifact replay and removal control.

    Parameters:
        tmp_path (Path): Disposable committed source/report tree.
    Returns:
        None: CLI JSON retains region units and removal fails the selected-host gate.
    Raises:
        AssertionError: Native metrics disappear or the real CLI accepts missing output.
    """
    cfg, _, output = native_fixture(tmp_path)
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["pkg"]}))
    (tmp_path / "pkg/package.json").write_text("{}")
    commit_base(tmp_path, cfg)
    args = [
        sys.executable,
        str(SCRIPT),
        "--root",
        str(tmp_path),
        "--base",
        "HEAD",
        "--os",
        "linux",
        "--summary",
        str(tmp_path / "summary.json"),
    ]
    result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 0, result.stderr
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["packages"]["native/primary"]["regions"] == 9
    assert summary["packages"]["native/primary"]["uncovered_regions"] == 6
    output.unlink()
    result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 1
    assert "No such file" in result.stderr


def windows_artifact_fixture(tmp_path: Path) -> tuple[Policy, dict[str, Any], Path, Path]:
    """Build a Windows inventory and report destination on a portable checkout.

    Parameters:
        tmp_path (Path): Disposable source and separate reports roots.
    Returns:
        tuple[Policy, dict[str, Any], Path, Path]: Policy, raw export, package report and reports root.
    Raises:
        OSError: Fixture files cannot be written.
    """
    cfg, report, _ = native_fixture(tmp_path)
    package = cfg.packages.pop("native")
    package.root = "packages/computer-use"
    package.owned = ["native/windows/bridge-rs/src/**/*.rs"]
    crate = tmp_path / package.root / "native/windows/bridge-rs"
    crate.mkdir(parents=True)
    (tmp_path / "pkg/src").rename(crate / "src")
    lib = crate / "src/lib.rs"
    lib.write_text(lib.read_text() + "/* Embedded reference: examples can include fn f() {}. */\n")
    cfg.packages["windows"] = package
    signal = Signal(
        report="coverage/native-windows/lcov.info",
        max_uncovered={"win32": Counts(lines=7, functions=7)},
        reporters=["text", "lcov", "json"],
        producer="llvm-lcov",
        platforms=["win32"],
        mapped_totals={
            "win32": {
                f"native/windows/bridge-rs/src/{name}": MappedFile(
                    sha256=sha256((crate / "src" / name).read_bytes()).hexdigest(),
                    lines=total,
                    functions=total,
                )
                for name, total in (
                    ("lib.rs", 0),
                    ("main.rs", 3),
                    ("policy_tests.rs", 3),
                    ("tests/mod.rs", 3),
                )
            }
        },
    )
    package.signals["primary"] = signal
    reports = tmp_path / "download"
    path = reports / package.root / signal.report
    path.parent.mkdir(parents=True)
    (crate / "Cargo.toml").write_text('[package]\nname = "fixture"\n')
    (crate / "Cargo.lock").write_text("version = 4\n")
    (crate / "tests").mkdir()
    (crate / "tests/protocol.rs").write_text("#[test] fn protocol() {}\n")
    source_hashes = {
        name: sha256((crate / name).read_bytes()).hexdigest()
        for name in (
            "Cargo.toml",
            "Cargo.lock",
            "src/lib.rs",
            "src/main.rs",
            "src/policy_tests.rs",
            "src/tests/mod.rs",
            "tests/protocol.rs",
        )
    }
    path.with_name("metadata.json").write_text(json.dumps({"sourceHashes": source_hashes}))
    return cfg, report, path, reports


def windows_export(report: dict[str, Any], sysroot: str = "library") -> tuple[list[dict[str, Any]], str]:
    """Point a fixture export at a Windows checkout and render the LCOV that matches it.

    Parameters:
        report (dict[str, Any]): Raw export from `native_fixture`, changed in place.
        sysroot (str): Sysroot directory of the appended dependency file.
    Returns:
        tuple[list[dict[str, Any]], str]: JSON file records, with the ignored sysroot last, and LCOV.
    Raises:
        None.
    """
    files = report["data"][0]["files"]
    prefix = r"D:\a\repo\repo\packages\computer-use\native\windows\bridge-rs"
    for file in files:
        relative = file["filename"].split("/src/")[1].replace("/", "\\")
        file["filename"] = f"{prefix}\\src\\{relative}"
    files.append({"filename": f"{prefix}\\rustc\\{'a' * 40}\\{sysroot}\\std\\thread_local.rs", "summary": {}})
    return files, "".join(windows_record(file) for file in files)


def windows_record(file: dict[str, Any]) -> str:
    """Render one LLVM LCOV record whose summaries agree with the JSON file record.

    Parameters:
        file (dict[str, Any]): JSON file record; an empty summary renders the default totals.
    Returns:
        str: LCOV record with instantiation-style function rows.
    Raises:
        None.
    """
    summary = file["summary"]
    lines = summary["lines"]["count"] if summary else 3
    functions = summary["functions"]["count"] if summary else 3
    return (
        f"SF:{file['filename']}\nFN:1,first\nFN:1,second\nFN:2,third\nFN:2,fourth\n"
        "FNDA:1,first\nFNDA:0,second\nFNDA:0,third\nFNDA:0,fourth\nDA:1,1\n"
        f"LF:{lines}\nLH:1\nFNF:{functions}\nFNH:1\nBRF:0\nBRH:0\nend_of_record\n"
    )


def alter_windows_metadata(path: Path, source: Path, case: str) -> None:
    """Simulate missing, malformed, or stale producer metadata in a valid report pair.

    Parameters:
        path (Path): LCOV report path beside the metadata.
        source (Path): Checkout source path to alter for the stale case.
        case (str): Fixture corruption, if any.
    Returns:
        None.
    Raises:
        OSError: A fixture input cannot be read or modified.
    """
    metadata = path.with_name("metadata.json")
    if case == "missing-metadata":
        metadata.unlink()
    if case == "malformed-metadata":
        metadata.write_text("{}")
    if case == "older-inputs":
        # The source paths and executable counters still match after this edit.
        source.write_text(source.read_text() + "// Changed after the older report pair.\n")


def alter_windows_counters(lcov: str, files: list[dict[str, Any]], signal: Signal, case: str) -> str:
    """Corrupt detail or covered totals without changing source membership or denominators.

    Parameters:
        lcov (str): Matching LCOV export.
        files (list[dict[str, Any]]): JSON records, with ignored sysroot last.
        signal (Signal): Policy signal whose cap is tightened in the forged case.
        case (str): Fixture corruption, if any.
    Returns:
        str: LCOV text for the selected case.
    Raises:
        None.
    """
    if case == "stale-totals":
        files[0]["summary"]["lines"]["covered"] = 0
    if case == "stale-function-totals":
        files[0]["summary"]["functions"]["covered"] = 0
    if case == "forged-hits":
        for file in files[:-1]:
            for metric in ("lines", "functions"):
                summary = file["summary"][metric]
                summary["covered"] = summary["count"]
        lcov = lcov.replace("LH:1", "LH:3").replace("FNH:1", "FNH:3")
        lcov = lcov.replace("FNDA:1,first", "FNDA:0,first").replace("DA:1,1", "DA:1,0")
        signal.max_uncovered["win32"] = Counts(lines=0, functions=0)
    if case == "stripped-detail":
        lcov = "".join(
            row for row in lcov.splitlines(keepends=True) if not row.startswith(("DA:", "FN:", "FNDA:"))
        )
    return lcov


@pytest.mark.parametrize(
    ("case", "error"),
    [
        ("valid", ""),
        ("missing-lcov", "No such file"),
        ("missing-json", "No such file"),
        ("missing-metadata", "Cannot read Windows coverage metadata"),
        ("malformed-metadata", "Cannot read Windows coverage metadata"),
        ("older-inputs", "metadata source hashes differ"),
        ("missing-source", "source lists differ"),
        ("stale-totals", "counters differ"),
        ("stale-function-totals", "counters differ"),
        ("forged-hits", "Inconsistent LLVM LCOV line detail"),
        ("stripped-detail", "Inconsistent LLVM LCOV line detail"),
        ("over-budget", "Budget exceeded"),
        ("missing-floor", "Missing OS floor"),
        ("sysroot-lookalike", "LLVM source outside inventory"),
    ],
)
def test_windows_llvm_lcov_requires_a_matching_native_export(tmp_path: Path, case: str, error: str) -> None:
    """Gate Windows by source totals, not LCOV instantiations or Linux coverage.

    Parameters:
        tmp_path (Path): Disposable source and separate reports roots.
        case (str): Corruption or policy change to introduce, if any.
        error (str): Expected failed validation, empty for a valid report.
    Returns:
        None: Only the Windows signal gates Windows reports.
    Raises:
        AssertionError: The coverage reader accepts invalid inputs or miscounts the producer units.
    """
    cfg, report, path, reports = windows_artifact_fixture(tmp_path)
    signal = cfg.packages["windows"].signals["primary"]
    files, lcov = windows_export(report, "src" if case == "sysroot-lookalike" else "library")
    if case == "missing-source":
        lcov = lcov.split("end_of_record\n", 1)[1]
    lcov = alter_windows_counters(lcov, files, signal, case)
    if case == "over-budget":
        signal.max_uncovered["win32"].lines = 5
    if case == "missing-floor":
        del signal.max_uncovered["win32"]
    alter_windows_metadata(
        path, tmp_path / "packages/computer-use/native/windows/bridge-rs/src/main.rs", case
    )
    if case != "missing-lcov":
        path.write_text(lcov)
    if case != "missing-json":
        path.with_name("coverage.json").write_text(json.dumps(report))
    assert account(tmp_path, cfg, "linux") == ([], [])
    assert account(tmp_path, cfg, "darwin") == ([], [])
    results, failures = account(tmp_path, cfg, "win32", reports)
    if error:
        assert len(failures) == 1
        assert error in failures[0]
    else:
        assert not failures
        assert len(results) == 4
        assert sum(int(str(row["uncovered_regions"])) for row in results) == 6
        assert all(row["statements"] is None and "branches" not in row for row in results)


@pytest.mark.parametrize(
    ("original", "replacement", "error"),
    [
        ("LF:3\n", "", "Missing LLVM LCOV totals"),
        ("LH:1\n", "", "Missing LLVM LCOV totals"),
        ("FNF:3\n", "", "Missing LLVM LCOV totals"),
        ("FNH:1\n", "", "Missing LLVM LCOV totals"),
        ("LH:1\n", "LH:4\n", "Inconsistent LLVM LCOV totals"),
        ("FNH:1\n", "FNH:4\n", "Inconsistent LLVM LCOV totals"),
    ],
)
def test_llvm_rejects_each_missing_or_impossible_total(original: str, replacement: str, error: str) -> None:
    """Change one field at a time so invalid line totals never mask invalid function totals.

    Parameters:
        original (str): Valid counter row to replace.
        replacement (str): Invalid counter row or empty string to remove it.
        error (str): Expected parser error.
    Returns:
        None.
    Raises:
        AssertionError: The parser accepts the mutated record.
    """
    lcov = "SF:src/main.rs\nLF:3\nLH:1\nFNF:3\nFNH:1\nend_of_record\n"
    with pytest.raises(ValueError, match=error):
        parse_lcov(lcov.replace(original, replacement), llvm=True)


@pytest.mark.parametrize(
    ("totals", "detail", "metric"),
    [
        ("LF:2\nLH:1\nFNF:1\nFNH:1", "DA:1,0\n", "line"),
        ("LF:1\nLH:1\nFNF:1\nFNH:1", "DA:1,1\nDA:2,1\n", "line"),
        ("LF:2\nLH:2\nFNF:1\nFNH:1", "DA:1,1\nDA:2,0\n", "line"),
        ("LF:1\nLH:1\nFNF:1\nFNH:1", "DA:1,1\nFN:1,f\nFNDA:0,f\n", "function"),
        ("LF:1\nLH:1\nFNF:3\nFNH:1", "DA:1,1\nFN:1,f\nFNDA:1,f\n", "function"),
        ("LF:1\nLH:1\nFNF:1\nFNH:1", "DA:1,1\n", "function"),
    ],
)
def test_llvm_rejects_inconsistent_detail(totals: str, detail: str, metric: str) -> None:
    """Check each kind of contradiction independently, in LLVM's distinct row and summary units.

    Parameters:
        totals (str): LLVM summary rows.
        detail (str): LLVM detailed rows.
        metric (str): Metric with contradictory evidence.
    Returns:
        None: The contradiction is rejected.
    Raises:
        AssertionError: Inconsistent detail is accepted.
    """
    with pytest.raises(ValueError, match=f"Inconsistent LLVM LCOV {metric} detail"):
        parse_lcov(f"SF:src/main.rs\n{detail}{totals}\nend_of_record\n", llvm=True)


@pytest.mark.parametrize(
    ("producer", "uses_llvm"),
    [
        ("llvm-cov", True),
        ("llvm-lcov", True),
        ("llvm-unknown", False),
        ("lcov", False),
        ("coverage.py", False),
    ],
)
def test_llvm_producer_selection_is_explicit(producer: str, uses_llvm: bool) -> None:
    """Do not infer LLVM report semantics from a shared name prefix.

    Parameters:
        producer (str): Supported or unknown producer name.
        uses_llvm (bool): Whether the producer should use LLVM source counters.
    Returns:
        None.
    Raises:
        AssertionError: The predicate misclassifies the producer.
    """
    assert is_llvm_producer(producer) is uses_llvm


def test_windows_native_policy_cannot_loosen_or_remove_platform() -> None:
    """Ratchet the real Windows policy and never attribute it to Linux or macOS.

    Parameters:
        None.
    Returns:
        None: Windows caps cannot increase and the Windows platform cannot be dropped.
    Raises:
        AssertionError: The real policy or its ratchet no longer protects Windows x64.
    """
    root = Path(__file__).resolve().parents[2]
    cfg = Policy.model_validate_json((root / "coverage/policy.json").read_text())
    old = cfg.packages["computer-use-windows-native"].signals["primary"]
    assert old.platforms == ["win32"]
    assert old.enforcement == "enforced"
    new = old.model_copy(deep=True)
    new.max_uncovered["win32"].functions += 1
    with pytest.raises(ValueError, match=r"Ratchet violation.*win32"):
        check_signal_ratchet("computer-use-windows-native/primary", new, old)
    new.platforms = ["linux"]
    with pytest.raises(ValueError, match="Cannot remove measured platforms"):
        check_signal_ratchet("computer-use-windows-native/primary", new, old)


MAIN_RS = "native/windows/bridge-rs/src/main.rs"
CRATE = "packages/computer-use/native/windows/bridge-rs"


def write_windows_reports(report: dict[str, Any], path: Path, case: str, checkout: Path) -> None:
    """Write a matching Windows pair after an instrumentation or source change.

    Parameters:
        report (dict[str, Any]): Raw export from `windows_artifact_fixture`.
        path (Path): LCOV report path; the JSON export and metadata sit beside it.
        case (str): `shrunk-lines`, `shrunk-functions`, `report-only` and `changed-source` drop one
            mapped unit from `main.rs` and `grown` adds one; `changed-source` also edits `main.rs`
            with matching producer metadata. Other cases write the unchanged pair.
        checkout (Path): Source checkout holding the Windows crate.
    Returns:
        None.
    Raises:
        OSError: A fixture file cannot be written.
    """
    files = report["data"][0]["files"]
    main = next(file for file in files if file["filename"].endswith("/main.rs"))
    if case in {"shrunk-lines", "shrunk-functions", "grown", "changed-source", "report-only"}:
        metric = "functions" if case == "shrunk-functions" else "lines"
        main["summary"][metric]["count"] += 1 if case == "grown" else -1
    _, lcov = windows_export(report)
    path.write_text(lcov)
    path.with_name("coverage.json").write_text(json.dumps(report))
    if case == "changed-source":
        crate = checkout / CRATE
        metadata = path.with_name("metadata.json")
        hashes = json.loads(metadata.read_text())
        (crate / "src/main.rs").write_text("fn main() { work(); }\n")
        hashes["sourceHashes"]["src/main.rs"] = sha256((crate / "src/main.rs").read_bytes()).hexdigest()
        metadata.write_text(json.dumps(hashes))


@pytest.mark.parametrize(
    ("case", "error", "stale"),
    [
        ("unchanged", "", []),
        ("grown", "", []),
        ("changed-source", "", [MAIN_RS]),
        ("report-only", "", []),
        ("new-file", "", ["native/windows/bridge-rs/src/lib.rs"]),
        ("left-changed", "", ["native/windows/bridge-rs/tests/protocol.rs"]),
        ("shrunk-lines", f"'{MAIN_RS}' lines 3 -> 2, functions 3 -> 3", []),
        ("shrunk-functions", f"'{MAIN_RS}' lines 3 -> 3, functions 3 -> 2", []),
        ("left-signal", "'native/windows/bridge-rs/tests/protocol.rs' lines 1 -> 0", []),
        ("missing-os", "Missing mapped totals", "all"),
    ],
)
def test_windows_mapped_totals_refuse_a_shrinking_denominator(
    tmp_path: Path, case: str, error: str, stale: list[str] | str, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail when both exports lose mapped units of unchanged source, and list unguarded files.

    Parameters:
        tmp_path (Path): Disposable source and separate reports roots.
        case (str): Instrumentation, source or policy change.
        error (str): Expected failure, empty when the run passes.
        stale (list[str] | str): Files `stale_mapped_totals` lists, or `all` for every measured file.
        caplog (pytest.LogCaptureFixture): Stale-record warnings.
    Returns:
        None.
    Raises:
        AssertionError: A smaller agreeing denominator passes, a real source change fails, or an
            unguarded file goes unlisted.
    """
    cfg, report, path, reports = windows_artifact_fixture(tmp_path)
    signal = cfg.packages["windows"].signals["primary"]
    mapped = signal.mapped_totals["win32"]
    if case == "report-only":
        signal.enforcement = "report-only"
        signal.reason = "Fixture"
    if case in {"left-signal", "left-changed"}:
        # A recorded source outside this run's records, e.g. reclassified without a source change.
        protocol = tmp_path / CRATE / "tests/protocol.rs"
        digest = sha256(protocol.read_bytes()).hexdigest() if case == "left-signal" else "0" * 64
        mapped["native/windows/bridge-rs/tests/protocol.rs"] = MappedFile(sha256=digest, lines=1, functions=0)
    if case == "new-file":
        # A file the run measures that no record guards yet.
        del mapped["native/windows/bridge-rs/src/lib.rs"]
    if case == "missing-os":
        signal.mapped_totals = {}
    write_windows_reports(report, path, case, tmp_path)
    results, failures = account(tmp_path, cfg, "win32", reports)
    assert failures == ([f"windows/primary: {failures[0].split(': ', 1)[1]}"] if error else [])
    if error:
        assert error in failures[0]
        assert ("Mapped totals shrank without a source change" in failures[0]) != (case == "missing-os")
        assert "`--measure`" in failures[0]
    else:
        assert len(results) == 4
    measured = measured_mapped_totals(tmp_path, cfg, results, "win32")
    expected = sorted(measured["windows/primary"]["win32"]) if stale == "all" else stale
    listed = stale_mapped_totals(tmp_path, cfg, measured, "win32")
    assert listed == ({"windows/primary": {"win32": expected}} if expected else {})
    assert ("STALE mapped totals, not compared (#1270)" in caplog.text) == bool(expected)
    if expected:
        with pytest.raises(ValueError, match=r"Stale mapped totals \(#1270\).*'windows/primary/win32'"):
            check_stale_mapped_totals(cfg, listed)
    else:
        check_stale_mapped_totals(cfg, listed)
    # Measurement replays never gate on recorded totals.
    assert account(tmp_path, cfg, "win32", reports, measure=True)[1] == []


def test_stale_mapped_totals_fail_only_enforced_signals(tmp_path: Path) -> None:
    """Fail an enforced signal on unguarded files; report-only signals and replays keep the warning.

    Parameters:
        tmp_path (Path): Disposable source and separate reports roots.
    Returns:
        None.
    Raises:
        AssertionError: Stale files of an enforced signal pass, or a replay or report-only signal fails.
    """
    cfg = windows_artifact_fixture(tmp_path)[0]
    signal = cfg.packages["windows"].signals["primary"]
    stale = {"windows/primary": {"win32": [MAIN_RS]}}
    with pytest.raises(ValueError, match=rf"'windows/primary/win32' \['{MAIN_RS}'\]$") as raised:
        check_stale_mapped_totals(cfg, stale)
    assert "replay the matching hosted coverage artifact against the source checkout" in str(raised.value)
    assert "`scripts/coverage_accounting.py --measure`, see docs/coverage.md" in str(raised.value)
    assert "update `mapped_totals` in coverage/policy.json" in str(raised.value)
    assert "needs no `remeasurements` entry" in str(raised.value)
    check_stale_mapped_totals(cfg, {})
    check_stale_mapped_totals(cfg, stale, measure=True)
    signal.enforcement = "report-only"
    signal.reason = "Fixture"
    check_stale_mapped_totals(cfg, stale)


def ratchet_fixture(tmp_path: Path) -> tuple[Policy, Policy, MappedFile]:
    """Pair a base policy that recorded Windows totals with an identical current policy.

    Parameters:
        tmp_path (Path): Disposable checkout.
    Returns:
        tuple[Policy, Policy, MappedFile]: Current policy, base policy and the base `main.rs` record.
    Raises:
        OSError: Fixture files cannot be written.
    """
    base, _, _, _ = windows_artifact_fixture(tmp_path)
    return (
        base.model_copy(deep=True),
        base,
        base.packages["windows"].signals["primary"].mapped_totals["win32"][MAIN_RS],
    )


@pytest.mark.parametrize(
    ("change", "source", "outcome"),
    [
        ("none", "same", "ok"),
        ("none", "edited", "ok"),
        ("grow", "same", "ok"),
        ("add", "same", "ok"),
        ("lower-lines", "same", "entry"),
        ("lower-functions", "same", "entry"),
        ("drop", "same", "entry"),
        ("drop-os", "same", "entry"),
        ("refresh", "edited", "ok"),
        ("drop", "edited", "entry"),
        ("drop", "deleted", "ok"),
        ("rehash", "same", "hash"),
        ("rehash", "edited", "hash"),
        ("lower-lines", "edited", "hash"),
        ("add-wrong", "same", "hash"),
    ],
)
def test_lowering_recorded_totals_needs_a_reviewed_remeasurement(
    tmp_path: Path, change: str, source: str, outcome: str
) -> None:
    """Lowering or dropping a live record needs an entry; every edited record must hash the checkout.

    Parameters:
        tmp_path (Path): Disposable checkout.
        change (str): Edit to the current `main.rs` record or its OS. `refresh` records the edited
            source's hash with fewer lines; `add` and `add-wrong` record a new file with its own or a
            zero hash; `rehash` records a zero hash.
        source (str): Whether `main.rs` is the same as recorded in the base, edited or deleted.
        outcome (str): `ok` passes without an entry, `entry` needs a new `remeasurements` entry and
            `hash` refuses even with one.
    Returns:
        None.
    Raises:
        AssertionError: A shrink passes unreviewed, a wrong hash is accepted, or a refresh is refused.
    """
    current, base, before = ratchet_fixture(tmp_path)
    change_main_record(tmp_path, current.packages["windows"].signals["primary"], before, change, source)
    hashed = "Mapped totals must hash the checkout source; replay a matching artifact with `--measure`"
    if outcome == "entry":
        with pytest.raises(ValueError, match=r"new `remeasurements`: .*'windows', 'primary', 'win32'"):
            check_remeasurements(current, base, tmp_path)
    elif outcome == "hash":
        with pytest.raises(ValueError, match=re.escape(hashed)):
            check_remeasurements(current, base, tmp_path)
    else:
        check_remeasurements(current, base, tmp_path)
    current.remeasurements = [Remeasurement(package="windows", signal="primary", os="win32", reason="Run 1")]
    if outcome == "entry":
        check_remeasurements(current, base, tmp_path)
    elif outcome == "hash":
        with pytest.raises(ValueError, match=re.escape(hashed)):
            check_remeasurements(current, base, tmp_path)
    else:
        with pytest.raises(ValueError, match="Duplicate or stale `remeasurements` entry"):
            check_remeasurements(current, base, tmp_path)


def change_main_record(checkout: Path, signal: Signal, before: MappedFile, change: str, source: str) -> None:
    """Apply one `main.rs` source change and one record change for the remeasurement ratchet cases.

    Parameters:
        checkout (Path): Disposable checkout.
        signal (Signal): Current Windows signal, changed in place.
        before (MappedFile): Base `main.rs` record.
        change (str): Edit to the current `main.rs` record or its OS.
        source (str): `same`, `edited` or `deleted` `main.rs`.
    Returns:
        None.
    Raises:
        OSError: A fixture file cannot be written.
    """
    records = signal.mapped_totals["win32"]
    main = checkout / "packages/computer-use" / MAIN_RS
    if source == "edited":
        main.write_text("fn main() { work(); }\n")
    if source == "deleted":
        main.unlink()
    if change == "grow":
        records[MAIN_RS] = before.model_copy(update={"lines": 4})
    if change in {"add", "add-wrong"}:
        added = checkout / CRATE / "src/added.rs"
        added.write_text("fn added() {}\n")
        digest = sha256(added.read_bytes()).hexdigest() if change == "add" else "0" * 64
        records["native/windows/bridge-rs/src/added.rs"] = MappedFile(sha256=digest, lines=1, functions=1)
    if change == "lower-lines":
        records[MAIN_RS] = before.model_copy(update={"lines": 2})
    if change == "lower-functions":
        records[MAIN_RS] = before.model_copy(update={"functions": 2})
    if change == "refresh":
        records[MAIN_RS] = MappedFile(sha256=sha256(main.read_bytes()).hexdigest(), lines=2, functions=2)
    if change == "drop":
        del records[MAIN_RS]
    if change == "drop-os":
        signal.mapped_totals = {}
    if change == "rehash":
        # A mistyped replacement hash must not turn a remeasurement into a permanent stale opt-out.
        records[MAIN_RS] = before.model_copy(update={"sha256": "0" * 64})


def test_new_signal_records_must_hash_the_checkout(tmp_path: Path) -> None:
    """Records with no base package or signal are new: they need the checkout's hash and no entry.

    Parameters:
        tmp_path (Path): Disposable checkout.
    Returns:
        None.
    Raises:
        AssertionError: A new record with a wrong hash passes, or a correct one is refused.
    """
    current, base, before = ratchet_fixture(tmp_path)
    del base.packages["windows"].signals["primary"]
    check_remeasurements(current, base, tmp_path)
    del base.packages["windows"]
    check_remeasurements(current, base, tmp_path)
    current.packages["windows"].signals["primary"].mapped_totals["win32"][MAIN_RS] = before.model_copy(
        update={"sha256": "0" * 64}
    )
    with pytest.raises(ValueError, match=rf"windows/primary/win32 '{re.escape(MAIN_RS)}'"):
        check_remeasurements(current, base, tmp_path)
    # Without a checkout to hash, only the ledger applies.
    check_remeasurements(current, base, None)


def test_remeasurement_ledger_is_fresh_exact_and_reasoned(tmp_path: Path) -> None:
    """Base entries never justify a new shrink, duplicates refuse and a reason is mandatory.

    Parameters:
        tmp_path (Path): Disposable checkout.
    Returns:
        None.
    Raises:
        AssertionError: The ledger accepts a reused, duplicate or blank declaration.
    """
    current, base, before = ratchet_fixture(tmp_path)
    entry = Remeasurement(package="windows", signal="primary", os="win32", reason="Run 1")
    base.remeasurements = [entry]
    current.remeasurements = [entry]
    check_remeasurements(current, base, tmp_path)
    current.packages["windows"].signals["primary"].mapped_totals["win32"][MAIN_RS] = before.model_copy(
        update={"lines": 2}
    )
    with pytest.raises(ValueError, match="requires new `remeasurements`"):
        check_remeasurements(current, base, tmp_path)
    fresh = entry.model_copy(update={"reason": "Run 2"})
    for duplicated in ([entry, fresh, fresh], [entry, entry, fresh]):
        # A repeated historical copy is a duplicate too, not a skipped base entry.
        current.remeasurements = duplicated
        with pytest.raises(ValueError, match="Duplicate or stale `remeasurements` entry"):
            check_remeasurements(current, base, tmp_path)
    current.remeasurements = [entry, fresh]
    check_remeasurements(current, base, tmp_path)
    # Without a checkout to hash, every recorded source counts as unchanged.
    current.remeasurements = [entry]
    with pytest.raises(ValueError, match="requires new `remeasurements`"):
        check_remeasurements(current, base, None)
    # `check_ratchet` applies the ledger before its package checks.
    with pytest.raises(ValueError, match="requires new `remeasurements`"):
        check_ratchet(current, base)
    with pytest.raises(ValidationError, match="nonblank reason"):
        Remeasurement(package="windows", signal="primary", os="win32", reason=" ")


def test_removed_package_or_signal_is_left_to_the_base_ratchet(tmp_path: Path) -> None:
    """Removed signals have no mapped totals to compare; `check_ratchet` decides their removal.

    Parameters:
        tmp_path (Path): Disposable checkout.
    Returns:
        None.
    Raises:
        AssertionError: A removal is attributed to mapped totals.
    """
    current, base, _ = ratchet_fixture(tmp_path)
    del current.packages["windows"].signals["primary"]
    assert weakened_mapped_totals(current, base, tmp_path) == set()
    del current.packages["windows"]
    assert weakened_mapped_totals(current, base, tmp_path) == set()
    with pytest.raises(ValueError, match="Removed package: 'windows'"):
        check_ratchet(current, base)


@pytest.mark.parametrize(
    ("mapped", "error"),
    [
        ({"win32": {}}, "package-relative files on a measured platform"),
        ({"linux": {"main.rs": {"sha256": "0" * 64, "lines": 1, "functions": 1}}}, "measured platform"),
        ({"win32": {"main.rs": {"sha256": "0" * 63, "lines": 1, "functions": 1}}}, "String should match"),
        ({"win32": {"main.rs": {"sha256": "0" * 64, "lines": -1, "functions": 1}}}, "greater than or equal"),
    ],
)
def test_mapped_totals_schema(mapped: dict[str, Any], error: str) -> None:
    """Reject vacuous, off-platform or malformed records.

    Parameters:
        mapped (dict[str, Any]): Invalid `mapped_totals` declaration.
        error (str): Expected validation message.
    Returns:
        None.
    Raises:
        AssertionError: The schema accepts the declaration.
    """
    with pytest.raises(ValidationError, match=error):
        mapped_signal(mapped)


def mapped_signal(mapped: dict[str, Any]) -> Signal:
    """Validate a minimal Windows signal around one `mapped_totals` declaration.

    Parameters:
        mapped (dict[str, Any]): `mapped_totals` declaration.
    Returns:
        Signal: Validated signal.
    Raises:
        ValidationError: The declaration is invalid.
    """
    return Signal.model_validate(
        {
            "report": "lcov.info",
            "producer": "llvm-lcov",
            "platforms": ["win32"],
            "max_uncovered": {"win32": {"lines": 1, "functions": 1}},
            "reporters": ["text", "lcov"],
            "mapped_totals": mapped,
        }
    )


@pytest.mark.parametrize(
    ("key", "valid"),
    [
        ("native/windows/bridge-rs/src/main.rs", True),
        ("main.rs", True),
        ("", False),
        ("/abs/main.rs", False),
        ("../main.rs", False),
        ("src/../main.rs", False),
        ("./main.rs", False),
        ("src//main.rs", False),
        ("src/", False),
        ("src\\main.rs", False),
        ("C:/src/main.rs", False),
        ("C:main.rs", False),
        ("\\\\server\\share\\main.rs", False),
    ],
)
def test_mapped_totals_keys_are_canonical_posix_paths(key: str, valid: bool) -> None:
    """Validate keys as package-relative POSIX strings on every host, never as host paths.

    Parameters:
        key (str): Recorded file key.
        valid (bool): Whether it is a canonical package-relative POSIX path.
    Returns:
        None.
    Raises:
        AssertionError: A drive, backslash, absolute or noncanonical key is accepted, or a canonical one
            is refused.
    """
    mapped = {"win32": {key: {"sha256": "0" * 64, "lines": 1, "functions": 1}}}
    if valid:
        assert list(mapped_signal(mapped).mapped_totals["win32"]) == [key]
    else:
        with pytest.raises(ValidationError, match="package-relative files on a measured platform"):
            mapped_signal(mapped)


@pytest.mark.parametrize("case", ["shrunk-lines", "changed-source"])
def test_windows_cli_proposes_and_records_mapped_totals(tmp_path: Path, case: str) -> None:
    """The real entrypoint replays an artifact, records totals, lists stale files and proposes a refresh.

    Parameters:
        tmp_path (Path): Disposable committed checkout and separate reports root.
        case (str): `shrunk-lines` fails on unchanged source; `changed-source` fails with `main.rs`
            listed stale until its proposed refresh is recorded.
    Returns:
        None.
    Raises:
        AssertionError: The summary or the review diff lacks current mapped totals or the stale list.
    """
    cfg, report, path, reports = windows_artifact_fixture(tmp_path)
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["packages/*"]}))
    (tmp_path / "packages/computer-use/package.json").write_text("{}")
    write_windows_reports(report, path, case, tmp_path)
    commit_base(tmp_path, cfg)
    summary = tmp_path / "summary.json"
    common = [sys.executable, str(SCRIPT), "--root", str(tmp_path), "--os", "win32"]
    common += ["--reports-root", str(reports), "--summary", str(summary)]
    gate = subprocess.run(
        [*common, "--base", "HEAD"], capture_output=True, text=True, check=False, timeout=30
    )
    digest = sha256((tmp_path / "packages/computer-use" / MAIN_RS).read_bytes()).hexdigest()
    written = json.loads(summary.read_text())
    if case == "shrunk-lines":
        assert gate.returncode == 1
        assert "Mapped totals shrank without a source change" in gate.stderr
        assert written["stale_mapped_totals"] == {}
    else:
        # A source edit fails until the same PR records a reviewed refresh (#1270).
        assert gate.returncode == 1
        assert "STALE mapped totals, not compared (#1270)" in gate.stderr
        assert [error.split(":")[0] for error in written["errors"]] == ["Stale mapped totals (#1270)"]
        assert written["stale_mapped_totals"] == {"windows/primary": {"win32": [MAIN_RS]}}
    measured = written["measured_mapped_totals"]["windows/primary"]["win32"]
    assert measured[MAIN_RS] == {"sha256": digest, "lines": 2, "functions": 3}
    assert len(measured) == 4
    replay = subprocess.run([*common, "--measure"], capture_output=True, text=True, check=True, timeout=30)
    assert re.search(r'^\+\s+"lines": 2,$', replay.stderr, re.MULTILINE)
    assert re.search(r'^-\s+"lines": 3,$', replay.stderr, re.MULTILINE)
    refreshed = re.search(rf'^\+\s+"sha256": "{digest}",$', replay.stderr, re.MULTILINE)
    assert (refreshed is not None) == (case == "changed-source")
    if case == "changed-source":
        # Recording the proposed refresh of the edited source passes with no `remeasurements` entry.
        cfg.packages["windows"].signals["primary"].mapped_totals["win32"] = {
            path: MappedFile.model_validate(record) for path, record in measured.items()
        }
        (tmp_path / "coverage/policy.json").write_text(cfg.model_dump_json())
        rerun = subprocess.run(
            [*common, "--base", "HEAD"], capture_output=True, text=True, check=False, timeout=30
        )
        assert rerun.returncode == 0, rerun.stderr
        assert json.loads(summary.read_text())["stale_mapped_totals"] == {}
