"""Exercise both helper producers with real Bun reports and an unimported owned gate.

References:
    https://github.com/nredd/pi-harness/issues/972
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import ROOT, policy

from coverage_accounting import Counts, Policy, account


@pytest.mark.parametrize("producer", ["probes", "import-audit"])
def test_real_bun_helper_reports_fail_closed(tmp_path: Path, producer: str) -> None:
    """Require actual unimported-source counters and refuse damaged independent reports.

    Parameters:
        tmp_path (Path): Disposable project and source inventory, never the user's home.
        producer (str): Real repository config whose launcher/report contract is exercised.
    Returns:
        None: Missing, malformed and real nonzero L/F/B/S evidence all refuse accounting.
    Raises:
        AssertionError: The launcher loses source, weakens thresholds or accepts invalid reports.
    """
    node = shutil.which("node")
    assert node, "Node is required to launch the real pinned Bun"
    bun = shutil.which("bun")
    assert bun, "The pinned Bun is required, not a skipped check"
    assert (
        subprocess.check_output([bun, "--version"], text=True, stderr=subprocess.STDOUT).strip()
        == (ROOT / ".bun-version").read_text().strip()
    )
    directory = tmp_path / "packages/example"
    directory.mkdir(parents=True)
    (directory / "package.json").write_text('{"type":"module"}\n')
    (directory / "src").mkdir()
    (directory / "src/index.ts").write_text("export const called = 1;\n")
    (directory / "src/never.ts").write_text(
        'export function gate(allowed: boolean) { if (!allowed) throw new Error("refused"); return 42; }\n'
    )
    vitest = (ROOT / "node_modules/vitest/dist/index.js").as_uri()
    suite = directory / "probe.test.ts"
    suite.write_text(
        f"import {{ test, expect }} from {json.dumps(vitest)};\n"
        'import { called } from "./src/index.ts";\n'
        'test("called", () => expect(called).toBe(1));\n'
    )
    cfg_path = ROOT / (
        "integration/probes/vitest.config.ts" if producer == "probes" else "scripts/vitest.config.ts"
    )
    (directory / "vitest.config.ts").write_text(
        f"import original from {json.dumps(cfg_path.as_uri())};\n"
        "export default { ...original, root: import.meta.dirname, test: { ...original.test, "
        'include: ["probe.test.ts"], maxWorkers: 1, fileParallelism: false, '
        'coverage: { ...original.test.coverage, include: ["src/*.ts"], exclude: [], '
        'reportsDirectory: "coverage/bun" } } };\n'
    )
    argv = [node, str(ROOT / "scripts/run-vitest.ts"), "bun", "--coverage.reportsDirectory=coverage/bun"]
    missed = subprocess.run(argv, cwd=directory, capture_output=True, text=True, check=False)
    assert missed.returncode != 0, missed.stdout + missed.stderr
    report = directory / "coverage/bun/lcov.info"
    assert "SF:src/never.ts" in report.read_text()
    cfg = policy()
    package = cfg.packages["example"]
    package.signals["primary"].report = "coverage/bun/lcov.info"
    package.signals["primary"].files = None
    package.signals["primary"].reporters = ["text", "lcov", "json-summary"]
    package.signals["primary"].max_uncovered = {
        os: Counts(lines=0, functions=0, branches=0, statements=0) for os in ("darwin", "linux")
    }
    package.signals["bun"] = package.signals["primary"].model_copy(deep=True)
    package.signals["primary"].report = "coverage/primary/lcov.info"
    node_argv = [
        node,
        str(ROOT / "scripts/run-vitest.ts"),
        "node",
        "--coverage",
        "--coverage.reportsDirectory=coverage/primary",
    ]
    node_missed = subprocess.run(node_argv, cwd=directory, capture_output=True, text=True, check=False)
    assert node_missed.returncode != 0, node_missed.stdout + node_missed.stderr
    rows, errors = account(tmp_path, cfg)
    never = next(row for row in rows if row["signal"] == "bun" and row["file"] == "src/never.ts")
    for counter in ("lines", "functions", "branches", "statements"):
        value = never[f"uncovered_{counter}"]
        assert isinstance(value, int)
        assert value > 0
    assert any(error.startswith("example/bun: Budget exceeded") for error in errors)
    suite.write_text(
        suite.read_text()
        + 'import { gate } from "./src/never.ts";\n'
        + 'test("real refusal and success", () => { expect(() => gate(false)).toThrow("refused"); '
        + "expect(gate(true)).toBe(42); });\n"
    )
    covered = subprocess.run(argv, cwd=directory, capture_output=True, text=True, check=False)
    assert covered.returncode == 0, covered.stdout + covered.stderr
    node_covered = subprocess.run(node_argv, cwd=directory, capture_output=True, text=True, check=False)
    assert node_covered.returncode == 0, node_covered.stdout + node_covered.stderr
    assert not account(tmp_path, cfg)[1]
    assert_damaged_reports_fail(tmp_path, cfg, report)


def assert_damaged_reports_fail(root: Path, cfg: Policy, report: Path) -> None:
    """Damage each real report in isolation and require independent Bun refusal.

    Parameters:
        root (Path): Disposable project root.
        cfg (Policy): Full-source zero-floor policy for the actual reports.
        report (Path): Real Bun LCOV report to damage, then restore.
    Returns:
        None: Both reports are mandatory, valid and independent from primary.
    Raises:
        AssertionError: Accounting accepts missing or malformed producer data.
    """
    summary = report.with_name("coverage-summary.json")
    lcov = report.read_text()
    statements = summary.read_text()
    report.unlink()
    assert "example/bun:" in account(root, cfg)[1][0]
    report.write_text("malformed LCOV\n")
    assert account(root, cfg)[1]
    report.write_text(lcov)
    summary.unlink()
    assert "Statement producer missing" in account(root, cfg)[1][0]
    summary.write_text("{malformed")
    assert account(root, cfg)[1]
    summary.write_text(statements)
    assert not account(root, cfg)[1]
