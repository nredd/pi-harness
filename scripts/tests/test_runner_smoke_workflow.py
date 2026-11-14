"""Pin how `runner-smoke.yml` keeps host-specific probes and paths out of the repository."""

from __future__ import annotations

import re
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "runner-smoke.yml"


def job_block(job: str) -> str:
    """Return the text of one top-level job in the workflow."""
    text = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(rf"^  {re.escape(job)}:\n(.*?)(?=^  \S|\Z)", text, re.DOTALL | re.MULTILINE)
    assert match, job
    return match.group(1)


def private_step(job: str) -> str:
    """Return the `Private networks unreachable` step of a job."""
    block = job_block(job)
    match = re.search(
        r"- name: Private networks unreachable\n(.*?)(?=^      - name:|\Z)", block, re.DOTALL | re.MULTILINE
    )
    assert match, job
    return match.group(1)


def test_both_loops_append_extra_targets_from_a_repo_variable() -> None:
    """Linux and macOS loops add `vars.SMOKE_EXTRA_TARGETS` (space separated) after the neutral targets."""
    for job in ("pi-linux", "pi-macos"):
        step = private_step(job)
        assert "SMOKE_EXTRA_TARGETS: ${{ vars.SMOKE_EXTRA_TARGETS }}" in step, job
        assert re.search(r"for target in [^\n]*\$SMOKE_EXTRA_TARGETS; do", step), job
        assert re.search(r'-z "\$\{?SMOKE_EXTRA_TARGETS\}?"', step), job
        assert "note:" in step, job


def test_owner_home_probe_comes_from_a_repo_variable() -> None:
    """The home-directory probe reads `vars.SMOKE_OWNER_HOME` and skips with a note when unset."""
    block = job_block("pi-macos")
    assert "SMOKE_OWNER_HOME: ${{ vars.SMOKE_OWNER_HOME }}" in block
    assert re.search(r'ls "\$SMOKE_OWNER_HOME"', block)
    assert re.search(r'-z "\$\{?SMOKE_OWNER_HOME\}?"', block)
