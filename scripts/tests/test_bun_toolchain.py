"""Keep the standalone compiler, split-package pin and Bun API declarations coherent.

References:
    https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4
    https://github.com/nredd/pi-harness/pull/170
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_bun_pins_match() -> None:
    """Pin the approved patch explicitly; a future upgrade must deliberately revise this contract."""
    version = (ROOT / ".bun-version").read_text().strip()
    assert version == "1.4.4"
    assert (ROOT / "packages/todo/.bun-version").read_text().strip() == version
    manifest = json.loads((ROOT / "packages/todo/package.json").read_text())
    assert manifest["devDependencies"]["@types/bun"] == version
    lock = json.loads((ROOT / "package-lock.json").read_text())["packages"]
    assert lock["packages/todo"]["devDependencies"]["@types/bun"] == version
    for package in ("@types/bun", "bun-types"):
        assert lock[f"node_modules/{package}"]["version"] == version
    assert lock["node_modules/@types/bun"]["dependencies"]["bun-types"] == version


def test_ci_uses_version_file() -> None:
    """Keep CI setup actions and their live WSL documentation tied to the root pin."""
    workflows = ROOT / ".github/workflows"
    setups = 0
    for path in sorted(workflows.glob("*.yml")):
        content = path.read_text()
        for setup in content.split("uses: oven-sh/setup-bun@")[1:]:
            block = setup.split("\n      -", 1)[0]
            assert "bun-version-file: .bun-version" in block, path
            assert "bun-version:" not in block, path
            setups += 1
    assert setups > 0
    version = (ROOT / ".bun-version").read_text().strip()
    assert f"repository's pinned `{version}`" in (ROOT / "docs/ci.md").read_text()
