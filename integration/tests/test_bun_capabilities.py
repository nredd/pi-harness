"""Pin upgrade-sensitive Bun capabilities without replacing Vitest or Istanbul.

References:
    https://github.com/nredd/pi-harness/pull/170
    https://bun.com/docs/test/coverage
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path


def bun(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the selected Bun in a disposable spawn-time home.

    Parameters:
        *args (str): Bun arguments.
        cwd (Path): Disposable working directory and home.

    Returns:
        subprocess.CompletedProcess[str]: Unmasked output and status.
    """
    executable = shutil.which("bun")
    assert executable is not None, "Required Bun is absent"
    return subprocess.run(
        [executable, *args],
        cwd=cwd,
        env=os.environ | {"HOME": str(cwd), "USERPROFILE": str(cwd)},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_cached_home_is_explicit(tmp_path: Path) -> None:
    """Retain the known cached-home behavior and the need for spawn-time isolation."""
    result = bun(
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
    result = bun("test", "--isolate", cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "4 pass" in result.stderr, result.stderr
    # Negative control: without --isolate the second file observes the first file's global.
    shared = bun("test", cwd=tmp_path)
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
    result = bun("test", "--coverage", "--coverage-reporter=lcov", cwd=tmp_path)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "1 pass" in result.stderr, result.stderr
    assert "0 fail" in result.stderr, result.stderr
    report = (tmp_path / "coverage/lcov.info").read_text()
    assert "half.ts" in report
    assert "never.ts" not in report
    assert "FNF:2" in report
    assert "FNH:1" in report
    assert "BRDA:" not in report
