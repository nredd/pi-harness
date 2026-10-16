"""pi-session-kit `/stats` overlay across widths, on a seeded sessions dir.

Real pi in tmux with the kit selected from sandbox package settings and the usage fixture supplying a
status row, so "footer intact" is checkable. The sandbox's `sessions/` is seeded with 45 days of
assistant calls from two providers and four models, plus rows `/stats` must ignore: a `faux` call,
a zero-usage `router/default` stub, a `steer_subagent` tool result carrying `usage`, and a forked
copy of a call. The checks are structural (title on row 0, help on the last row, no row wider than
the pane) plus content that proves the keys work: Tab, `r`, `m`, scroll and `q`.

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
- `src/stats/component.ts`: layout and keys; `src/stats/load.ts`: what is counted
- `scenarios/tui/test_session_kit_monitor_diff.py`: the `/diff` overlay checks this follows
"""

from __future__ import annotations

import json
import re
import subprocess
import time
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest

from harness.interactive import submit
from harness.quota import FAST_TIMERS, USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.session_kit import STATS_MODELS, SeededStats, assistant, kit_args, seed_stats_sessions
from harness.stats import hourly_entries, import_machines, seed_shared_stats, write_history

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

STATUS = "STATUS-LINE-OK"
STATS = re.compile(r"\bctx \d+(\.\d+)?%/\S+ \(auto\)")
WIDTHS = [60, 80, 120, 160, 200, 240, 320]
TALL = {320: 60}
TITLE = re.compile(r"^ /stats\s+Overview\s+Models")
HELP = "tab tabs · r dates · m/M filter · ↑↓ scroll · q close"
# Models prefixes the help row with where the list is: `↑ ↓ 3-4 of 4 models` or `↓ 4 models below`.
HINT = re.compile(r"^[↑ ]? ?[↓ ]? *(\d+-\d+ of \d+ models|\d+ models below)")
Y_LABEL = re.compile(r"^\s*\d+(\.\d)?[kMB]? ┤")
ZERO_ROW = re.compile(r"^\s*0 ┼")


def cells(text: str) -> int:
    """Display width of plain text: wide and fullwidth characters take two cells.

    Parameters:
        text (str): one screen row.

    Returns:
        int: terminal cells.
    """
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


@pytest.fixture
def usage(sandbox: Sandbox) -> UsageFixture:
    """Usage fixture (status row) for this sandbox.

    Parameters:
        sandbox (Sandbox): sandbox the fixture is installed into.

    Returns:
        UsageFixture: state with quota values set.
    """
    state = install_usage_fixture(sandbox)
    state.set(anthropic=(20, 40), codex=(30, 50))
    return state


@pytest.fixture
def seeded(sandbox: Sandbox) -> SeededStats:
    """Seed the sandbox's sessions dir.

    Parameters:
        sandbox (Sandbox): sandbox to seed.

    Returns:
        SeededStats: expected facts.
    """
    return seed_stats_sessions(sandbox.agent_dir)


@pytest.fixture
def launch(tui: Callable[..., TmuxPane], sandbox: Sandbox, usage: UsageFixture) -> Callable[..., TmuxPane]:
    """A launcher for panes with the kit and the status fixture.

    Parameters:
        tui (Callable[..., TmuxPane]): shared pane launcher (kills panes at teardown).
        sandbox (Sandbox): sandbox the panes run in.
        usage (UsageFixture): status fixture.

    Returns:
        Callable[..., TmuxPane]: `start(width=, height=)`.
    """

    def start(*, width: int = 120, height: int | None = None) -> TmuxPane:
        """Launch one pane and wait for its status row.

        Parameters:
            width (int): pane columns.
            height (int | None): pane rows; defaults by width.

        Returns:
            TmuxPane: pane showing the first frame.
        """
        return tui(
            {"providers": {"faux": {"models": ["main"], "steps": []}}},
            width=width,
            height=height or TALL.get(width, 40),
            extra_args=["-e", str(USAGE_FIXTURE_EXTENSION), *kit_args(sandbox)],
            env=fixture_env(usage, FAST_TIMERS),
            wait_pattern=STATUS,
        )

    return start


def screen(pane: TmuxPane) -> list[str]:
    """The visible rows, exactly `height` of them.

    Parameters:
        pane (TmuxPane): running pane.

    Returns:
        list[str]: rows, trailing spaces removed.
    """
    return pane.rows()[: pane.height]


def check_layout(pane: TmuxPane) -> str:
    """Assert the overlay fits the pane, title first and help last, and return the screen text.

    Parameters:
        pane (TmuxPane): pane showing the overlay.

    Returns:
        str: screen rows joined by newlines.
    """
    time.sleep(0.4)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert len(rows) == pane.height, shown
    assert TITLE.match(rows[0]), f"title not on row 0 (wrapped?)\n{shown}"
    wide = [(i, cells(r)) for i, r in enumerate(rows) if cells(r) > pane.width]
    assert not wide, f"rows wider than {pane.width}: {wide}\n{shown}"
    help_row = HINT.sub("", rows[-1].strip()).strip()
    # the hint pushes the keys right, so a narrow pane may cut them; the first key is always there
    assert help_row.startswith(HELP[: min(8, pane.width - 2)]), f"help row not last\n{shown}"
    assert STATUS not in shown, "overlay should cover the footer while open"
    return shown


def assert_chart(shown: str) -> None:
    """The chart has a titled header, at least two y labels, and a zero row.

    Parameters:
        shown (str): screen text.
    """
    assert re.search(r"Tokens per (hour|day|\d+ days|week)", shown), shown
    rows = shown.splitlines()
    assert sum(1 for r in rows if Y_LABEL.match(r)) >= 2, shown
    assert any(ZERO_ROW.match(r) for r in rows), shown


def wait_text(pane: TmuxPane, pattern: str) -> str:
    """Poll the screen until `pattern` shows on a settled frame.

    Matching the first capture that contains `pattern` raced pi's repaint on wide panes: the selector
    row could be new while the model list below it was still the previous frame. So the match must
    hold on two identical captures in a row.

    Parameters:
        pane (TmuxPane): running pane.
        pattern (str): regex.

    Returns:
        str: screen text.
    """
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
    """Assert the overlay is gone and the stats and status rows are drawn again.

    Parameters:
        pane (TmuxPane): pane after closing the overlay.
    """
    pane.wait_for(STATUS, timeout_s=10)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert not TITLE.search(shown), shown
    stats = [i for i, r in enumerate(rows) if STATS.search(r)]
    assert len(stats) == 1, shown
    assert any(STATUS in r for r in rows[stats[0] + 1 :]), shown


def open_stats(pane: TmuxPane) -> str:
    """Run `/stats` and wait for the overlay title.

    Parameters:
        pane (TmuxPane): running pane.

    Returns:
        str: screen text.
    """
    submit(pane, "/stats")
    pane.wait_for(r"^ /stats\s+Overview", timeout_s=30)
    return check_layout(pane)


@pytest.mark.parametrize("width", WIDTHS)
def test_stats_overlay_layout_keys_and_close(
    launch: Callable[..., TmuxPane], seeded: SeededStats, width: int
) -> None:
    """At every width: Overview fits with heatmap and chart, Tab/r/m/scroll change it, `q` closes."""
    pane = launch(width=width)
    shown = open_stats(pane)
    assert "Less ░ ▒ ▓ █ More" in shown, shown
    assert f"Favorite model: {seeded['favorite']}" in shown, shown
    assert "unreadable" not in shown, shown
    # faux / router / tool-result usage would dwarf everything and show up by name
    assert "faux" not in shown, shown
    assert "router" not in shown, shown
    # Overview scrolls to its chart on short panes
    for _ in range(30):
        pane.send_keys("j")
    assert_chart(wait_text(pane, r"Tokens per"))

    pane.send_keys("Tab")
    shown = wait_text(pane, r"• anthropic ")
    check_layout(pane)
    assert_chart(shown)
    assert "• openai-codex" in shown or "of 4 models" in shown, shown
    assert "by provider" in shown, shown

    pane.send_keys("r")
    shown = wait_text(pane, r"Tokens per day")
    check_layout(pane)
    pane.send_keys("m")
    shown = wait_text(pane, r"filter: anthropic\b")
    assert "by model" in shown, shown
    assert "gpt-6.1-sol" not in shown, shown
    check_layout(pane)
    pane.send_keys("M")
    wait_text(pane, r"filter: All models")

    pane.send_keys("q")
    assert_footer_intact(pane)


def test_stats_overlay_survives_resize(launch: Callable[..., TmuxPane], seeded: SeededStats) -> None:
    """Resizing re-lays the overlay out at every width, on both tabs."""
    pane = launch(width=120)
    open_stats(pane)
    for width, height in [(60, 24), (320, 60), (80, 30), (240, 50), (60, 40)]:
        pane.resize(width, height)
        time.sleep(0.8)
        check_layout(pane)
        pane.send_keys("Tab")
        time.sleep(0.4)
        check_layout(pane)
    pane.send_keys("Escape")
    assert_footer_intact(pane)


def test_stats_reopens_from_cache(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, seeded: SeededStats
) -> None:
    """The first open writes the cache; a second open in the same pane reads it and shows the same totals."""
    pane = launch(width=120)
    first = open_stats(pane)
    cache = sandbox.agent_dir / "pi-session-kit" / "stats-cache.json"
    assert cache.is_file()
    assert json.loads(cache.read_text())["version"] == 2
    pane.send_keys("q")
    assert_footer_intact(pane)
    second = open_stats(pane)
    total = re.compile(r"Total tokens: \S+")
    before = total.search(first)
    after = total.search(second)
    assert before, first
    assert after, second
    assert before.group(0) == after.group(0), (first, second)
    pane.send_keys("q")


def test_stats_with_no_history_notifies(launch: Callable[..., TmuxPane]) -> None:
    """An empty sessions dir is a notification, not an empty overlay."""
    pane = launch(width=120)
    submit(pane, "/stats")
    pane.wait_for(r"/stats: no usage recorded yet", timeout_s=20)
    assert not TITLE.search(pane.capture())
    assert_footer_intact(pane)


def test_stats_is_allowed_in_plan_mode(launch: Callable[..., TmuxPane], seeded: SeededStats) -> None:
    """`/stats` is a command, not a tool, so Plan mode does not stop it."""
    pane = launch(width=120)
    submit(pane, "/plan start")
    pane.wait_for(r"(?i)plan", timeout_s=15)
    open_stats(pane)
    pane.send_keys("q")
    pane.wait_for(STATUS, timeout_s=10)


def test_stats_short_pane_reaches_every_model(launch: Callable[..., TmuxPane], seeded: SeededStats) -> None:
    """In a 20-row pane the chart fills Models, yet scrolling reaches every model and the hint never lies."""
    pane = launch(width=80, height=20)
    open_stats(pane)
    pane.send_keys("Tab")
    wait_text(pane, r"models below|of 4 models")
    seen = set()
    for _ in range(60):
        shown = "\n".join(screen(pane))
        seen.update(re.findall(r"• (claude-[\w-]+|gpt-[\w.-]+) \(", shown))
        assert "Infinity" not in shown, shown
        pane.send_keys("j")
        time.sleep(0.05)
    assert seen == {model for _, model, _ in STATS_MODELS}, seen
    # at the bottom the last model is on screen and nothing is left below it
    shown = check_layout(pane)
    assert "gpt-5.6-terra" in shown, shown
    assert "↓" not in shown.splitlines()[-1].split("tab tabs")[0], shown
    pane.send_keys("q")
    assert_footer_intact(pane)


# Box-drawing ports (left, right, up, down) of every glyph `plot` can draw.
PORTS = {
    "─": "LR",
    "│": "UD",
    "╭": "RD",
    "╮": "LD",
    "╰": "UR",
    "╯": "LU",
    "┴": "LRU",
    "┬": "LRD",
    "├": "UDR",
    "┤": "UDL",
    "┼": "LRUD",
}
AXIS_COLUMN = 8  # 1-col pad + 6-col labels + space


def dangling_ports(rows: list[str]) -> list[str]:
    """Line glyphs whose port has no matching neighbour: a broken line on screen.

    Parameters:
        rows (list[str]): plot body rows, axis and labels removed.

    Returns:
        list[str]: `row:col glyph port` for each dangling port; the plot's left/right edges are open.
    """
    width = max((len(r) for r in rows), default=0)

    def ports(y: int, x: int) -> str:
        if not 0 <= y < len(rows) or not 0 <= x < len(rows[y]):
            return ""
        return PORTS.get(rows[y][x], "")

    opposite = {"L": (0, -1, "R"), "R": (0, 1, "L"), "U": (-1, 0, "D"), "D": (1, 0, "U")}
    out = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            for port in PORTS.get(ch, ""):
                dy, dx, need = opposite[port]
                if (port == "L" and x == 0) or (port == "R" and x == width - 1):
                    continue
                if need not in ports(y + dy, x + dx):
                    out.append(f"{y}:{x} {ch} {port}")
    return out


def test_stats_fullscreen_chart_fills_the_pane_and_stays_connected(
    launch: Callable[..., TmuxPane], seeded: SeededStats
) -> None:
    """Regression for the 130x38 fullscreen report: the chart was 5 rows over 7 empty ones, and crossing
    providers left broken joins (`╰╰`, lone corners). Now it grows in tick steps and every line glyph
    meets a neighbour, on both tabs.
    """
    pane = launch(width=130, height=38)
    open_stats(pane)
    for tab in ("Overview", "Models"):
        if tab == "Models":
            pane.send_keys("Tab")
            wait_text(pane, r"• anthropic ")
        rows = screen(pane)
        shown = "\n".join(rows)
        plot = [r for r in rows if len(r) > AXIS_COLUMN and r[AXIS_COLUMN] in "┤│┼"]
        assert len(plot) >= 6, shown
        body = [r[AXIS_COLUMN + 1 :] for r in plot]
        assert dangling_ports(body) == [], f"{tab}: {dangling_ports(body)}\n{shown}"
        if tab == "Overview":
            assert len(plot) == 11, f"expected 10 rows above zero at 130x38\n{shown}"
            legend = next(i for i, r in enumerate(rows) if "● anthropic" in r)
            blank = sum(1 for r in rows[legend + 1 : -1] if not r.strip())
            assert blank < 5, f"{blank} empty rows under the chart\n{shown}"
    pane.send_keys("q")
    assert_footer_intact(pane)


def select_total(pane: TmuxPane, tokens: int) -> str:
    """Cycle ranges until Overview reports the fixture's exact integer total.

    Matching totals rather than a fixed cycle order permits compact range labels,
    but never accepts rounded/widened accounting or a different time filter.

    Parameters:
        pane (TmuxPane): Overview pane.
        tokens (int): exact expected tokens for the requested fixture range.

    Returns:
        str: settled frame at the top of Overview.
    """
    expected = re.compile(rf"Total tokens: {tokens}(?![\d.,kMB])")
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
    """Cycle forward to a provider/All filter without assuming model filter order.

    Parameters:
        pane (TmuxPane): Overview pane.
        label (str): exact provider or `All models` label.

    Returns:
        str: settled frame with the requested filter.
    """
    expected = re.compile(r"filter:\s*" + re.escape(label) + r"(?=\s|$)")
    for _ in range(12):
        shown = check_layout(pane)
        if expected.search(shown):
            return shown
        pane.send_keys("m")
    pytest.fail(f"No filter labeled {label!r}\n{shown}")


def assert_hourly_tabs(pane: TmuxPane) -> None:
    """Check the hourly plot, both tabs, and scroll keys without relying on range order.

    Parameters:
        pane (TmuxPane): Overview pane in a short range.
    """
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


@pytest.mark.parametrize("width", WIDTHS)
def test_stats_hourly_ranges_totals_filters_and_close(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, width: int
) -> None:
    """5h/24h use call timestamps at every width, on both tabs, with exact provider totals."""
    write_history(sandbox.agent_dir, hourly_entries(datetime.now(UTC)))
    pane = launch(width=width)
    shown = open_stats(pane)
    assert re.search(r"Total tokens: 546\b", shown), shown  # default All; future/exclusions ignored
    assert re.search(r"(?i)local.only|never.synced", shown), shown
    for total, anthropic, codex in [(78, 26, 52), (260, 104, 156), (546, 234, 312)]:
        select_total(pane, total)
        if total != 546:
            assert_hourly_tabs(pane)
        shown = select_filter(pane, "anthropic")
        assert re.search(rf"Total tokens: {anthropic}\b", shown), shown
        shown = select_filter(pane, "openai-codex")
        assert re.search(rf"Total tokens: {codex}\b", shown), shown
        select_filter(pane, "All models")
    pane.send_keys("Escape")
    assert_footer_intact(pane)


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


def test_stats_corrupt_import_retains_totals_and_local_scan_stays_fresh(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, portable_stats_artifact: Path, tmp_path: Path
) -> None:
    """A corrupt remote snapshot cannot erase last-good usage or conceal fresh local calls."""
    machines = seed_shared_stats(portable_stats_artifact, tmp_path / "producers", sandbox.agent_dir)
    manifest = machines[1].snapshot_dir / "manifest.json"
    manifest.write_text("{not valid json\n")
    failure = None
    try:
        import_machines(
            portable_stats_artifact,
            tmp_path / "retry-cli",
            sandbox.agent_dir,
            tmp_path / "producers" / "shared",
        )
    except subprocess.CalledProcessError as error:
        # Either a nonzero import or a successful partial import may report incomplete
        # coverage, but neither may drop the last-good data. The UI proves retention.
        failure = error.output
    if failure is not None:
        assert re.search(r"(?i)invalid|corrupt|incomplete|json|manifest", failure), failure
    write_history(
        sandbox.agent_dir,
        [assistant(datetime.now(UTC) - timedelta(minutes=5), "anthropic", "claude-opus-5-5", 2)],
        session_id="fresh-local",
    )
    pane = launch(width=160, height=50)
    shown = open_stats(pane)
    assert re.search(r"Total tokens: 676\b", shown), shown  # 624 retained + 52 freshly scanned
    assert re.search(r"(?i)incomplete", shown), shown
    assert re.search(r"(?i)(last remote sync|remote sync|last sync)", shown), shown
    pane.send_keys("q")
    assert_footer_intact(pane)


BULLET_COLOR = re.compile(r"\x1b\[([0-9;]*)m●")


def test_stats_chart_matches_heatmap_width_and_providers_contrast(
    launch: Callable[..., TmuxPane], seeded: SeededStats
) -> None:
    """Regression for the 130x38 reports: the chart ran to the pane edge while the heatmap was 56 columns,
    then both sat at ~43% of the pane, and the two provider lines were near-identical blue/olive. Now
    both span 75% of the pane with the same right edge, and each provider bullet has its own colour.
    """
    pane = launch(width=130, height=38)
    open_stats(pane)
    rows = screen(pane)
    shown = "\n".join(rows)
    mon = next(r for r in rows if r.startswith(" Mon "))
    # tmux trims trailing blanks, so the chart's extent is its widest plot row, not the zero row
    plot = [r for r in rows if len(r) > AXIS_COLUMN and r[AXIS_COLUMN] in "┤│┼"]
    zero = max(plot, key=len)
    # tmux trims trailing blanks: compare the drawn extent, padded heatmap row vs plot zero row
    weeks = len(mon) - len(" Mon ")
    # heatmap and chart span 75% of the pane (after the 1-column margin): 97 of 129 at 130 wide
    assert len(mon) - 1 == round(0.75 * (pane.width - 1)), f"heatmap not 75% wide\n{shown}"
    assert len(zero) <= len(" Mon ") + weeks, f"chart wider than heatmap\n{mon}\n{zero}"
    assert len(zero) >= len(" Mon ") + weeks - 1, f"chart narrower than heatmap\n{mon}\n{zero}"
    legend = next(r for r in pane.capture(styled=True).splitlines() if "anthropic" in r and "●" in r)
    colors = BULLET_COLOR.findall(legend)
    assert len(colors) == 2, legend
    assert colors[0] != colors[1], legend
    pane.send_keys("q")
    assert_footer_intact(pane)
