"""Exercise source-complete LLVM native accounting without a desktop or compiler.

References:
    ../../docs/coverage.md
    https://llvm.org/docs/CommandGuide/llvm-cov.html
"""

from __future__ import annotations

import json
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
    Package,
    Policy,
    Signal,
    account,
    check_signal_ratchet,
    is_llvm_producer,
    parse_lcov,
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
    files = report["data"][0]["files"]
    prefix = r"D:\a\repo\repo\packages\computer-use\native\windows\bridge-rs"
    for file in files:
        relative = file["filename"].split("/src/")[1].replace("/", "\\")
        file["filename"] = f"{prefix}\\src\\{relative}"
    sysroot = f"\\rustc\\{'a' * 40}\\library\\std\\thread_local.rs"
    if case == "sysroot-lookalike":
        sysroot = sysroot.replace("library", "src")
    files.append({"filename": prefix + sysroot, "summary": {}})
    rows = (
        "\nFN:1,first\nFN:1,second\nFN:2,third\nFN:2,fourth\n"
        "FNDA:1,first\nFNDA:0,second\nFNDA:0,third\nFNDA:0,fourth\nDA:1,1\n"
        "LF:3\nLH:1\nFNF:3\nFNH:1\nBRF:0\nBRH:0\nend_of_record\n"
    )
    lcov = "".join(f"SF:{file['filename']}{rows}" for file in files)
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
