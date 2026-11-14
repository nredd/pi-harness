"""Exercise source-complete LLVM native accounting without a desktop or compiler.

References:
    ../../docs/coverage.md
    https://llvm.org/docs/CommandGuide/llvm-cov.html
"""

from __future__ import annotations

import json
import subprocess
import sys
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
    (tmp_path / "pkg/src/lib.rs").write_text("pub fn not_a_declaration() {}")
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
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["packages"]["native/primary"]["regions"] == 9
    assert summary["packages"]["native/primary"]["uncovered_regions"] == 6
    output.unlink()
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "No such file" in result.stderr
