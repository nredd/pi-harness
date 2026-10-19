"""Static inventory checks without importing or running process scenarios.

References:
- https://github.com/nredd/pi-harness/blob/main/integration/README.md
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCUMENTED_FILE = re.compile(r"`([^`]+\.py)`")


def test_manifest_references_existing_tests() -> None:
    """Require every receipt key to name an existing file and, when given, function."""
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for key in manifest:
        relative, _, function = key.partition("::")
        path = ROOT / relative
        assert path.is_file(), key
        if function:
            names = {
                node.name
                for node in ast.walk(ast.parse(path.read_text()))
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            assert function in names, key


def test_every_scenario_is_selected_or_has_a_documented_exclusion() -> None:
    """Match the CI file glob, stack markers and exhaustive reasoned README exclusions."""
    selected = {*ROOT.glob("scenarios/test_*.py"), ROOT / "scenarios/tui/test_footer_resize.py"}
    for path in selected:
        tree = ast.parse(path.read_text())
        assert any(
            isinstance(node, ast.Attribute) and ast.unparse(node) == "pytest.mark.stack"
            for node in ast.walk(tree)
        ), path
    readme = (ROOT / "README.md").read_text()
    table = readme.split("Excluded scenario files (", 1)[1].split("\nNative stats receipts", 1)[0]
    excluded: set[Path] = set()
    for row in table.splitlines():
        if not row.startswith("| `"):
            continue
        files, reason = row.strip("|").split("|", 1)
        assert reason.strip(), row
        excluded |= {ROOT / "scenarios" / name for name in DOCUMENTED_FILE.findall(files)}
    assert not selected & excluded
    assert selected | excluded == set((ROOT / "scenarios").rglob("*.py"))
