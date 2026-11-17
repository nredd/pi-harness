"""Golden files: compare text against `golden/<name>`, rewrite them with `UPDATE_GOLDEN=1`."""

from __future__ import annotations

import difflib
import os

from harness.paths import GOLDEN_DIR


def assert_golden(name: str, actual: str) -> None:
    """Compare `actual` with the stored golden, or store it when updating.

    Parameters:
        name (str): file name under `golden/`, e.g. `tools.txt`.
        actual (str): text produced by the scenario.

    Raises:
        AssertionError: the golden is missing or differs; the message carries a unified diff.
    """
    path = GOLDEN_DIR / name
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(actual)
        return
    if not path.is_file():
        raise AssertionError(f"Missing golden '{path}'; run with UPDATE_GOLDEN=1 to create it")
    expected = path.read_text()
    if expected != actual:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                actual.splitlines(keepends=True),
                fromfile=f"golden/{name}",
                tofile="actual",
            )
        )
        raise AssertionError(f"Golden '{name}' differs:\n{diff}")
