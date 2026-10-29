"""Pin producer contracts separately from runner-agnostic LCOV accounting.

References:
    https://github.com/oven-sh/bun/blob/bun-v1.4.4/docs/test/code-coverage.mdx
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INCLUDE = re.compile(r"include:\s*(\[[^\]]*\])", re.DOTALL)


def test_primary_configs_match_policy_inventory() -> None:
    """Bind primary instrumentation includes to reviewed ownership.

    Parameters:
        None.
    Returns:
        None: Every measured primary configuration includes all owned executable files.
    Raises:
        AssertionError: Producer includes or failure-reporting requirements drift.
    """
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
    """Bind declared Bun commands to visible and machine reporting.

    Parameters:
        None.
    Returns:
        None: Every declared compatibility suite uses both required reporters.
    Raises:
        AssertionError: A producer removes a reporter or the independent output directory.
    """
    manifests = [*ROOT.glob("packages/*/package.json"), ROOT / "integration/inprocess/package.json"]
    for manifest in manifests:
        command = json.loads(manifest.read_text())["scripts"].get("test:bun")
        if command:
            if "scripts/run-vitest.ts bun" in command and not command.startswith("bun test "):
                assert command.startswith("node ../../scripts/run-vitest.ts bun "), manifest
                assert "--coverage.provider=istanbul" in command, manifest
                assert "--coverage.reporter=text" in command, manifest
                assert "--coverage.reporter=lcov" in command, manifest
                assert "--coverage.reportsDirectory=coverage/bun" in command, manifest
                assert not re.search(r"\S+\.test\.[cm]?[jt]s", command), manifest
                if manifest.parent.name == "resource-sampler":
                    assert "--maxWorkers=1" in command
                if manifest.parent.name == "todo":
                    assert "--config .vitest.config.ts" in command
            else:
                assert "--coverage-reporter=text" in command, manifest
                assert "--coverage-reporter=lcov" in command, manifest
                assert "--coverage-dir=coverage/bun" in command, manifest


def test_generated_coverage_is_ignored_by_whole_workspace_linters() -> None:
    """Keep generated report HTML outside whole-workspace source linting.

    Parameters:
        None.
    Returns:
        None: Whole-workspace linters ignore generated coverage output.
    Raises:
        AssertionError: A repeated native gate starts linting generated reports.
    """
    for directory in [ROOT / "packages/plan-mode", ROOT / "integration/inprocess"]:
        assert "coverage/" in (directory / ".gitignore").read_text().splitlines()


def test_node_coverage_wraps_the_existing_test_invocations() -> None:
    """Instrument existing Node invocations without a second test pass.

    Parameters:
        None.
    Returns:
        None: Both Node producers include all owned source and both reporting formats.
    Raises:
        AssertionError: Existing Node instrumentation requirements regress.
    """
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
    """Keep accounting and artifacts after tests, including failure paths.

    Parameters:
        None.
    Returns:
        None: Existing owned CI jobs account for and preserve their reports.
    Raises:
        AssertionError: CI drops failure accounting, base history or artifacts.
    """
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
    # WSL runs ordinary producers/accounting inside Linux, but uploads from the Windows host.
    export = owned.index(
        "- uses: ./.github/actions/capture-ci-wsl", owned.index("- name: Coverage accounting")
    )
    assert export < owned.index("- name: Preserve independent coverage reports")
    assert "name: coverage-${{ matrix.os }}" in artifacts


def test_reviewer_dependencies_are_provisioned_before_owned_tests() -> None:
    """Require offline reviewer reads and explicit Ubuntu binary provisioning.

    Parameters:
        None.
    Returns:
        None: CI provisions and verifies both read dependencies before tests.
    Raises:
        AssertionError: Reviewer tests can fall back to network downloads.
    """
    workflow = (ROOT / ".github/workflows/ci.yml").read_text()
    owned = workflow.split("  owned:", 1)[1].split("  contracts:", 1)[0]
    install = owned.index("Install reviewer read dependencies (Ubuntu)")
    verify = owned.index("Verify reviewer read dependencies")
    assert install < verify < owned.index("Owned gates (")
    assert "apt-get install --yes ripgrep fd-find" in owned
    assert "matrix.os == 'ubuntu-24.04'" in owned
    wsl = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    packages = wsl.split("additional-packages:", 1)[1].splitlines()[0].split()
    assert {"ripgrep", "fd-find"}.issubset(packages)
    mac_install = owned.index("Install reviewer read dependencies (macOS)")
    assert mac_install < verify
    assert "tool: ripgrep@14.1.1,fd-find@10.2.0" in owned
    assert "taiki-e/install-action@8cca0918f8471c33515202b73f56ab27f2bed283" in owned
    assert "rg --version" in owned
    assert "fdfind --version" in owned
    reviewer = (ROOT / "integration/inprocess/reviewer.test.ts").read_text()
    assert 'vi.stubEnv("PI_OFFLINE", "1")' in reviewer
    assert "vi.unstubAllEnvs()" in reviewer


def test_pinned_bun_enforces_threshold_with_either_reporter(tmp_path: Path) -> None:
    """Pin the repaired LCOV-only threshold enforcement in Bun 1.4.4.

    Parameters:
        tmp_path (Path): Disposable coverage probe project.
    Returns:
        None: Both LCOV-only and text-plus-LCOV fail the same function threshold.
    Raises:
        AssertionError: The pinned runtime, LCOV output or threshold behavior differs.
    """
    executable = shutil.which("bun")
    assert executable, "The repository's pinned Bun is required, not a skipped verification"
    version = subprocess.check_output([executable, "--version"], text=True, stderr=subprocess.STDOUT).strip()
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
    assert bypass.returncode != 0, bypass.stderr.decode()
    assert enforced.returncode != 0, enforced.stderr.decode()
    assert b"50.00" in enforced.stderr
