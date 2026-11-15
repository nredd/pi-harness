"""Targets that load a gitignored `dist/` must build it first, so stale bytes never pass a gate."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _recipe(makefile: Path, target: str) -> str:
    """Return the recipe lines of one Makefile target.

    Parameters:
        makefile (Path): Makefile to read.
        target (str): Target name.

    Returns:
        str: Tab-indented recipe lines joined by newlines.
    """
    match = re.search(rf"^{re.escape(target)}:.*\n((?:\t.*\n?)+)", makefile.read_text(), re.MULTILINE)
    assert match, f"no target {target}"
    return match.group(1)


def test_inprocess_test_script_builds_every_package_first() -> None:
    """`npm run test` in `integration/inprocess` loads built packages, so `pretest` runs the root build."""
    scripts = json.loads((ROOT / "integration/inprocess/package.json").read_text())["scripts"]
    assert scripts["pretest"] == "npm run --prefix ../.. build"
    assert "npm run test" in scripts["check"]


@pytest.mark.parametrize("target", ["check-core-compaction", "check-scripts"])
def test_root_targets_build_before_loading_dist(target: str) -> None:
    """Root targets that load or pack `dist/` run `$(MAKE) build` before anything else.

    Parameters:
        target (str): Root Makefile target.
    """
    assert _recipe(ROOT / "Makefile", target).splitlines()[0].strip() == "$(MAKE) build"


def test_local_stack_runner_builds_first() -> None:
    """The `local` stack loads the built packages, so `stack` builds when it runs the local stack."""
    lines = _recipe(ROOT / "integration/Makefile", "stack")
    assert "$(MAKE) -C .. build" in lines
    assert "local.json" in lines
