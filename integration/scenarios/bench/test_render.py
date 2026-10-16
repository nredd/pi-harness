"""Render cost benchmarks, measured in-process by `probes/render.ts`.

Method: each sample launches interactive pi with the probe extension, waits for the screen,
then runs `/harness-probe`, which times forced full frames (every component invalidated, then
`renderNow(true)`, terminal write included) and reads `heapUsed` after a GC. A sample's frame
time is the median of its frames; the metric is the median over `SAMPLES` launches.

- 2k transcript: resume a generated 2000-message session (`harness/sessions.py`, 500 turns of
  user prompt, `bash` call, result, markdown reply). Metrics: ms per full frame, ms per steady
  frame (no invalidate: what every keystroke and spinner tick pays), heap MB. The steady frame
  has a ceiling instead of a per-OS baseline: it costs at most `STEADY_FORCED_CEILING` of a full
  one, so settled rows answer from their caches instead of re-rendering the transcript per frame.
- 50k-line bash: a `bash` call printing 50,000 lines. Metrics: submit-to-settled wall time, and
  ms per full frame with that row expanded.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.bench import check_against_baseline, check_ceiling, measure_many
from harness.interactive import launch_tui, submit
from harness.probe import probe_args, run_probe
from harness.sessions import write_session
from harness.tmux import find_row

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.bench

TRANSCRIPT_MESSAGES = 2000
# 1.0.0-nredd.5 re-resolved every collapsed row per steady frame: steady was ~full frame cost.
STEADY_FORCED_CEILING = 0.25
BASH_LINES = 50_000
IDLE_SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": []}}}
BASH_DONE = "BIG BASH DONE"
BASH_SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {"tools": [{"name": "bash", "args": {"command": f"seq 1 {BASH_LINES}"}}]},
                {"text": BASH_DONE},
            ],
        }
    }
}
BASH_ROW = r"^▸ +\$ seq 1 50000"
# Expanded, the row is taller than the screen and the view follows its tail, so the header
# scrolls off; the truncation note at the bottom marks it.
BASH_EXPANDED = r"Truncated: showing \d+\s+of 50000 lines"


def test_render_2k_message_transcript(sandbox: Sandbox) -> None:
    """Full- and steady-frame time and live heap with a resumed 2000-message session on screen."""
    session = sandbox.root / "bench-sessions" / "2k.jsonl"
    turns = write_session(session, sandbox.workdir, TRANSCRIPT_MESSAGES)
    out = sandbox.root / "probe-2k.jsonl"
    args, env = probe_args(out)

    def sample() -> dict[str, float]:
        pane = launch_tui(
            sandbox,
            IDLE_SCRIPT,
            name=f"bench{time.monotonic_ns()}",
            extra_args=[*args, "--session", str(session)],
            env=env,
        )
        try:
            pane.wait_for(rf"Turn {turns} found 8 files", timeout_s=60)
            reading = run_probe(pane, out)
        finally:
            pane.kill()
        assert reading.gc, "the probe ran without `--expose-gc`; heap would include garbage"
        return {
            "render_2k_frame_ms": reading.frame_ms,
            "render_2k_steady_frame_ms": reading.steady_frame_ms,
            "render_2k_heap_mb": reading.heap_used_mb,
        }

    medians = measure_many(sample)
    # A ratio, not a per-OS baseline: the bound holds on every machine.
    steady_ms = medians.pop("render_2k_steady_frame_ms")
    check_ceiling(
        "render_2k_steady_over_full",
        steady_ms / max(medians["render_2k_frame_ms"], 0.1),
        STEADY_FORCED_CEILING,
    )
    for metric, value in medians.items():
        check_against_baseline(metric, value)


def test_render_50k_line_bash_output(sandbox: Sandbox) -> None:
    """Wall time until a 50k-line `bash` result settles, and full-frame time with it expanded."""
    out = sandbox.root / "probe-bash.jsonl"
    args, env = probe_args(out)

    def sample() -> dict[str, float]:
        pane = launch_tui(sandbox, BASH_SCRIPT, name=f"bench{time.monotonic_ns()}", extra_args=args, env=env)
        try:
            started = time.monotonic()
            submit(pane, "go")
            pane.wait_for(BASH_DONE, timeout_s=120)
            settled_s = time.monotonic() - started
            pane.click(6, find_row(pane.rows(), BASH_ROW))
            pane.wait_for(BASH_EXPANDED, timeout_s=30)
            reading = run_probe(pane, out)
        finally:
            pane.kill()
        return {"bash_50k_settle_s": settled_s, "bash_50k_expanded_frame_ms": reading.frame_ms}

    for metric, value in measure_many(sample).items():
        check_against_baseline(metric, value)
