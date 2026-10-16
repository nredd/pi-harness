"""Run N interactive pi panes at once, each with the latency probe, to measure scaling.

`shared` panes use one sandbox (one `PI_CODING_AGENT_DIR`, one session dir), as real use does;
`isolated` panes each get their own `$HOME`. The panes are real tmux panes, but the numbers
come from the in-process probe, so tmux polling jitter stays out of them.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from harness.interactive import FIRST_FRAME_PATTERN, launch_tui, submit
from harness.latency import Reading, combine, latency_args, read_records, summarize
from harness.sandbox import build_sandbox, local_overrides_from_env

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

KEY_INTERVAL_S = 0.15


def make_sandboxes(root: Path, template_home: Path, count: int, *, shared: bool) -> list[Sandbox]:
    """Return one sandbox per pane: the same one `count` times when shared.

    Parameters:
        root (Path): scratch directory.
        template_home (Path): session chezmoi render.
        count (int): panes.
        shared (bool): one agent dir for all panes instead of one each.

    Returns:
        list[Sandbox]: `count` entries.

    Raises:
        ValueError: `count` is not positive.
    """
    if count < 1:
        raise ValueError(f"`count` must be positive, got '{count}'")
    overrides = local_overrides_from_env()
    if shared:
        return [build_sandbox(root / "shared", template_home, overrides)] * count
    return [build_sandbox(root / f"box{i}", template_home, overrides) for i in range(count)]


def streaming_script(chars: int, tokens_per_s: int) -> dict[str, Any]:
    """Faux script: one reply of `chars` characters, paced.

    Parameters:
        chars (int): reply length.
        tokens_per_s (int): pace; the reply lasts about `chars / 4 / tokens_per_s` seconds.

    Returns:
        dict[str, Any]: faux script.
    """
    words = ("alpha beta gamma delta " * (chars // 23 + 1))[:chars]
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"text": words}],
                "tokensPerSecond": tokens_per_s,
                "tokenSize": {"min": 3, "max": 5},
            }
        }
    }


IDLE_SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": []}}}


@dataclass
class Fleet:
    """Running panes and their probe files."""

    panes: list[TmuxPane] = field(default_factory=list)
    outs: list[Path] = field(default_factory=list)
    started_ms: float = 0.0

    def kill(self) -> None:
        """Tear every pane down."""
        for pane in self.panes:
            pane.kill()

    def mark(self) -> None:
        """Start the measured range now."""
        self.started_ms = time.time() * 1000

    def submit_all(self, text: str) -> None:
        """Submit `text` in every pane.

        Parameters:
            text (str): message.
        """
        for pane in self.panes:
            submit(pane, text)

    def type_into(self, index: int, count: int) -> None:
        """Type `count` characters into one pane, spaced like a typist.

        Parameters:
            index (int): pane.
            count (int): keystrokes.
        """
        for _ in range(count):
            self.panes[index].type_text("x")
            time.sleep(KEY_INTERVAL_S)

    def readings(self) -> list[Reading]:
        """Reduce each pane's probe since `mark()`.

        Returns:
            list[Reading]: one per pane.
        """
        return [summarize(read_records(out), self.started_ms) for out in self.outs]

    def metrics(self) -> dict[str, float]:
        """Fleet metrics since `mark()`, plus the typed pane's input p95.

        Returns:
            dict[str, float]: see `harness.latency.combine`, plus `input_p95_ms` from pane 0.
        """
        readings = self.readings()
        return combine(readings) | {"input_p95_ms": readings[0].input_p95_ms}


def launch_fleet(
    sandboxes: list[Sandbox],
    script: dict[str, Any],
    scratch: Path,
    *,
    interval_ms: int = 1000,
    extra_args: list[str] | None = None,
    wait_pattern: str | None = FIRST_FRAME_PATTERN,
) -> Fleet:
    """Launch one probed pane per sandbox entry.

    Parameters:
        sandboxes (list[Sandbox]): see `make_sandboxes`.
        script (dict[str, Any]): faux script, identical for every pane.
        scratch (Path): directory for probe files.
        interval_ms (int): probe window.
        extra_args (list[str] | None): more pi flags for every pane, e.g. `--session`.
        wait_pattern (str | None): first-frame regex per pane.

    Returns:
        Fleet: running panes; the caller kills it.
    """
    fleet = Fleet()
    try:
        for index, box in enumerate(sandboxes):
            out = scratch / f"latency-{index}.jsonl"
            args, env = latency_args(out, interval_ms)
            pane = launch_tui(
                box,
                script,
                name=f"fleet{index}x{time.monotonic_ns()}",
                extra_args=[*args, *(extra_args or [])],
                env=env,
                wait_pattern=wait_pattern,
            )
            fleet.panes.append(pane)
            fleet.outs.append(out)
    except BaseException:
        fleet.kill()
        raise
    return fleet


def dump(metrics: dict[str, float]) -> str:
    """Format metrics as one sorted JSON line.

    Parameters:
        metrics (dict[str, float]): name -> value.

    Returns:
        str: JSON.
    """
    return json.dumps({k: round(v, 3) for k, v in sorted(metrics.items())})
