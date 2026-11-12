"""`harness.startup`: timing parser, statistics and the pane sampler against a fake `pi`."""

from __future__ import annotations

import json
import runpy
import sys
from typing import TYPE_CHECKING, Any

import pytest

from harness import startup

if TYPE_CHECKING:
    from pathlib import Path

# Pi prints `PI_TIMING` before starting its interactive UI; preserve that ordering.
FAKE_PI = (
    "import sys,time;time.sleep(0.2);"
    "sys.stderr.write('--- Startup Timings: main ---\\n  TOTAL: 7ms\\n"
    "--- Startup Timings: extensions ---\\n  /h/node_modules/@a/b/index.ts module import: 3ms\\n');"
    "sys.stderr.flush();print('footer ctx 1%',flush=True);sys.stdin.readline()"
)
TIMING_BLOCK = """\
--- Startup Timings: main ---
  parseArgs: 1ms
  TOTAL: 482ms
-----------------------------

--- Startup Timings: extensions ---
  /Users/x/.pi/agent/npm/node_modules/@nredd/pi-subagents/src/index.ts module import: 289ms
  stray: 5ms
"""


def test_parse_timings_keys_by_section_and_strips_package_prefix() -> None:
    """Extension paths lose the home directory; lines outside a section are ignored."""
    assert startup.parse_timings("  orphan: 9ms\n" + TIMING_BLOCK) == {
        "main:parseArgs": 1,
        "main:TOTAL": 482,
        "extensions:@nredd/pi-subagents/src/index.ts module import": 289,
        "extensions:stray": 5,
    }
    assert startup.parse_timings("no timings here") == {}


def test_percentile_and_summarize() -> None:
    """Nearest rank: p90 of ten samples is the ninth."""
    values = [float(n) for n in range(1, 11)]
    assert startup.percentile(values, 0.9) == 9.0
    assert startup.summarize(values) == {"n": 10, "median": 5.5, "p90": 9.0, "min": 1.0, "max": 10.0}
    for bad in (0.0, 1.5):
        with pytest.raises(ValueError, match="q="):
            startup.percentile(values, bad)
    with pytest.raises(ValueError, match="0 samples"):
        startup.percentile([], 0.5)
    with pytest.raises(ValueError, match="zero samples"):
        startup.summarize([])


def test_scrubbed_env_drops_inherited_pi_state() -> None:
    """A nested pi must not inherit the caller's session, but `PI_TIMING` is forced on."""
    env = startup.scrubbed_env({"PI_SESSION_FILE": "x", "PI_TIMING": "0", "TMUX": "t", "HOME": "/h"})
    assert env == {"HOME": "/h", "PI_TIMING": "1"}


def test_sample_times_first_frame_and_input_ready() -> None:
    """The footer is seen, the marker echoed after it, and the phases parsed from stderr."""
    result = startup.sample(
        [sys.executable, "-c", FAKE_PI], env=startup.scrubbed_env({"PATH": "/usr/bin:/bin"})
    )
    assert 0 < result.first_paint_s <= result.frame_s <= result.input_ready_s
    assert result.timings == {"main:TOTAL": 7, "extensions:@a/b/index.ts module import": 3}


def test_sample_times_out_with_the_last_screen() -> None:
    """A pi that never draws the footer fails loudly instead of hanging."""
    with pytest.raises(TimeoutError, match="No ready UI"):
        startup.sample(["sleep", "5"], env={"PATH": "/usr/bin:/bin"}, timeout_s=0.3)


def test_run_alternates_variant_order_and_summarizes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Order flips each round so a systematic first-launch penalty hits both variants equally."""
    order: list[str] = []

    def fake_sample(argv: list[str], **_: object) -> startup.Sample:
        order.append(argv[0])
        return startup.Sample(0.1, 0.2, 0.3, {"main:TOTAL": 5})

    monkeypatch.setattr(startup, "sample", fake_sample)
    report = startup.run({"a": ["a"], "b": ["b"]}, runs=3, gap_s=0.0, env={})
    assert order == ["a", "b", "b", "a", "a", "b"]
    assert report["summary"]["a"]["input_ready_s"]["median"] == 0.3
    assert report["summary"]["b"]["phases_ms"]["main:TOTAL"]["max"] == 5.0
    with pytest.raises(ValueError, match="positive"):
        startup.run({"a": ["a"]}, runs=0, gap_s=0.0, env={})


def test_host_state_reports_load_and_power(monkeypatch: pytest.MonkeyPatch) -> None:
    """Darwin asks `pmset`; other systems say `unknown`."""
    monkeypatch.setattr(startup.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(
        startup.subprocess,
        "run",
        lambda *_, **__: type("R", (), {"stdout": "Now drawing from 'AC Power'\n -InternalBattery"})(),
    )
    assert startup.host_state()["power"] == "Now drawing from 'AC Power'"
    monkeypatch.setattr(startup.subprocess, "run", lambda *_, **__: type("R", (), {"stdout": ""})())
    assert startup.host_state()["power"] == "unknown"
    monkeypatch.setattr(startup.platform, "system", lambda: "Linux")
    state = startup.host_state()
    assert state["power"] == "unknown"
    assert state["system"] == "linux"
    assert len(state["load"]) == 3


def test_main_writes_json_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--variant` splits LABEL=COMMAND; the report is printed and written."""
    seen: dict[str, Any] = {}

    def fake_run(variants: dict[str, list[str]], **kwargs: object) -> dict[str, Any]:
        seen.update(variants=variants, **kwargs)
        return {"ok": True}

    monkeypatch.setattr(startup, "run", fake_run)
    out = tmp_path / "r.json"
    assert (
        startup.main(["--runs", "2", "--variant", "w=pi -x", "--env", "PI_X=a=b", "--output", str(out)]) == 0
    )
    assert seen["env"]["PI_X"] == "a=b"
    assert seen["variants"] == {"w": ["pi", "-x"]}
    assert seen["runs"] == 2
    assert json.loads(out.read_text()) == {"ok": True}
    assert json.loads(capsys.readouterr().out) == {"ok": True}
    assert startup.main([]) == 0
    assert seen["variants"] == {"pi": ["pi"]}


REPORT: dict[str, Any] = {
    "summary": {"a": {m: {"median": 1.0} for m in startup.MILESTONES}},
}


def test_regressions_flag_slow_missing_and_unbaselined() -> None:
    """Within 20% passes; beyond it, or with nothing to compare, fails."""
    assert startup.medians(REPORT) == {"a": dict.fromkeys(startup.MILESTONES, 1.0)}
    assert startup.regressions(REPORT, {"a": dict.fromkeys(startup.MILESTONES, 1.0)}) == []
    assert startup.regressions(REPORT, {"a": dict.fromkeys(startup.MILESTONES, 0.84)}) == []
    slow = startup.regressions(REPORT, {"a": dict.fromkeys(startup.MILESTONES, 0.8)})
    assert len(slow) == len(startup.MILESTONES)
    assert "`a` `first_paint_s` regressed: 1.000s > 0.960s" in slow[0]
    assert startup.regressions(REPORT, {}) == ["No baseline for variant `a`"]


def test_main_records_and_checks_a_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`--record` writes medians; `--baseline` turns a regression into exit 1."""
    monkeypatch.setattr(startup, "run", lambda *_, **__: REPORT)
    recorded = tmp_path / "base.json"
    assert startup.main(["--record", str(recorded)]) == 0
    assert json.loads(recorded.read_text()) == {"a": dict.fromkeys(startup.MILESTONES, 1.0)}
    assert startup.main(["--baseline", str(recorded)]) == 0
    recorded.write_text(json.dumps({"other": dict.fromkeys(startup.MILESTONES, 1.0)}))
    assert startup.main(["--baseline", str(recorded)]) == 1


def test_module_entrypoint_exits_with_main_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`python -m harness.startup` runs one real sample against a fake `pi` and exits 0."""
    fake = tmp_path / "fake_pi.py"
    fake.write_text(FAKE_PI.replace(";", "\n"))
    monkeypatch.setattr(
        sys, "argv", ["harness.startup", "--runs", "1", "--variant", f"x={sys.executable} {fake}"]
    )
    with pytest.raises(SystemExit) as raised:
        runpy.run_module("harness.startup", run_name="__main__")
    assert raised.value.code == 0
