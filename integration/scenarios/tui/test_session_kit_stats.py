"""Assembled-stack stats coverage: CLI imports, Plan mode, and the real overlay.

Package-native terminal scenarios own layout, navigation, accounting and corrupt imports.

References:
- https://github.com/nredd/pi-harness/tree/main/packages/session-kit/test/scenarios
"""

from __future__ import annotations

import re
import time
import unicodedata
from typing import TYPE_CHECKING

import pytest

from harness.interactive import submit
from harness.quota import FAST_TIMERS, USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.session_kit import kit_args
from harness.stats import import_machines, seed_shared_stats

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

STATUS = "STATUS-LINE-OK"
STATS = re.compile(r"\bctx \d+(\.\d+)?%/\S+ \(auto\)")
TITLE = re.compile(r"^ /stats\s+Overview\s+Models")
HELP = "tab tabs · r dates · m/M filter · ↑↓ scroll · q close"
HINT = re.compile(r"^[↑ ]? ?[↓ ]? *(\d+-\d+ of \d+ models|\d+ models below)")
Y_LABEL = re.compile(r"^\s*\d+(\.\d)?[kMB]? ┤")
ZERO_ROW = re.compile(r"^\s*0 ┼")


def cells(text: str) -> int:
    """Return terminal display cells, counting wide/fullwidth characters twice."""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


@pytest.fixture
def usage(sandbox: Sandbox) -> UsageFixture:
    """Install the status fixture in this isolated sandbox."""
    state = install_usage_fixture(sandbox)
    state.set(anthropic=(20, 40), codex=(30, 50))
    return state


@pytest.fixture
def launch(tui: Callable[..., TmuxPane], sandbox: Sandbox, usage: UsageFixture) -> Callable[..., TmuxPane]:
    """Launch a real pane with explicit kit and status fixture arguments."""

    def start(*, width: int = 120, height: int | None = None) -> TmuxPane:
        """Start one pane and wait for its first status row."""
        return tui(
            {"providers": {"faux": {"models": ["main"], "steps": []}}},
            width=width,
            height=height or (60 if width == 320 else 40),
            extra_args=["-e", str(USAGE_FIXTURE_EXTENSION), *kit_args(sandbox)],
            env=fixture_env(usage, FAST_TIMERS),
            wait_pattern=STATUS,
        )

    return start


def screen(pane: TmuxPane) -> list[str]:
    """Return exactly the visible terminal rows."""
    return pane.rows()[: pane.height]


def check_layout(pane: TmuxPane) -> str:
    """Check title/help positions, row widths and the overlay's footer coverage."""
    time.sleep(0.4)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert len(rows) == pane.height, shown
    assert TITLE.match(rows[0]), f"title not on row 0 (wrapped?)\n{shown}"
    wide = [(i, cells(r)) for i, r in enumerate(rows) if cells(r) > pane.width]
    assert not wide, f"rows wider than {pane.width}: {wide}\n{shown}"
    help_row = HINT.sub("", rows[-1].strip()).strip()
    assert help_row.startswith(HELP[: min(8, pane.width - 2)]), f"help row not last\n{shown}"
    assert STATUS not in shown, "overlay should cover the footer while open"
    return shown


def assert_chart(shown: str) -> None:
    """Check chart title, multiple numeric ticks and the zero axis."""
    assert re.search(r"Tokens per (hour|day|\d+ days|week)", shown), shown
    rows = shown.splitlines()
    assert sum(1 for r in rows if Y_LABEL.match(r)) >= 2, shown
    assert any(ZERO_ROW.match(r) for r in rows), shown


def wait_text(pane: TmuxPane, pattern: str) -> str:
    """Require a matching screen on two consecutive settled captures."""
    deadline = time.monotonic() + 8
    shown = previous = ""
    while time.monotonic() < deadline:
        shown = "\n".join(screen(pane))
        if re.search(pattern, shown) and shown == previous:
            return shown
        previous = shown
        time.sleep(0.1)
    pytest.fail(f"never saw {pattern!r} on a settled screen\n{shown}")


def assert_footer_intact(pane: TmuxPane) -> None:
    """Require the core stats row followed by the fixture status after closing."""
    pane.wait_for(STATUS, timeout_s=10)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert not TITLE.search(shown), shown
    stats = [i for i, r in enumerate(rows) if STATS.search(r)]
    assert len(stats) == 1, shown
    assert any(STATUS in r for r in rows[stats[0] + 1 :]), shown


def open_stats(pane: TmuxPane) -> str:
    """Open the real command and check its first overlay frame."""
    submit(pane, "/stats")
    pane.wait_for(r"^ /stats\s+Overview", timeout_s=30)
    return check_layout(pane)


def select_total(pane: TmuxPane, tokens: int) -> str:
    """Find a range with the exact integer total, not a rounded approximation."""
    expected = re.compile(rf"Total tokens: {tokens}(?![\d.,kMB])")
    shown = ""
    for _ in range(6):
        for _ in range(60):
            pane.send_keys("k")
        time.sleep(0.3)
        shown = check_layout(pane)
        if expected.search(shown):
            return shown
        pane.send_keys("r")
    pytest.fail(f"No range reports exactly {tokens} tokens\n{shown}")


def select_filter(pane: TmuxPane, label: str) -> str:
    """Find a provider or All filter without assuming filter order."""
    expected = re.compile(r"filter:\s*" + re.escape(label) + r"(?=\s|$)")
    shown = ""
    for _ in range(12):
        shown = check_layout(pane)
        if expected.search(shown):
            return shown
        pane.send_keys("m")
    pytest.fail(f"No filter labeled {label!r}\n{shown}")


def assert_hourly_tabs(pane: TmuxPane) -> None:
    """Exercise both hourly tabs and scrolling before returning to Overview."""
    for _ in range(40):
        pane.send_keys("j")
    shown = wait_text(pane, r"Tokens per hour")
    assert_chart(shown)
    check_layout(pane)
    pane.send_keys("Tab")
    shown = wait_text(pane, r"Tokens per hour")
    assert_chart(shown)
    check_layout(pane)
    for key in ("Down", "Up", "j", "k"):
        pane.send_keys(key)
    check_layout(pane)
    pane.send_keys("Tab")
    for _ in range(60):
        pane.send_keys("k")
    wait_text(pane, r"Total tokens:")


def test_stats_shared_machines_default_combined_freshness_and_plan_mode(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, portable_stats_artifact: Path, tmp_path: Path
) -> None:
    """Ordinary `/stats` consumes CLI imports, dedups copied events and labels coverage/sync."""
    machines = seed_shared_stats(portable_stats_artifact, tmp_path / "producers", sandbox.agent_dir)
    assert len({machine.machine_id for machine in machines}) == 3
    import_machines(
        portable_stats_artifact, tmp_path / "repeat-cli", sandbox.agent_dir, tmp_path / "producers" / "shared"
    )
    pane = launch(width=160, height=50)
    submit(pane, "/plan start")
    pane.wait_for(r"(?i)plan", timeout_s=15)
    shown = open_stats(pane)
    assert re.search(r"Total tokens: 624\b", shown), shown
    assert re.search(r"\b3 machines\b", shown), shown
    assert re.search(r"(?i)(last remote sync|remote sync|last sync)", shown), shown
    assert not re.search(r"(?i)local.only|never.synced", shown), shown
    for total, anthropic, codex in [(156, 52, 104), (338, 130, 208), (624, 260, 364)]:
        select_total(pane, total)
        if total != 624:
            assert_hourly_tabs(pane)
        shown = select_filter(pane, "anthropic")
        assert re.search(rf"Total tokens: {anthropic}\b", shown), shown
        shown = select_filter(pane, "openai-codex")
        assert re.search(rf"Total tokens: {codex}\b", shown), shown
        select_filter(pane, "All models")
    select_total(pane, 156)
    for width, height in [(60, 24), (320, 60), (80, 30), (240, 50), (60, 40)]:
        pane.resize(width, height)
        time.sleep(0.8)
        check_layout(pane)
        assert_hourly_tabs(pane)
    pane.send_keys("q")
    assert_footer_intact(pane)
    shown = open_stats(pane)
    assert re.search(r"Total tokens: 624\b", shown), shown
    pane.send_keys("q")
    assert_footer_intact(pane)
