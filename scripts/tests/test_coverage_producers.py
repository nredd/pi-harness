"""Pin producer contracts separately from runner-agnostic LCOV accounting."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INCLUDE = re.compile(r"include:\s*(\[[^\]]*\])", re.DOTALL)


def test_primary_configs_match_policy_inventory() -> None:
    """Prevent the instrumentation include list and reviewed denominator drifting apart."""
    policy = json.loads((ROOT / "coverage/policy.json").read_text())
    for package in policy["packages"].values():
        primary = package["signals"].get("primary")
        if not primary or package["root"] in {"scripts", "integration/probes"}:
            continue
        directory = ROOT / package["root"]
        path = directory / (".vitest.config.ts" if directory.name == "todo" else "vitest.config.ts")
        text = path.read_text()
        match = INCLUDE.search(text)
        assert match, path
        # Configs are formatted JSON-compatible arrays; ignore a trailing comma.
        includes = json.loads(re.sub(r",\s*]", "]", match[1]))
        expected = primary.get("files")
        if expected is None:
            expected = {
                source.relative_to(directory).as_posix()
                for pattern in package["owned"]
                for source in directory.glob(pattern)
                if source.is_file() and not source.name.endswith(".test.ts")
            }
            expected -= {item["path"] for item in package["exclusions"]}
        assert set(includes) == set(expected), path
        assert "reportOnFailure: true" in text
        assert '"lcov"' in text
        assert '"text"' in text


def test_declared_bun_coverage_commands_have_both_reporters() -> None:
    """An lcov-only Bun invocation must never satisfy the generic reporter declaration."""
    manifests = [*ROOT.glob("packages/*/package.json"), ROOT / "integration/inprocess/package.json"]
    for manifest in manifests:
        command = json.loads(manifest.read_text())["scripts"].get("test:bun")
        if command:
            assert "--coverage-reporter=text" in command, manifest
            assert "--coverage-reporter=lcov" in command, manifest
            assert "--coverage-dir=coverage/bun" in command, manifest


def test_generated_coverage_is_ignored_by_whole_workspace_linters() -> None:
    """LCOV's bundled HTML must not be linted as source on the next native gate."""
    for directory in [ROOT / "packages/plan-mode", ROOT / "integration/inprocess"]:
        assert "coverage/" in (directory / ".gitignore").read_text().splitlines()


def test_node_coverage_wraps_the_existing_test_invocations() -> None:
    """Node gates instrument their existing pass, including never-imported owned code."""
    makefile = (ROOT / "Makefile").read_text()
    commands = [line for line in makefile.splitlines() if "/.bin/c8 " in line]
    assert len(commands) == 2
    for command in commands:
        assert "--all " in command
        assert "--include=" in command
        assert "--reporter=text " in command
        assert "--reporter=lcov " in command
        assert " node --test " in command


def test_accounting_and_artifacts_follow_tests_even_on_failure() -> None:
    """Coverage must not become a second test job or disappear after a failed suite."""
    workflow = (ROOT / ".github/workflows/ci.yml").read_text()
    owned = workflow.split("  owned:", 1)[1].split("  contracts:", 1)[0]
    accounting = owned.split("- name: Coverage accounting", 1)[1].split("- name:", 1)[0]
    artifacts = owned.split("- name: Preserve independent coverage reports", 1)[1].split("- name:", 1)[0]
    assert owned.index("Owned gates (") < owned.index("Coverage accounting")
    assert "if: always() && steps.plan.outputs.run == 'true'" in accounting
    assert "if: always() && steps.plan.outputs.run == 'true'" in artifacts
    assert 'make check-coverage BASE="$BASE"' in accounting
    assert "github.event.pull_request.base.sha" in accounting
    assert "fetch-depth: 0" in owned
    assert "coverage/summary.json" in artifacts
    assert "lcov.info" in artifacts


def test_pinned_bun_lcov_only_threshold_bypass(tmp_path: Path) -> None:
    """Reproduce 1.3.14's exit-0 bypass; demonstrate why the text reporter is mandatory."""
    executable = shutil.which("bun")
    assert executable, "The repository's pinned Bun is required, not a skipped verification"
    version = subprocess.check_output([executable, "--version"], text=True).strip()
    assert version == (ROOT / ".bun-version").read_text().strip()
    (tmp_path / "bunfig.toml").write_text(
        "[test]\ncoverageThreshold = { functions = 1.0 }\ncoverageSkipTestFiles = true\n"
    )
    (tmp_path / "source.ts").write_text(
        "export function called() { return 1; }\nexport function never() { return 2; }\n"
    )
    (tmp_path / "probe.test.ts").write_text(
        'import { test, expect } from "bun:test";\nimport { called } from "./source";\n'
        'test("called", () => expect(called()).toBe(1));\n'
    )
    argv = [executable, "test", "--coverage", "--coverage-reporter=lcov"]
    bypass = subprocess.run(argv, cwd=tmp_path, capture_output=True, check=False)
    actual_lcov = (tmp_path / "coverage/lcov.info").read_text()
    assert "FNF:2\nFNH:1\n" in actual_lcov
    enforced = subprocess.run(
        [*argv, "--coverage-reporter=text"], cwd=tmp_path, capture_output=True, check=False
    )
    assert bypass.returncode == 0, bypass.stderr.decode()
    assert enforced.returncode != 0, enforced.stderr.decode()
    assert b"50.00" in enforced.stderr
