"""Validate zero-counter ESM facades without exempting executable source.

References:
    ../../docs/coverage.md
    https://istanbul.js.org/
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest
from pydantic import ValidationError
from test_coverage_accounting import policy, setup_report

from coverage_accounting import Exclusion, Policy, check_inventory_ratchet, check_ratchet, git_read, inventory

ROOT = Path(__file__).resolve().parents[2]
FACADES = ["src/index.ts", "src/interactive-ui.ts"]
INSTRUMENT = textwrap.dedent("""
import { readFileSync } from 'node:fs';
import { createInstrumenter } from '@vitest/istanbul-lib-instrument';
import { transformSync } from 'esbuild';
const result = {};
for (const file of process.argv.slice(1)) {
  const source = readFileSync(file, 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
  result[file] = { compiled, maps: [] };
  for (const code of [source, compiled]) {
    const instrumenter = createInstrumenter({ esModules: true });
    instrumenter.instrumentSync(code, file);
    const coverage = instrumenter.lastFileCoverage();
    result[file].maps.push({
      statements: Object.keys(coverage.statementMap).length,
      functions: Object.keys(coverage.fnMap).length,
      branches: Object.keys(coverage.branchMap).length
    });
  }
}
process.stdout.write(JSON.stringify(result));
""")


def facade(path: str = "src/index.ts") -> Exclusion:
    """Declare one fixture-local facade with a substantive classification reason.

    Parameters:
        path (str): Exact package-relative TypeScript source path.
    Returns:
        Exclusion: Validated non-executable facade classification.
    Raises:
        ValidationError: The declaration is not an exact TypeScript path.
    """
    return Exclusion(
        path=path,
        kind="non-executable-facade",
        reason="Static ESM re-export only; the target implementation remains owned and measured.",
    )


def test_real_facades_have_zero_istanbul_counters_in_source_and_emitted_esm() -> None:
    """Inspect real TypeScript and emitted ESM, not invented LCOV zero records.

    Parameters:
        None.
    Returns:
        None: Both source and compiled module shapes have zero Istanbul counters.
    Raises:
        AssertionError: Node is absent or a facade gains an executable counter.
        subprocess.CalledProcessError: Real compilation or instrumentation fails.
    """
    node = shutil.which("node")
    assert node
    paths = [str(ROOT / "packages/plan-mode" / path) for path in FACADES]
    result = json.loads(
        subprocess.check_output(
            [node, "--input-type=module", "-e", INSTRUMENT, *paths],
            cwd=ROOT,
            text=True,
            stderr=subprocess.STDOUT,
        )
    )
    assert set(result) == set(paths)
    for value in result.values():
        assert "export" in value["compiled"]
        assert value["maps"] == [{"statements": 0, "functions": 0, "branches": 0}] * 2


@pytest.mark.parametrize(
    "source",
    [
        'export { default } from "./implementation.js";\n',
        "export { menu as showMenu, other } from './menu.js';\n",
        'export { one } from "./one.js";\nexport { two } from "./two.js";\n',
    ],
)
def test_static_named_reexports_are_classified(tmp_path: Path, source: str) -> None:
    """Accept only the deliberately narrow facade grammar.

    Parameters:
        tmp_path (Path): Disposable source root.
        source (str): Static local ESM named re-export declarations.
    Returns:
        None: The validated facade has no executable coverage requirement.
    Raises:
        AssertionError: A genuine facade is treated as executable source.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/index.ts").write_text(source)
    package = policy().packages["example"]
    package.exclusions = [facade()]
    assert not inventory(tmp_path, package)


@pytest.mark.parametrize(
    "addition",
    [
        'console.log("reachable");',
        "export const initialized = run();",
        "export function reachable() { return 1; }",
        'import "./side-effect.js";',
        "export default (() => 1)();",
        '/* export { fake } from "./fake.js"; */ run();',
        'export { injected } from "./module.js" with { type: run() };',
        ";",
    ],
)
def test_executable_addition_invalidates_facade(tmp_path: Path, addition: str) -> None:
    """Fail closed when an inventoried facade gains anything beyond static re-exports.

    Parameters:
        tmp_path (Path): Disposable source root.
        addition (str): Executable or unsupported syntax appended to a valid facade.
    Returns:
        None: Source-shape changes invalidate the classification before report consumption.
    Raises:
        AssertionError: An executable source addition escapes coverage accounting.
    """
    setup_report(tmp_path)
    source = tmp_path / "packages/example/src/index.ts"
    source.write_text('export { default } from "./implementation.js";\n' + addition)
    package = policy().packages["example"]
    package.exclusions = [facade()]
    with pytest.raises(ValueError, match="contains more than static re-exports"):
        inventory(tmp_path, package)


@pytest.mark.parametrize("path", ["src/*.ts", "../outside.ts", "/absolute.ts", "src/runtime.js"])
def test_facade_requires_exact_typescript_path(path: str) -> None:
    """Reject broad or escaping classifications at schema validation.

    Parameters:
        path (str): Invalid facade path declaration.
    Returns:
        None: Only exact package-relative TypeScript paths are accepted.
    Raises:
        AssertionError: An invalid declaration passes validation.
    """
    with pytest.raises(ValidationError, match="exact package-relative TypeScript path"):
        facade(path)


def test_actual_policy_facade_receipts_preserve_integration_base_ratchet() -> None:
    """Require exact facade membership receipts against the real integration base policy.

    Parameters:
        None.
    Returns:
        None: Both owned paths and the affected Bun subset pass only with their explicit ledger entries.
    Raises:
        AssertionError: Missing receipts bypass the inventory ratchet or valid receipts fail.
        subprocess.CalledProcessError: The recorded integration base cannot be read.
    """
    revision = "71b0aea29173d56b181551b7579ff7557c500a24"
    base = Policy.model_validate_json(git_read(ROOT, ["show", f"{revision}:coverage/policy.json"]))
    current = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    expected = {
        ("owned", "packages/plan-mode/src/index.ts"),
        ("owned", "packages/plan-mode/src/interactive-ui.ts"),
        ("bun", "packages/plan-mode/src/interactive-ui.ts"),
    }
    assert {
        (entry.signal, entry.path) for entry in current.reclassifications if entry.package == "plan-mode"
    } == expected
    check_ratchet(current, base)
    check_inventory_ratchet(ROOT, current, base, revision)
    without_receipts = current.model_copy(deep=True)
    without_receipts.reclassifications = []
    with pytest.raises(ValueError, match="Inventory ratchet requires"):
        check_inventory_ratchet(ROOT, without_receipts, base, revision)
    for signal, path in expected:
        missing_one = current.model_copy(deep=True)
        missing_one.reclassifications = [
            entry
            for entry in missing_one.reclassifications
            if not (entry.package == "plan-mode" and entry.signal == signal and entry.path == path)
        ]
        with pytest.raises(ValueError, match="Inventory ratchet requires"):
            check_inventory_ratchet(ROOT, missing_one, base, revision)
