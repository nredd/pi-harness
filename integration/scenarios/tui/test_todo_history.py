"""Settled todo rows retain their own result snapshot across an extension reload.

References:
- Pi renderer lifecycle: https://github.com/nredd/pi
- Todo fork: https://github.com/nredd/rpiv-todo
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.paths import REPO_ROOT

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

FINAL = "TODO HISTORY DONE"
PROBE = REPO_ROOT / "probes" / "todo-history.test.ts"
SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {
                    "tools": [
                        {"name": "todo", "args": {"action": "create", "subject": "historical subject"}},
                        {"name": "todo", "args": {"action": "update", "id": 1, "status": "in_progress"}},
                        {"name": "todo", "args": {"action": "update", "id": 1, "subject": "today's subject"}},
                    ]
                },
                {"text": FINAL},
            ],
        }
    }
}


def probe_records(path: Path) -> list[dict[str, str]]:
    """Read the host-renderer probe's JSONL records.

    Parameters:
        path (Path): Probe output path.

    Returns:
        list[dict[str, str]]: Render records in host invocation order.
    """
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_reloaded_todo_row_uses_its_historical_subject(tui: Callable[..., TmuxPane], tmp_path: Path) -> None:
    """A reloaded and resized Pi host renders the earlier update with its own subject snapshot."""
    output = tmp_path / "todo-history.jsonl"
    pane = tui(
        SCRIPT,
        width=140,
        height=60,
        extra_args=["-e", str(PROBE)],
        env={"PI_TODO_HISTORY_PROBE": str(output)},
    )
    submit(pane, "go")
    pane.wait_for(FINAL, timeout_s=60)

    submit(pane, "/reload")
    pane.wait_for(r"todo → historical subject", timeout_s=30)
    pane.resize(100, 60)
    screen = pane.wait_for(r"todo → historical subject", timeout_s=10)
    assert "todo → historical subject · ◐ in progress" in screen

    records = probe_records(output)
    assert records, "the actual Pi host never rendered the todo snapshot"
    historical = [record for record in records if record["subject"] == "historical subject"]
    assert historical, f"no historical snapshot in host records: {records}"
    assert "historical subject" in historical[-1]["rendered"]
