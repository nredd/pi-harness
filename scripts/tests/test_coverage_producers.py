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
import tomllib
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
NATIVE_BUN_TEST = re.compile(r"(?:\w+=\S+ )*bun test ")
# Packages still on a native `bun test` subset. #320 retires one per slice; none may come back.
# session-kit stays: Bun's worker.terminate() of a spinning regex outlasts its matcher test's bound (#320).
NATIVE_BUN_PACKAGES = {"session-kit"}


LAUNCHER = "node ../../scripts/run-vitest.ts bun"
# Package-specific Vitest options only; the launcher owns every coverage flag.
LAUNCHER_PACKAGE_ARGS = {
    "resource-sampler": " --maxWorkers=1",
    "todo": " --config .vitest.config.ts",
}
BUN_COVERAGE_ARGS = [
    "--coverage",
    "--coverage.provider=istanbul",
    "--coverage.reporter=text",
    "--coverage.reporter=lcov",
    "--coverage.reporter=json-summary",
    "--coverage.reportsDirectory=coverage/bun",
]


def launch_bun(tmp_path: Path, *args: str) -> list[str]:
    """Run the real launcher against a recording `bun` and return the argv it received.

    Parameters:
        tmp_path (Path): Disposable directory for the fake executable and receipt.
        *args (str): Package arguments after the `bun` engine selector.
    Returns:
        list[str]: Arguments the launcher passed to `bun`.
    Raises:
        AssertionError: Node is missing or the launcher exits nonzero.
    """
    node = shutil.which("node")
    assert node, "Node is required to execute the launcher, not a skipped verification"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    receipt = tmp_path / "argv.json"
    fake = bin_dir / "bun"
    fake.write_text(
        "#!/usr/bin/env node\n"
        'require("node:fs").writeFileSync(process.env.RECEIPT, JSON.stringify(process.argv.slice(2)));\n'
    )
    fake.chmod(0o755)
    env = {"PATH": f"{bin_dir}:{Path(node).parent}", "RECEIPT": str(receipt)}
    result = subprocess.run(
        [node, ROOT / "scripts/run-vitest.ts", "bun", *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(receipt.read_text())


def assert_bounded_apt(script: str) -> None:
    """Assert every apt-get call fails fast on a stalled mirror or held dpkg lock.

    Parameters:
        script (str): Shell text of a CI step.
    Returns:
        None: Every apt-get call is bounded.
    Raises:
        AssertionError: An apt-get call lacks the retry, timeout or lock options.
    """
    calls = [line for line in script.splitlines() if "apt-get" in line]
    assert calls
    for call in calls:
        for option in ("Acquire::Retries=3", "Acquire::http::Timeout=30", "DPkg::Lock::Timeout=120"):
            assert f"-o {option}" in call


def test_apt_steps_skip_present_tools_and_are_bounded() -> None:
    """Assert tmux and fork apt steps skip when installed and carry bounds (#655).

    Parameters:
        None.
    Returns:
        None: Each apt step skips present tools and is bounded.
    Raises:
        AssertionError: An apt step can stall for the whole job budget.
    """
    ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    for name in ("owned-shards-ubuntu", "stack"):
        step = step_named(ci["jobs"][name]["steps"], "Install tmux (Linux)")
        assert step["timeout-minutes"] == 5
        assert "command -v tmux" in step["run"]
        assert_bounded_apt(step["run"])
    forks = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    deps = next(
        step
        for job in forks["jobs"].values()
        for step in job["steps"]
        if step.get("name", "").startswith("System dependencies")
    )
    assert deps["timeout-minutes"] == 5
    assert "dpkg -s" in deps["run"]
    assert_bounded_apt(deps["run"])


def test_bun_launcher_owns_istanbul_reporters_and_directory(tmp_path: Path) -> None:
    """Bind the Bun signal's provider, both reporters and output directory to the launcher.

    Parameters:
        tmp_path (Path): Disposable directory for the recording `bun`.
    Returns:
        None: The launcher appends the Bun coverage contract unless coverage is disabled.
    Raises:
        AssertionError: The launcher drops a reporter, the provider or the independent directory.
    """
    argv = launch_bun(tmp_path, "--maxWorkers=1")
    assert argv[0] == "--bun"
    assert argv[2:] == ["run", "--maxWorkers=1", *BUN_COVERAGE_ARGS]
    canary = launch_bun(tmp_path, "test/resource-loader-home.test.ts", "--coverage.enabled=false")
    assert canary[2:] == ["run", "test/resource-loader-home.test.ts", "--coverage.enabled=false"]


def test_python_signals_match_the_shared_python_gate() -> None:
    """Bind each Python signal to the one `PY_GATE` recipe that produces its LCOV.

    Parameters:
        None.
    Returns:
        None: Every Python package is gated through `PY_GATE` with a project-root `--cov` source,
            parallel pytest, and the policy's report path.
    Raises:
        AssertionError: The recipe, its coverage source, the report path or skipped hosts drift.
    """
    makefile = (ROOT / "Makefile").read_text()
    recipe = makefile[makefile.index("define PY_GATE") : makefile.index("endef")]
    assert "-n auto --dist loadfile" in recipe
    sources = dict(re.findall(r"\$\(call PY_GATE,(\w+),[^,]*,[^,]*,([^)]+)\)", makefile))
    policy = json.loads((ROOT / "coverage/policy.json").read_text())
    python = {name: pkg for name, pkg in policy["packages"].items() if name.startswith("python-")}
    for name, package in python.items():
        if name == "python-benchmarks":
            continue  # Its own `check-benchmark` recipe, pinned below.
        primary = package["signals"]["primary"]
        assert f"--cov-report=lcov:{primary['report']}" in recipe, name
        source = sources[package["root"]]
        assert {Path(pattern).parent.as_posix() for pattern in package["owned"]} == {source}, name
        assert primary["skip_hosts"] == ["wsl2"], name
        assert primary["producer"] == "coverage.py", name
    assert set(sources) == {"scripts", "integration"}


def test_benchmark_signal_matches_its_check_benchmark_producer() -> None:
    """Bind `python-benchmarks` to the `check-benchmark` recipe, its 100% gate and its macOS-only cell.

    Parameters:
        None.
    Returns:
        None: The recipe writes the policy's LCOV path, coverage.py keeps branch coverage at 100% with no
            omissions, and the signal names its producer gate and skips every host without one.
    Raises:
        AssertionError: The recipe, threshold, exclusions or host scope drift from the policy.
    """
    package = json.loads((ROOT / "coverage/policy.json").read_text())["packages"]["python-benchmarks"]
    primary = package["signals"]["primary"]
    recipe = subprocess.run(
        ["make", "--no-print-directory", "-n", "check-benchmark"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert f"cd {package['root']} && uv run --locked pytest" in recipe
    assert f"--cov-report=lcov:{primary['report']}" in recipe
    assert "--cov " in recipe
    project = tomllib.loads((ROOT / package["root"] / "pyproject.toml").read_text())["tool"]["coverage"]
    assert project["run"] == {"branch": True, "source": ["pi_harness_benchmark"]}
    assert project["report"]["fail_under"] == 100
    assert not {"omit", "exclude_lines", "exclude_also"} & (project["run"].keys() | project["report"].keys())
    assert package["owned"] == ["src/pi_harness_benchmark/*.py"]
    assert package["exclusions"] == []
    assert "goal" not in package
    assert primary["producer"] == "coverage.py"
    assert primary["gate"] == "check-benchmark"
    assert primary["skip_hosts"] == ["linux", "wsl2"]
    assert primary["max_uncovered"] == {"darwin": {"lines": 0, "functions": 0, "branches": 0}}


def test_declared_bun_commands_delegate_coverage_to_the_launcher() -> None:
    """Keep every Vitest-on-Bun producer on the launcher, and native subsets on both reporters.

    Parameters:
        None.
    Returns:
        None: Vitest-on-Bun manifests pass only package arguments; native subsets keep both reporters.
    Raises:
        AssertionError: A manifest bypasses the launcher, restates coverage flags, drops a reporter
            or a retired native subset returns.
    """
    manifests = [*ROOT.glob("packages/*/package.json"), ROOT / "integration/inprocess/package.json"]
    native = set()
    for manifest in manifests:
        command = json.loads(manifest.read_text())["scripts"].get("test:bun")
        if not command:
            continue
        # Native Bun commands may carry an env prefix such as `JITI_FS_CACHE=false` (#352).
        if NATIVE_BUN_TEST.match(command):
            native.add(manifest.parent.name)
            assert "--coverage-reporter=text" in command, manifest
            assert "--coverage-reporter=lcov" in command, manifest
            assert "--coverage-dir=coverage/bun" in command, manifest
        else:
            expected = LAUNCHER + LAUNCHER_PACKAGE_ARGS.get(manifest.parent.name, "")
            assert command == expected, manifest
    assert native == NATIVE_BUN_PACKAGES


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


def test_node_helper_gates_run_vitest_through_the_launcher() -> None:
    """Keep the probes, providers and import-audit producers on the guarded Vitest launcher.

    Parameters:
        None.
    Returns:
        None: Every Makefile producer runs Vitest with coverage; no `node --test` or c8 remains.
    Raises:
        AssertionError: A producer bypasses the launcher or returns to `node --test`/c8.
    """
    makefile = (ROOT / "Makefile").read_text()
    assert "cd integration/probes && node ../../scripts/run-vitest.ts node --coverage\n" in makefile
    assert "cd integration/providers && node ../../scripts/run-vitest.ts node --coverage\n" in makefile
    assert "cd scripts && node run-vitest.ts node --coverage\n" in makefile
    assert "node --test" not in makefile
    assert "/.bin/c8 " not in makefile
    for config in [
        ROOT / "integration/probes/vitest.config.ts",
        ROOT / "integration/providers/vitest.config.ts",
        ROOT / "scripts/vitest.config.ts",
    ]:
        assert "verification/home-setup.ts" in config.read_text(), config


def owned_jobs() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return the shared steps of the `owned` shard jobs and of the `owned (<os>)` fan-ins.

    Parameters:
        None.
    Returns:
        tuple[list[dict[str, Any]], list[dict[str, Any]]]: Shard steps, fan-in steps.
    Raises:
        OSError: The workflow cannot be read.
    """
    jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
    return jobs["owned-shards-ubuntu"]["steps"], jobs["owned-ubuntu"]["steps"]


def step_named(steps: list[dict[str, Any]], prefix: str) -> dict[str, Any]:
    """Return the first step whose name starts with a prefix.

    Parameters:
        steps (list[dict[str, Any]]): Job steps.
        prefix (str): Name prefix.
    Returns:
        dict[str, Any]: The step.
    Raises:
        StopIteration: No step has that prefix.
    """
    return next(step for step in steps if step.get("name", "").startswith(prefix))


def test_accounting_and_artifacts_follow_tests_even_on_failure() -> None:
    """Keep each shard's reports, and the fan-in's accounting and artifact, on failure paths too.

    Parameters:
        None.
    Returns:
        None: Shards preserve their reports; the fan-in accounts for all of them and preserves the result.
    Raises:
        AssertionError: CI drops failure accounting, base history or artifacts.
    """
    shard, fan_in = owned_jobs()
    reports = step_named(shard, "Preserve this shard's coverage reports")
    last_gate = max(i for i, step in enumerate(shard) if step.get("name", "").startswith("Owned gate "))
    assert last_gate < shard.index(reports)
    assert reports["if"] == "always()"
    assert reports["with"]["name"] == "coverage-${{ matrix.os }}-${{ matrix.shard }}"
    assert "lcov.info" in reports["with"]["path"]
    # WSL runs ordinary producers inside Linux, but uploads from the Windows host.
    export = next(i for i, step in enumerate(shard) if step.get("uses") == "./.github/actions/capture-ci-wsl")
    assert last_gate < export < shard.index(reports)
    checkout = next(step for step in shard if "actions/checkout@" in step.get("uses", ""))
    assert checkout["with"]["fetch-depth"] == 0
    accounting = step_named(fan_in, "Coverage accounting")
    artifacts = step_named(fan_in, "Preserve independent coverage reports")
    merge = step_named(fan_in, "Merge the shards' coverage reports")
    assert fan_in.index(merge) < fan_in.index(accounting) < fan_in.index(artifacts)
    assert accounting["if"] == "always() && steps.plan.outputs.run == 'true'"
    assert artifacts["if"] == "always() && steps.plan.outputs.run == 'true'"
    assert accounting["run"].startswith('make check-coverage BASE="$BASE"')
    assert "github.event.pull_request.base.sha" in accounting["env"]["BASE"]
    full = next(step for step in fan_in if step.get("with", {}).get("fetch-depth") == 0)
    assert fan_in.index(full) < fan_in.index(accounting)
    assert "coverage/summary.json" in artifacts["with"]["path"]
    assert "lcov.info" in artifacts["with"]["path"]
    assert artifacts["with"]["name"] == "coverage-${{ matrix.os }}"


def test_native_ubuntu_rust_producer_is_pinned_and_preserved() -> None:
    """Require a maintained native producer, raw artifacts and explicit unsupported hosts.

    Parameters:
        None.
    Returns:
        None: Ubuntu collection and selected-host accounting remain wired together.
    Raises:
        AssertionError: Pins, resource limits, artifacts or source-complete ownership drift.
    """
    shard, fan_in = owned_jobs()
    setup = step_named(shard, "Install pinned native Ubuntu coverage tools")
    collect = step_named(shard, "Collect native Ubuntu Rust coverage")
    assert setup["if"] == collect["if"]
    assert "matrix.os == 'ubuntu-24.04'" in collect["if"]
    assert "contains(matrix.workspaces, 'packages/computer-use')" in collect["if"]
    assert shard.index(setup) < shard.index(collect)
    assert setup["env"] == collect["env"] == {"CARGO_BUILD_JOBS": "2", "RUSTUP_TOOLCHAIN": "1.97.1"}
    assert "--component llvm-tools-preview" in setup["run"]
    assert "cargo-llvm-cov --version 0.9.1 --locked" in setup["run"]
    assert "--crate linux --output coverage/native-linux" in collect["run"]
    for steps, prefix in ((shard, "Preserve this shard"), (fan_in, "Preserve independent")):
        artifacts = step_named(steps, prefix)["with"]["path"]
        for filename in ("coverage.json", "setup.log", "*/metadata.json", "*/summary.txt", "*/*.log"):
            assert f"packages/computer-use/coverage/native-linux/{filename}" in artifacts
    cfg = json.loads((ROOT / "coverage/policy.json").read_text())["packages"]["computer-use-linux-native"]
    assert cfg["owned"] == ["native/linux/bridge-rs/src/**/*.rs"]
    signal = cfg["signals"]["primary"]
    assert signal["producer"] == "llvm-cov"
    assert signal["skip_os"] == ["darwin"]
    assert signal["skip_hosts"] == ["wsl2"]
    assert signal["enforcement"] == "report-only"


def test_reviewer_dependencies_are_provisioned_before_owned_tests() -> None:
    """Require offline reviewer reads and prebuilt reviewer binaries on Ubuntu and macOS.

    Parameters:
        None.
    Returns:
        None: CI provisions and verifies both read dependencies before tests.
    Raises:
        AssertionError: Reviewer tests can fall back to network downloads.
    """
    shard, _ = owned_jobs()
    owned = yaml.safe_dump(shard, width=1000)
    install_step = step_named(shard, "Install reviewer read dependencies")
    install = shard.index(install_step)
    verify = shard.index(step_named(shard, "Verify reviewer read dependencies"))
    assert install < verify < shard.index(step_named(shard, "Owned gate "))
    # Prebuilt GitHub release binaries on Ubuntu and macOS: no apt mirror on the critical path.
    assert install_step["if"] == "matrix.os == 'ubuntu-24.04' || runner.os == 'macOS'"
    assert install_step["uses"] == "taiki-e/install-action@8cca0918f8471c33515202b73f56ab27f2bed283"
    assert install_step["with"]["tool"] == "ripgrep@14.1.1,fd-find@10.5.0"
    assert install_step["env"]["BINSTALL_DISABLE_STRATEGIES"] == "compile"
    assert "run" not in install_step
    apt = (ROOT / "scripts/wsl2_apt.sh").read_text()
    packages = apt.split("packages=(", 1)[1].splitlines()[0].rstrip(")").split()
    assert {"ripgrep", "fd-find"}.issubset(packages)
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
