"""Pin upgrade-sensitive Bun capabilities without replacing Vitest or Istanbul.

References:
    https://github.com/nredd/pi-harness/pull/170
    https://bun.com/docs/test/coverage
    https://vitest.dev/guide/coverage.html
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run_engine(engine: str, *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the selected engine in a disposable spawn-time home.

    Parameters:
        engine (str): Node or Bun executable selected by the test environment.
        *args (str): Engine arguments.
        cwd (Path): Disposable working directory and home.

    Returns:
        subprocess.CompletedProcess[str]: Unmasked output and status.

    Raises:
        AssertionError: The required engine is absent.
        subprocess.TimeoutExpired: The engine exceeds the fixture deadline.
    """
    # PATH deliberately selects the isolated engine; execute its resolved absolute path.
    executable = shutil.which(engine)
    assert executable is not None, f"Required engine '{engine}' is absent"
    return subprocess.run(
        [str(Path(executable).resolve()), *args],
        cwd=cwd,
        env=os.environ | {"HOME": str(cwd), "USERPROFILE": str(cwd), "XDG_CONFIG_HOME": str(cwd / ".config")},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_cached_home_is_explicit(tmp_path: Path) -> None:
    """Retain the known cached-home behavior and the need for spawn-time isolation."""
    result = run_engine(
        "bun",
        "-e",
        'import {homedir} from "node:os"; const before=homedir();'
        'process.env.HOME="/not-the-launch-home"; console.log(JSON.stringify([before,homedir()]));',
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == [str(tmp_path), str(tmp_path)]


def test_native_timers_and_module_isolation(tmp_path: Path) -> None:
    """Exercise the native timer/isolation fixes without porting owned Vitest suites."""
    (tmp_path / "value.ts").write_text('export const value = "original";\n')
    (tmp_path / "real.ts").write_text('Reflect.set(globalThis, "module-evaluated", true);\n')
    for name in ("first", "second"):
        (tmp_path / f"{name}.test.ts").write_text(
            'import {test,expect,mock,jest} from "bun:test"; import "./real.ts";'
            f'mock.module("./value.ts", () => ({{value:{json.dumps(name)}}}));'
            'const {value}=await import("./value.ts");'
            f'test("isolated {name}", () => {{ expect(value).toBe({json.dumps(name)});'
            'expect(Reflect.get(globalThis,"module-evaluated")).toBe(true);'
            'expect(Reflect.has(globalThis,"previous-file")).toBe(false);'
            f'Reflect.set(globalThis,"previous-file",{json.dumps(name)}); }});'
            'test("Date advances", () => { jest.useFakeTimers(); try {'
            "jest.setSystemTime(new Date(1000)); jest.advanceTimersByTime(200);"
            "expect(Date.now()).toBe(1200); } finally { jest.useRealTimers(); } });"
        )
    result = run_engine("bun", "test", "--isolate", cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "4 pass" in result.stderr, result.stderr
    # Negative control: without --isolate the second file observes the first file's global.
    shared = run_engine("bun", "test", cwd=tmp_path)
    assert shared.returncode == 1, shared.stdout + shared.stderr
    assert "Expected: false" in shared.stderr, shared.stderr
    assert "Received: true" in shared.stderr, shared.stderr


def test_lcov_only_threshold_fails_closed(tmp_path: Path) -> None:
    """Keep the 1.4 threshold fix and record native coverage's incomplete-source limits."""
    (tmp_path / "bunfig.toml").write_text(
        "[test]\ncoverageThreshold = { lines = 1.0, functions = 1.0 }\ncoverageSkipTestFiles = true\n"
    )
    (tmp_path / "half.ts").write_text(
        'export function used() { return 1; }\nexport function unused() { return "unused"; }\n'
    )
    (tmp_path / "never.ts").write_text('export function neverImported() { return "never"; }\n')
    (tmp_path / "coverage.test.ts").write_text(
        'import {test,expect} from "bun:test"; import {used} from "./half.ts";'
        'test("partial", () => { expect(used()).toBe(1); });'
    )
    result = run_engine("bun", "test", "--coverage", "--coverage-reporter=lcov", cwd=tmp_path)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "1 pass" in result.stderr, result.stderr
    assert "0 fail" in result.stderr, result.stderr
    report = (tmp_path / "coverage/lcov.info").read_text()
    assert "half.ts" in report
    assert "never.ts" not in report
    assert "FNF:2" in report
    assert "FNH:1" in report
    assert "BRDA:" not in report


def test_istanbul_counters_match_both_engines(tmp_path: Path) -> None:
    """Count unimported source and require identical LCOV on the two actual engines.

    Parameters:
        tmp_path (Path): Disposable fixture project and home.
    """
    # Reuse the locked subagents Vitest/provider pair, not an uninstalled root provider
    # or an incompatible 4.x runner / 5.x provider combination. No dependency install.
    locate = run_engine(
        "node",
        "-e",
        'const locate = require("node:module").createRequire('
        f"{json.dumps(str(ROOT / 'packages/subagents/package.json'))});"
        'console.log(JSON.stringify({vitest:locate.resolve("vitest/package.json"),'
        '"@vitest/coverage-istanbul":locate.resolve("@vitest/coverage-istanbul/package.json")}));',
        cwd=tmp_path,
    )
    assert locate.returncode == 0, locate.stdout + locate.stderr
    metadata: dict[str, str] = json.loads(locate.stdout)
    versions = [json.loads(Path(path).read_text())["version"] for path in metadata.values()]
    assert versions[0] == versions[1], versions
    (tmp_path / "package.json").write_text('{"type":"module"}\n')
    modules = tmp_path / "node_modules"
    (modules / "@vitest").mkdir(parents=True)
    for name, path in metadata.items():
        (modules / name).symlink_to(Path(path).parent, target_is_directory=True)
    source = tmp_path / "src"
    source.mkdir()
    (source / "half.ts").write_text(
        "export function used(value: number): number {\n"
        "  if (value > 0) return 1;\n"
        "  return 2;\n}\n"
        'export function unused(): string {\n  return "unused";\n}\n'
    )
    (source / "never.ts").write_text('export function neverImported(): string {\n  return "never";\n}\n')
    (tmp_path / "counter.test.ts").write_text(
        'import {expect,test} from "vitest"; import {writeFileSync} from "node:fs";'
        'import {used} from "./src/half.ts";'
        'test("partial source", () => {'
        'writeFileSync("engine.txt", process.versions.bun ? "bun:" + process.versions.bun : '
        '"node:" + process.versions.node);'
        "expect(used(1)).toBe(1); });"
    )
    (tmp_path / "vitest.config.ts").write_text(
        'export default {test:{coverage:{provider:"istanbul",include:["src/**/*.ts"],'
        'reporter:["text","lcov"]}}};'
    )
    entry = Path(metadata["vitest"]).parent / "vitest.mjs"
    reports: list[str] = []
    for engine in ("node", "bun"):
        version = run_engine(engine, "--version", cwd=tmp_path)
        assert version.returncode == 0, version.stderr
        args = [
            *(["--bun"] if engine == "bun" else []),
            str(entry),
            "run",
            "--maxWorkers=1",
            "--coverage",
            f"--coverage.reportsDirectory={engine}-coverage",
        ]
        marker = tmp_path / "engine.txt"
        marker.unlink(missing_ok=True)
        result = run_engine(engine, *args, cwd=tmp_path)
        assert result.returncode == 0, result.stdout + result.stderr
        assert marker.read_text() == f"{engine}:{version.stdout.strip().removeprefix('v')}"
        report = (tmp_path / f"{engine}-coverage/lcov.info").read_text()
        never = next(record for record in report.split("end_of_record") if "SF:src/never.ts" in record)
        assert "FNF:1" in never
        assert "FNH:0" in never
        counters = {
            key: sum(
                int(line.partition(":")[2]) for line in report.splitlines() if line.startswith(f"{key}:")
            )
            for key in ("LF", "LH", "FNF", "FNH", "BRF", "BRH")
        }
        assert counters == {"LF": 4, "LH": 1, "FNF": 3, "FNH": 1, "BRF": 2, "BRH": 1}
        reports.append(report)
    assert reports[0] == reports[1]
