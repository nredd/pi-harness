"""Controlled session-kit module probe on the same 2k input; diagnostic, not a baseline rewrite."""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

import pytest

from harness.bench import check_against_baseline, check_ceiling, measure_many
from harness.fleet_load import launch_fleet, make_sandboxes, streaming_script
from harness.sessions import write_session

if TYPE_CHECKING:
    from pathlib import Path

LOGGER = logging.getLogger(__name__)
FEATURES = ("titles", "rules", "goal", "loop", "monitor", "diff")
pytestmark = pytest.mark.bench


def sample(root: Path, template_home: Path, enabled: str) -> dict[str, float]:
    """Measure one four-pane cell with the same 2k input and no real-provider requests.

    Parameters:
        root (Path): unique scratch directory.
        template_home (Path): rendered configuration.
        enabled (str): module, all-on/off, no-kit, or footer-off control.

    Returns:
        dict[str, float]: startup, idle bytes/s, and streaming input/loop latency.
    """
    boxes = make_sandboxes(root, template_home, 4, shared=True)
    boxes[0].patch_json(
        "pi-session-kit.json",
        {feature: {"enabled": enabled in ("on", "footer-off") or enabled == feature} for feature in FEATURES},
    )
    boxes[0].patch_json("pi-session-kit.json", {"titles": {"model": "faux/main"}})
    if enabled == "no-kit":
        settings = boxes[0].settings()
        settings["packages"] = [p for p in settings["packages"] if "pi-session-kit" not in str(p)]
        boxes[0].settings_path.write_text(json.dumps(settings))
    if enabled == "footer-off":
        (boxes[0].agent_dir / "extensions" / "expanded-footer.ts").rename(
            boxes[0].agent_dir / "expanded-footer.disabled"
        )
    session = root / "2k.jsonl"
    turns = write_session(session, boxes[0].workdir, 2000)
    started = time.perf_counter()
    fleet = launch_fleet(
        boxes,
        streaming_script(9000, 300),
        root,
        extra_args=["--session", str(session)],
        wait_pattern=rf"Turn {turns} found 8 files",
    )
    try:
        startup = time.perf_counter() - started
        time.sleep(2)
        fleet.mark()
        time.sleep(2)
        idle = fleet.metrics()
        fleet.mark()
        fleet.submit_all("go")
        fleet.type_into(0, 20)
        time.sleep(1.5)
        metrics = fleet.metrics()
        LOGGER.warning(json.dumps({"config": enabled, "startup_s": startup, "idle": idle, "turn": metrics}))
        return {"startup_s": startup, "idle_bytes_per_s": idle["bytes_per_s"], **metrics}
    finally:
        fleet.kill()


@pytest.mark.parametrize("enabled", ["off", "on", "no-kit", "footer-off", *FEATURES])
def test_kit_probe(tmp_path: Path, template_home: Path, enabled: str) -> None:
    """Compare three-sample medians, exactly as the original responsiveness benchmark does."""
    medians = measure_many(lambda: sample(tmp_path / str(time.monotonic_ns()), template_home, enabled), 3)
    LOGGER.warning(json.dumps({"config": enabled, "medians": medians}))
    check_against_baseline("ms_input_p95_n4", medians["input_p95_ms"])
    check_ceiling("idle_bytes_per_s_n4", medians["idle_bytes_per_s"], 100.0)
