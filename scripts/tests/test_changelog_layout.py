"""Pin the feature-specific fragment layout exception without growing legacy waivers.

References:
    https://github.com/nredd/pi-harness/issues/932
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import changelog_fragments
import package_layout


@pytest.mark.parametrize("category", changelog_fragments.CATEGORIES)
def test_canonical_subagents_fragment_layout(tmp_path: Path, category: str) -> None:
    """Accept only canonical direct fragment names in subagents.

    Parameters:
        tmp_path (Path): Disposable empty root.
        category (str): Canonical fragment category.

    Returns:
        None: Assert no fragment layout violations and no other package exception.
    """
    path = f"changes/932.{category}.md"
    problems = package_layout.check_package("packages/subagents", [path], tmp_path, publish=True)
    assert [problem for problem in problems if problem.rule != "missing-file"] == []
    assert not changelog_fragments.fragment_path("packages/todo", path)
    assert not changelog_fragments.fragment_path("packages/subagents", "README.md")


@pytest.mark.parametrize(
    "path",
    [
        "changes",
        "changes/README.md",
        "changes/0.fixed.md",
        "changes/a.json",
        "changes/nested/932.fixed.md",
        "changes/932.unknown.md",
    ],
)
def test_fragment_exception_is_not_a_markdown_or_directory_waiver(tmp_path: Path, path: str) -> None:
    """Keep malformed fragment entries and the bare changes file as violations.

    Parameters:
        tmp_path (Path): Disposable empty root.
        path (str): Malformed package-relative fragment path.

    Returns:
        None: Assert the exception does not authorize other data or Markdown.
    """
    problems = package_layout.check_package("packages/subagents", [path], tmp_path, publish=True)
    assert any(problem.rule in {"fragment-path", "top-level-entry"} for problem in problems)
    assert not package_layout.markdown_allowed("src/932.fixed.md", "packages/subagents")
    assert not package_layout.markdown_allowed("changes/932.fixed.md", "packages/todo")
    assert package_layout.top_level_violation("packages/todo", "changes", True) is not None
