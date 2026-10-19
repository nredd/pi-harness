"""Footer prompt-cache marker: warm/cold, cause tags, tiers, widths, resize, long names, tui modes.

Pi resumes a generated session whose assistant turns carry `cacheRead` usage and chosen timestamps, so
warm/cold and the cause tag are deterministic without a fake clock (`Date.now()` is the only input).
The TTL is the model's declared `promptCache.short`, else 300 s; the expiry test overrides it in
`models.json`.
The usage fixture supplies the quota row and the status row, so the full footer is four rows:
cwd/branch/name, stats, quota, status.

References:
- Logic and unit tests: `lib/footer-cache.ts`, `tests/footer-cache.test.mjs` in the chezmoi source
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import re
import subprocess
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import launch_tui
from harness.quota import FAST_TIMERS, USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.sessions import EPOCH, SESSION_ID, SESSION_VERSION

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

STATUS = "STATUS-LINE-OK"
QUOTA = r"^\s*(Quota left:|Left:)"
# Stats row: optional token counters, then `hit`/`CH`, marker, cost, context, model on the right.
STATS_ANCHOR = re.compile(r"\bhit \d+\.\d%|\bCH\d+\.\d%")
FULL_STATS = re.compile(
    r"^\s*in \S+ out \S+ (?:read \S+ )?(?:write \S+ )?"
    r"hit (?P<rate>\d+\.\d)%(?P<marker> (?:warm|cold))(?P<cause> \S+)? "
    r"cost \$\S+ ctx \S+/\S+ \(auto\)(?:\s+.*)?$"
)
COMPACT_STATS = re.compile(
    r"^\s*↑\S+ ↓\S+ (?:R\S+ )?(?:W\S+ )?"
    r"CH(?P<rate>\d+\.\d)%(?P<marker> [wc])(?P<cause> \S+)?\s+\$\S+\s+\S+/\S+ \(auto\)"
)
WIDTHS = [60, 80, 120, 160, 200, 240, 320]
TALL = {320: 60}
SETTLE_S = 20.0
FOOTER_ROWS = 4
# Expiry test: the model declares a TTL and the last response expires `EXPIRY_LEAD_S` after the session
# file is written, so the initial `warm` check has that long for startup instead of racing a few seconds.
EXPIRY_TTL_S = 120
EXPIRY_LEAD_S = 45
GENERIC_STATS = r"CH\d|hit \d"


@dataclasses.dataclass(frozen=True)
class Turn:
    """One generated assistant turn: age, prompt shape, and model."""

    age_s: float
    cache_read: int
    input: int
    cache_write: int = 0
    model: str = "main"


# `age_s` is seconds before the session is written; the TTL is 300.
WARM = [Turn(60, 0, 100, 3000), Turn(5, 3000, 100)]
COLD = [Turn(3700, 0, 100, 3000), Turn(3600, 3000, 100)]
# Healthy turn, then a drop while the previous turn is still young: `prefix-changed`, warm.
DROP_WARM = [Turn(60, 3000, 100), Turn(5, 0, 3100)]
# Same drop with the last response past the TTL, the widest marker (`cold prefix-changed`).
DROP_COLD = [Turn(3700, 3000, 100), Turn(3600, 0, 3100)]
# More than a TTL between the two turns: `idle>ttl`, and the latest turn is fresh so `warm`.
DROP_IDLE = [Turn(2000, 3000, 100), Turn(5, 0, 3100)]
DROP_SWITCH = [Turn(60, 3000, 100), Turn(5, 0, 3100, model="alt")]


def write_cache_session(
    path: Path, cwd: Path, turns: list[Turn], *, name: str | None = None, compaction_before_last: bool = False
) -> None:
    """Write a session of assistant turns with cache usage.

    Parameters:
        path (Path): destination `.jsonl`.
        cwd (Path): working directory recorded in the header.
        turns (list[Turn]): oldest first; each follows a user message.
        name (str | None): session name entry.
        compaction_before_last (bool): insert a compaction entry before the last turn.
    """
    now = time.time()
    entries: list[dict[str, Any]] = [
        {
            "type": "session",
            "version": SESSION_VERSION,
            "id": SESSION_ID,
            "timestamp": EPOCH.isoformat().replace("+00:00", "Z"),
            "cwd": str(cwd),
        }
    ]
    parent: str | None = None

    def add(body: dict[str, Any], at_s: float) -> None:
        """Append one session entry chained to the previous one.

        Parameters:
            body (dict[str, Any]): entry fields (`type` and payload).
            at_s (float): entry timestamp, epoch seconds.
        """
        nonlocal parent
        entry_id = f"{len(entries):08x}"
        stamp = datetime.fromtimestamp(at_s, tz=UTC).isoformat().replace("+00:00", "Z")
        entries.append({"id": entry_id, "parentId": parent, "timestamp": stamp, **body})
        parent = entry_id

    if name:
        add({"type": "session_info", "name": name}, now - 7200)
    for index, turn in enumerate(turns):
        at = now - turn.age_s
        if compaction_before_last and index == len(turns) - 1:
            add(
                {
                    "type": "compaction",
                    "summary": "s",
                    "firstKeptEntryId": entries[1]["id"],
                    "tokensBefore": 1,
                },
                at - 1,
            )
        user = {
            "role": "user",
            "content": [{"type": "text", "text": f"q{index}"}],
            "timestamp": int((at - 1) * 1000),
        }
        add({"type": "message", "message": user}, at - 1)
        usage = {
            "input": turn.input,
            "output": 20,
            "cacheRead": turn.cache_read,
            "cacheWrite": turn.cache_write,
            "totalTokens": turn.input + turn.cache_read + turn.cache_write + 20,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.004},
        }
        reply = {
            "role": "assistant",
            "content": [{"type": "text", "text": f"reply {index}"}],
            "api": "faux-api",
            "provider": "faux",
            "model": turn.model,
            "usage": usage,
            "stopReason": "stop",
            "timestamp": int(at * 1000),
        }
        add({"type": "message", "message": reply}, at)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))


def script() -> dict[str, Any]:
    """Faux provider with two models so a model switch resolves.

    Returns:
        dict[str, Any]: script for `HARNESS_SCRIPT`.
    """
    return {"providers": {"faux": {"models": ["main", "alt"], "steps": []}}}


@pytest.fixture
def usage(sandbox: Sandbox) -> UsageFixture:
    """Usage fixture state for one sandbox (router stand-in, quota row and status row).

    Parameters:
        sandbox (Sandbox): sandbox the fixture is installed into.

    Returns:
        UsageFixture: state with quota values set.
    """
    state = install_usage_fixture(sandbox)
    state.set(anthropic=(20, 40), codex=(30, 50))
    return state


@pytest.fixture
def launch(
    tui: Callable[..., TmuxPane], sandbox: Sandbox, usage: UsageFixture
) -> Iterator[Callable[..., TmuxPane]]:
    """Yield a launcher that resumes a generated cache session at a given size.

    A launch with its own `box` bypasses the shared `tui` fixture, which is bound to the original
    sandbox's workdir, and is killed here at teardown.

    Parameters:
        tui (Callable[..., TmuxPane]): shared pane launcher, bound to `sandbox`.
        sandbox (Sandbox): default sandbox.
        usage (UsageFixture): quota and status fixture.

    Yields:
        Callable[..., TmuxPane]: `start`.
    """
    extra_panes: list[TmuxPane] = []

    def start(
        turns: list[Turn],
        *,
        width: int = 120,
        height: int | None = None,
        box: Sandbox | None = None,
        name: str | None = None,
        compaction: bool = False,
        ttl_s: int | None = None,
    ) -> TmuxPane:
        """Write the session and launch pi resuming it.

        Parameters:
            turns (list[Turn]): generated assistant turns, oldest first.
            width (int): pane columns.
            height (int | None): pane rows; defaults by width.
            box (Sandbox | None): sandbox to launch in (its `workdir` is the pane cwd); default `sandbox`.
            name (str | None): session name.
            compaction (bool): put a compaction entry before the last turn.
            ttl_s (int | None): declare this `promptCache.short` on the faux models.

        Returns:
            TmuxPane: pane showing the first footer frame.
        """
        target = box or sandbox
        session = sandbox.root / "cache-sessions" / "s.jsonl"
        write_cache_session(session, target.workdir, turns, name=name, compaction_before_last=compaction)
        if ttl_s is not None:
            overrides = {model: {"promptCache": {"short": ttl_s}} for model in ("main", "alt")}
            sandbox.patch_json("models.json", {"providers": {"faux": {"modelOverrides": overrides}}})
        launcher_args = ["-e", str(USAGE_FIXTURE_EXTENSION), "--session", str(session)]
        height = height or TALL.get(width, 40)
        env = fixture_env(usage, FAST_TIMERS)
        if box is None:
            return tui(
                script(), width=width, height=height, extra_args=launcher_args, env=env, wait_pattern=STATUS
            )
        pane = launch_tui(
            target,
            script(),
            name=f"long{len(extra_panes)}",
            width=width,
            height=height,
            extra_args=launcher_args,
            env=env,
            wait_pattern=STATUS,
        )
        extra_panes.append(pane)
        return pane

    yield start
    for pane in extra_panes:
        with contextlib.suppress(RuntimeError):
            pane.kill()


def footer(pane: TmuxPane) -> list[str]:
    """Return the footer rows: cwd line through the status row, located from the stats row.

    Parameters:
        pane (TmuxPane): running pane.

    Returns:
        list[str]: rows, the stats row at index 1.

    Raises:
        AssertionError: no stats row or no status row below it.
    """
    rows = pane.rows()
    stats = [i for i, row in enumerate(rows) if STATS_ANCHOR.search(row)]
    assert len(stats) == 1, f"expected one stats row, found {len(stats)}\n" + "\n".join(rows)
    status = [i for i, row in enumerate(rows) if STATUS in row and i > stats[0]]
    assert status, "no status row under the stats row\n" + "\n".join(rows)
    return rows[stats[0] - 1 : status[-1] + 1]


def wait_footer(pane: TmuxPane, *, rows: int = FOOTER_ROWS, timeout_s: float = SETTLE_S) -> list[str]:
    """Poll until the footer has `rows` rows including the quota row; return it.

    Parameters:
        pane (TmuxPane): running pane.
        rows (int): expected footer height.
        timeout_s (float): give up after this long.

    Returns:
        list[str]: the settled footer rows.

    Raises:
        Failed: the footer never reached `rows` rows with a quota row.
    """
    deadline = time.monotonic() + timeout_s
    last = ""
    while time.monotonic() < deadline:
        try:
            current = footer(pane)
        except AssertionError as error:
            last = str(error)
        else:
            if len(current) == rows and re.match(QUOTA, current[2]):
                return current
            last = "\n".join(current)
        time.sleep(0.2)
    pytest.fail(f"footer never reached {rows} rows with a quota row\n{last}\n{pane.capture()}")


def stats_match(row: str) -> tuple[str, re.Match[str]]:
    """Match a stats row against both tier shapes.

    Parameters:
        row (str): the stats row text.

    Returns:
        tuple[str, re.Match[str]]: tier name (`full` or `compact`) and its match.

    Raises:
        Failed: neither tier's shape fits.
    """
    for tier, pattern in (("full", FULL_STATS), ("compact", COMPACT_STATS)):
        match = pattern.match(row)
        if match:
            return tier, match
    pytest.fail(f"stats row matches neither tier: {row!r}")


def assert_layout(pane: TmuxPane, width: int, rows: list[str]) -> tuple[str, re.Match[str]]:
    """Assert the footer is `FOOTER_ROWS` clean rows within `width`.

    Parameters:
        pane (TmuxPane): running pane.
        width (int): pane columns.
        rows (list[str]): footer rows from `footer`.

    Returns:
        tuple[str, re.Match[str]]: the stats tier and match.

    Raises:
        AssertionError: wrong row count, an overwide row, or stats text on another row.
    """
    assert len(rows) == FOOTER_ROWS, rows
    assert all(len(row) <= width for row in pane.rows()), [r for r in pane.rows() if len(r) > width]
    assert re.match(QUOTA, rows[2]), rows
    assert STATUS in rows[3], rows
    assert not STATS_ANCHOR.search(rows[0]), rows
    assert not STATS_ANCHOR.search(rows[2]), rows
    return stats_match(rows[1])


COMPACT_CAUSE = {
    "idle>ttl": "idle",
    "model-switch": "model",
    "compaction": "compact",
    "prefix-changed": "prefix",
}


def compact_cause(cause: str | None, tier: str) -> str:
    """Return the cause tag as the given tier prints it.

    Parameters:
        cause (str | None): full cause name, or `None`.
        tier (str): `full` or `compact`.

    Returns:
        str: the printed tag, empty for none.
    """
    return (COMPACT_CAUSE[cause] if tier == "compact" else cause) if cause else ""


# Tier chosen by the full-fit rule (`full left + 2 + model <= width`); pinned from the fixed totals.
# Quota row full tier is a separate rule, so it may differ from the stats tier.
STATS_TIER = {60: "compact", 80: "compact", 120: "full", 160: "full", 200: "full", 240: "full", 320: "full"}


@pytest.mark.parametrize("width", WIDTHS)
@pytest.mark.parametrize(
    ("turns", "marker", "cause"),
    [(WARM, "warm", None), (DROP_COLD, "cold", "prefix-changed")],
    ids=["warm-healthy", "cold-drop"],
)
def test_width_matrix(
    launch: Callable[..., TmuxPane], width: int, turns: list[Turn], marker: str, cause: str | None
) -> None:
    """At every width: four rows, none wider than the pane, the right tier, marker in order, no overlap."""
    pane = launch(turns, width=width)
    rows = wait_footer(pane)
    tier, match = assert_layout(pane, width, rows)
    assert tier == STATS_TIER[width], rows[1]
    word = marker if tier == "full" else marker[0]
    assert match["marker"] == f" {word}", rows[1]
    assert (match["cause"] or "").strip() == compact_cause(cause, tier), rows[1]
    # The model name is the right-aligned tail; it must not have been mangled by the marker.
    if width >= 120:
        assert rows[1].rstrip().endswith("main"), rows[1]
    quota_full = rows[2].lstrip().startswith("Quota left:")
    assert quota_full == (width >= 80 and len(rows[2]) < width), rows[2]


@pytest.mark.parametrize(
    ("turns", "marker", "cause", "kwargs"),
    [
        (WARM, "warm", None, {}),
        (COLD, "cold", None, {}),
        (DROP_WARM, "warm", "prefix-changed", {}),
        (DROP_COLD, "cold", "prefix-changed", {}),
        (DROP_IDLE, "warm", "idle>ttl", {}),
        (DROP_SWITCH, "warm", "model-switch", {}),
        (DROP_WARM, "warm", "compaction", {"compaction": True}),
    ],
    ids=["warm", "cold", "drop-warm", "drop-cold", "idle", "model-switch", "compaction"],
)
def test_states_and_causes(
    launch: Callable[..., TmuxPane], turns: list[Turn], marker: str, cause: str | None, kwargs: dict[str, Any]
) -> None:
    """Each state shows its marker; only a drop after a healthy turn shows a cause tag."""
    pane = launch(turns, width=160, **kwargs)
    rows = wait_footer(pane)
    tier, match = assert_layout(pane, 160, rows)
    assert tier == "full"
    assert match["marker"] == f" {marker}", rows[1]
    assert (match["cause"] or "").strip() == (cause or ""), rows[1]
    if cause is None:
        assert float(match["rate"]) >= 50, rows[1]


def test_healthy_footer_is_unchanged_but_for_the_marker(launch: Callable[..., TmuxPane]) -> None:
    """Healthy: `hit 96.8% warm` and nothing else new; row count and quota row as before."""
    pane = launch(WARM, width=160)
    rows = wait_footer(pane)
    assert "hit 96.8% warm cost" in rows[1], rows[1]
    assert not re.search(r"idle>ttl|model-switch|compaction|prefix-changed", rows[1])


def test_warm_turns_cold_when_the_ttl_passes_while_idle(launch: Callable[..., TmuxPane]) -> None:
    """The marker flips by itself, with no input and no new event, once the declared TTL passes.

    The model declares `EXPIRY_TTL_S`; the last response expires `EXPIRY_LEAD_S` after the session is
    written, so startup has that whole budget before the `warm` check instead of a few seconds.
    """
    written = time.monotonic()
    turns = [Turn(EXPIRY_TTL_S, 0, 100, 3000), Turn(EXPIRY_TTL_S - EXPIRY_LEAD_S, 3000, 100)]
    pane = launch(turns, width=160, ttl_s=EXPIRY_TTL_S)
    rows = wait_footer(pane)
    startup_s = time.monotonic() - written
    assert startup_s < EXPIRY_LEAD_S - 5, (
        f"startup took {startup_s:.0f}s, no warm window left; raise `EXPIRY_LEAD_S`"
    )
    assert " warm " in rows[1], rows[1]
    pane.wait_for(r"hit \d+\.\d% cold ", timeout_s=EXPIRY_LEAD_S + 15)
    assert_layout(pane, 160, wait_footer(pane))


def test_no_usage_yet_shows_no_hit_segment(launch: Callable[..., TmuxPane]) -> None:
    """A session with no assistant turn has no `hit` and so no marker; the other rows stay."""
    pane = launch([], width=160)
    pane.wait_for(QUOTA, timeout_s=SETTLE_S)
    screen = pane.capture()
    assert not re.search(GENERIC_STATS, screen)
    assert "ctx " in screen
    assert STATUS in screen


def long_workdir(sandbox: Sandbox, *, branch: str) -> Sandbox:
    """Create a very deep cwd that is a git repo on a very long branch.

    Parameters:
        sandbox (Sandbox): sandbox to derive from.
        branch (str): branch to check out.

    Returns:
        Sandbox: a copy whose `workdir` is the deep repo.
    """
    deep = sandbox.workdir / "a-very-long-directory-name-that-keeps-going" / ("segment-" * 12) / "project"
    deep.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=deep, check=True)
    subprocess.run(["git", "checkout", "-q", "-b", branch], cwd=deep, check=True)
    return dataclasses.replace(sandbox, workdir=deep)


@pytest.mark.parametrize("width", [60, 120, 320])
def test_long_cwd_branch_and_session_name(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, width: int
) -> None:
    """A long live cwd, git branch and session name truncate the first row only, never wrap.

    The pane really runs in the deep repo, so the footer's own cwd and branch lookup is exercised.
    """
    branch = "feature/" + "very-long-branch-name-" * 5
    box = long_workdir(sandbox, branch=branch)
    pane = launch(DROP_COLD, width=width, box=box, name="named-session-for-the-footer")
    rows = wait_footer(pane)
    tier, match = assert_layout(pane, width, rows)
    assert tier == STATS_TIER[width]
    assert (match["cause"] or "").strip() == compact_cause("prefix-changed", tier)
    # Path and branch text are on the first row alone: nothing wrapped onto the other rows or above.
    screen = pane.rows()
    cwd_head = str(box.workdir)[:16]
    holders = [row for row in screen if cwd_head in row or "very-long-branch" in row]
    assert holders == [rows[0]], holders
    if width == 320:
        assert "(feature/" in rows[0], rows[0]
    else:
        assert rows[0].rstrip().endswith("..."), rows[0]


def test_session_name_shows_when_it_fits(launch: Callable[..., TmuxPane]) -> None:
    """A short session name sits on the first row beside the cwd and does not disturb the stats row."""
    pane = launch(WARM, width=160, name="my-session")
    rows = wait_footer(pane)
    assert_layout(pane, 160, rows)
    assert rows[0].rstrip().endswith("my-session"), rows[0]


@pytest.mark.parametrize("mode", ["fullscreen", "regular"])
def test_tui_modes_keep_the_footer_intact(
    launch: Callable[..., TmuxPane], sandbox: Sandbox, mode: str
) -> None:
    """The footer renders the same four rows in fullscreen (the configured default) and regular mode."""
    sandbox.patch_json("settings.json", {"tuiMode": mode})
    pane = launch(DROP_IDLE, width=160)
    rows = wait_footer(pane)
    tier, match = assert_layout(pane, 160, rows)
    assert (tier, match["marker"], match["cause"]) == ("full", " warm", " idle>ttl")
