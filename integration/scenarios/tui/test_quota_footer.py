"""Quota footer row: values, tiers, severity, polling, stale/timeout recovery, reload, absence.

The router is replaced by `providers/usage_fixture.ts` (no credentials, no network) and the footer's
60 s poll / 12 s timeout are scaled by `providers/fast_timers.mjs`, so every scenario but one runs in
seconds. `test_real_poll_interval_is_sixty_seconds` keeps real time and is `slow`.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.quota import (
    FAST_POLL_MS,
    FAST_TIMEOUT_MS,
    FAST_TIMERS,
    POLL_MS,
    USAGE_FIXTURE_EXTENSION,
    fixture_env,
    install_usage_fixture,
    parse_quota_row,
    sgr_by_percent,
    values,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

FULL_ROW = r"^\s*Quota left:"
COMPACT_ROW = r"^\s*Left:"
ANY_ROW = r"^\s*(Quota left:|Left:)"
STATUS = "STATUS-LINE-OK"
DIRECT_ANTHROPIC = "anthropic/claude-haiku-4-5"
DIRECT_CODEX = "openai-codex/gpt-5.4"
ROUTER = "router/default"
SETTLE_S = 15.0


def script() -> dict[str, Any]:
    """Faux script that also provides a `router/default` virtual model.

    Returns:
        dict[str, Any]: faux script.
    """
    return {
        "providers": {
            "faux": {"models": ["main"], "steps": []},
            "router": {"models": [], "virtual": [{"id": "default", "to": "faux/main"}]},
        }
    }


@pytest.fixture
def usage(sandbox: Sandbox) -> UsageFixture:
    """Fixture state and log for one sandbox, router package removed."""
    return install_usage_fixture(sandbox)


@pytest.fixture
def launch(tui: Callable[..., TmuxPane], usage: UsageFixture) -> Callable[..., TmuxPane]:
    """Launch pi with the usage fixture and fast timers; the model id is the first-frame marker."""

    def start(
        model: str = "faux/main", *, fast: bool = True, width: int = 120, wait: str | None = None
    ) -> TmuxPane:
        return tui(
            script(),
            width=width,
            model=model,
            extra_args=["-e", str(USAGE_FIXTURE_EXTENSION)],
            env=fixture_env(usage, FAST_TIMERS if fast else None),
            wait_pattern=wait or model.split("/", 1)[1],
        )

    return start


def row_values(pane: TmuxPane, provider: str) -> list[str]:
    """Return the on-screen values of one provider, empty when no row."""
    row = parse_quota_row(pane.capture())
    return values(row, provider) if row and provider in row else []


def wait_values(pane: TmuxPane, provider: str, expected: list[str], timeout_s: float = SETTLE_S) -> None:
    """Poll until a provider's displayed values equal `expected`."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if row_values(pane, provider) == expected:
            return
        time.sleep(0.2)
    pytest.fail(f"'{provider}' never showed {expected}; last {row_values(pane, provider)}\n{pane.capture()}")


@pytest.mark.parametrize("model", [DIRECT_ANTHROPIC, DIRECT_CODEX, ROUTER])
def test_row_shows_both_providers_for_direct_and_router_models(
    launch: Callable[..., TmuxPane], usage: UsageFixture, model: str
) -> None:
    """Both providers' 5h and weekly remaining show whichever model is selected."""
    usage.set(anthropic=(20, 40), codex=(30.5, 99.9))
    pane = launch(model)
    pane.wait_for(FULL_ROW, timeout_s=SETTLE_S)
    wait_values(pane, "anthropic", ["80%", "60%"])
    wait_values(pane, "openai-codex", ["69%", "0%"])
    assert "Anthropic" in pane.capture()
    assert "OpenAI" in pane.capture()
    assert usage.requests()[0]["ready"] is True, "Footer requested usage before provider startup finished"


def test_missing_provider_reads_dashes(launch: Callable[..., TmuxPane], usage: UsageFixture) -> None:
    """A provider with no snapshot shows `--` for both windows."""
    usage.set(anthropic=(10, 10))
    pane = launch(DIRECT_ANTHROPIC)
    wait_values(pane, "anthropic", ["90%", "90%"])
    wait_values(pane, "openai-codex", ["--", "--"])


def test_severity_colours_follow_the_thresholds(launch: Callable[..., TmuxPane], usage: UsageFixture) -> None:
    """Warning at 20 left or less, error at 5 or less; each boundary lands on the right side."""
    # (used percents: anth 5h, anth weekly, codex 5h, codex weekly) -> remaining, with its level.
    rounds = [
        ((50, 80, 81, 95), [(50, "ok"), (20, "warning"), (19, "warning"), (5, "error")]),
        ((79, 82, 96, 100), [(21, "ok"), (18, "warning"), (4, "error"), (0, "error")]),
    ]
    styles: dict[str, set[str]] = {"ok": set(), "warning": set(), "error": set()}
    pane = launch(DIRECT_ANTHROPIC)
    for used, expected in rounds:
        usage.set(anthropic=(used[0], used[1]), codex=(used[2], used[3]))
        wait_values(pane, "anthropic", [f"{expected[0][0]}%", f"{expected[1][0]}%"])
        wait_values(pane, "openai-codex", [f"{expected[2][0]}%", f"{expected[3][0]}%"])
        by_percent = sgr_by_percent(pane.capture(styled=True))
        for left, level in expected:
            styles[level].add(by_percent[left])
    for level, found in styles.items():
        assert len(found) == 1, f"'{level}' rendered with inconsistent styles {found}"
    assert len({next(iter(found)) for found in styles.values()}) == 3, f"levels share a style: {styles}"


def test_compact_tier_and_resize(launch: Callable[..., TmuxPane], usage: UsageFixture) -> None:
    """A narrow terminal swaps to `Left: Anth ... | OAI ...`; widening restores the full row."""
    usage.set(anthropic=(20, 40), codex=(30, 50))
    pane = launch(DIRECT_ANTHROPIC, width=120)
    pane.wait_for(FULL_ROW, timeout_s=SETTLE_S)
    pane.resize(60, 30)
    pane.wait_for(COMPACT_ROW, timeout_s=SETTLE_S)
    screen = pane.capture()
    assert "Anth" in screen
    assert "OAI" in screen
    assert values(parse_quota_row(screen) or {}, "anthropic") == ["80%", "60%"]
    assert max(len(line) for line in pane.rows()) <= 60
    pane.resize(120, 40)
    pane.wait_for(FULL_ROW, timeout_s=SETTLE_S)


def test_idle_pane_follows_polls_and_keeps_footer_intact(
    launch: Callable[..., TmuxPane], usage: UsageFixture
) -> None:
    """With no input, a changed router answer shows within a few poll intervals; stats and status stay."""
    usage.set(anthropic=(10, 10), codex=(10, 10))
    pane = launch(DIRECT_ANTHROPIC)
    wait_values(pane, "anthropic", ["90%", "90%"])
    usage.set(anthropic=(60, 70), codex=(10, 10))
    wait_values(pane, "anthropic", ["40%", "30%"])
    screen = pane.capture()
    assert STATUS in screen
    assert "ctx" in screen
    assert len(usage.requests()) >= 2


def test_stale_provider_is_marked_and_recovers(launch: Callable[..., TmuxPane], usage: UsageFixture) -> None:
    """A stale snapshot keeps its windows but is marked; a fresh one clears the mark."""
    usage.set(anthropic=(10, 10), codex=(10, 10), statuses=("stale", "available"))
    pane = launch(DIRECT_ANTHROPIC)
    wait_values(pane, "anthropic", ["90%", "90%"])
    row = parse_quota_row(pane.capture()) or {}
    assert "stale" in row["anthropic"]["_raw"].lower()
    assert "stale" not in row["openai-codex"]["_raw"].lower()
    usage.set(anthropic=(10, 10), codex=(10, 10))
    deadline = time.monotonic() + SETTLE_S
    while time.monotonic() < deadline:
        if (
            "stale"
            not in (parse_quota_row(pane.capture()) or {}).get("anthropic", {"_raw": "stale"})["_raw"].lower()
        ):
            return
        time.sleep(0.2)
    pytest.fail(f"stale mark never cleared\n{pane.capture()}")


def raw_segment(pane: TmuxPane, provider: str) -> str:
    """Return the raw on-screen text of one provider's segment, empty when absent."""
    return (parse_quota_row(pane.capture()) or {}).get(provider, {}).get("_raw", "")


def wait_stale(pane: TmuxPane, provider: str, *, stale: bool, timeout_s: float = SETTLE_S) -> None:
    """Poll until a provider's segment does (or does not) carry the stale marker."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        segment = raw_segment(pane, provider)
        if segment and ("stale" in segment.lower()) == stale:
            return
        time.sleep(0.2)
    pytest.fail(f"'{provider}' never became stale={stale}\n{pane.capture()}")


@pytest.mark.parametrize("mode", ["hang", "error"])
def test_failed_poll_retains_values_marks_stale_and_recovers(
    launch: Callable[..., TmuxPane], usage: UsageFixture, mode: str
) -> None:
    """A request that never answers (timeout) or errors keeps the last 90% values, marks BOTH stale.

    The router's new answer (50%) must never show while it is failing; the next good poll shows it
    and clears the marks.
    """
    usage.set(anthropic=(10, 10), codex=(10, 10))
    pane = launch(DIRECT_ANTHROPIC)
    wait_values(pane, "anthropic", ["90%", "90%"])
    wait_stale(pane, "anthropic", stale=False)
    usage.set(anthropic=(50, 50), codex=(50, 50), mode=mode)
    wait_stale(pane, "anthropic", stale=True)
    wait_stale(pane, "openai-codex", stale=True)
    # Let a timeout and another poll pass; the retained values must hold.
    time.sleep(FAST_TIMEOUT_MS / 1000 + FAST_POLL_MS / 1000 * 2)
    assert pane.is_alive()
    assert row_values(pane, "anthropic") == ["90%", "90%"]
    assert row_values(pane, "openai-codex") == ["90%", "90%"]
    assert STATUS in pane.capture()
    usage.set(anthropic=(50, 50), codex=(50, 50))
    wait_values(pane, "anthropic", ["50%", "50%"])
    wait_stale(pane, "anthropic", stale=False)
    wait_stale(pane, "openai-codex", stale=False)


def assert_poll_rate(usage: UsageFixture, window_s: float = 6.0) -> None:
    """Assert the request rate over `window_s` matches ONE poller (fast interval), not a leaked second."""
    before = len(usage.requests())
    time.sleep(window_s)
    polls = len(usage.requests()) - before
    expected = window_s / (FAST_POLL_MS / 1000)
    assert expected - 2 <= polls <= expected + 2, f"{polls} polls in {window_s}s, expected about {expected}"


@pytest.mark.parametrize("command", ["/reload", "/new"])
def test_session_replacement_does_not_duplicate_polling(
    launch: Callable[..., TmuxPane], usage: UsageFixture, command: str
) -> None:
    """After `/reload` or `/new` the old footer's timers are disposed: the request rate does not double."""
    usage.set(anthropic=(10, 10), codex=(10, 10))
    pane = launch(DIRECT_ANTHROPIC)
    wait_values(pane, "anthropic", ["90%", "90%"])
    submit(pane, command)
    time.sleep(3)
    wait_values(pane, "anthropic", ["90%", "90%"])
    assert STATUS in pane.capture()
    assert_poll_rate(usage)


def test_very_narrow_terminal_truncates_without_wrapping(
    launch: Callable[..., TmuxPane], usage: UsageFixture
) -> None:
    """At 25 columns the row is cut to fit: no row is wider, no provider spills onto its own row."""
    usage.set(anthropic=(20, 40), codex=(30, 50))
    pane = launch(DIRECT_ANTHROPIC, width=120)
    wait_values(pane, "anthropic", ["80%", "60%"])
    pane.resize(25, 30)
    pane.wait_for(COMPACT_ROW, timeout_s=SETTLE_S)
    time.sleep(FAST_POLL_MS / 1000 * 2)
    rows = pane.rows()
    assert all(len(row) <= 25 for row in rows)
    quota_rows = [row for row in rows if row.lstrip().startswith("Left:")]
    assert len(quota_rows) == 1, rows
    for fragment in ("OAI", "7d", "Anth"):
        holders = [row for row in rows if fragment in row]
        assert all(row in quota_rows for row in holders), f"'{fragment}' wrapped onto its own row: {rows}"
    pane.resize(120, 40)
    pane.wait_for(FULL_ROW, timeout_s=SETTLE_S)
    wait_values(pane, "openai-codex", ["70%", "50%"])


def test_absent_router_hides_the_row(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """With no router RPC listener there is no quota row, and the stats line is untouched."""
    install_usage_fixture(sandbox)
    pane = tui(
        script(), model=DIRECT_ANTHROPIC, env=fixture_env(None, FAST_TIMERS), wait_pattern="claude-haiku-4-5"
    )
    time.sleep(FAST_POLL_MS / 1000 * 4)
    assert parse_quota_row(pane.capture()) is None
    assert "ctx" in pane.capture()


@pytest.mark.slow
def test_real_poll_interval_is_sixty_seconds(launch: Callable[..., TmuxPane], usage: UsageFixture) -> None:
    """Real time, no scaling: the second request lands about `POLL_MS` after the first."""
    usage.set(anthropic=(10, 10), codex=(10, 10))
    pane = launch(DIRECT_ANTHROPIC, fast=False)
    pane.wait_for(ANY_ROW, timeout_s=SETTLE_S)
    deadline = time.monotonic() + POLL_MS / 1000 + 20
    while len(usage.requests()) < 2 and time.monotonic() < deadline:
        time.sleep(1)
    requests = usage.requests()
    assert len(requests) >= 2, "no second poll"
    gap_s = (requests[1]["t"] - requests[0]["t"]) / 1000
    assert POLL_MS / 1000 - 2 <= gap_s <= POLL_MS / 1000 + 5
