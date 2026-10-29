"""One real SIGWINCH seam over the preset already installed by the supplied stack.

Personal exercises its exact published footer-only pin; local exercises the full local
preset. Never add a local preset to personal or silently replace its published footer.

References:
- https://github.com/nredd/pi-harness/blob/main/packages/preset/extensions/expanded-footer.ts
"""

from __future__ import annotations

import json
import re
import time
from typing import TYPE_CHECKING

import pytest

from harness.quota import USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.sessions import write_session
from harness.stack import find_package

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = [pytest.mark.stack, pytest.mark.tui]
STATS = re.compile(r"\bhit \d+\.\d%|\bCH\d+\.\d%")
FULL_STATS = re.compile(
    r"^\s*in \S+ out \S+ (?:read \S+ )?(?:write \S+ )?"
    r"hit (?P<rate>\d+\.\d)%(?P<marker> (?:warm|cold))(?P<cause> \S+)? "
    r"cost \$\S+ ctx \S+/\S+ \(auto\)(?:\s+.*)?$"
)
COMPACT_STATS = re.compile(
    r"^\s*↑\S+ ↓\S+ (?:R\S+ )?(?:W\S+ )?"
    r"CH(?P<rate>\d+\.\d)%(?P<marker> [wc])(?P<cause> \S+)?\s+\$\S+\s+\S+/\S+ \(auto\)"
)
QUOTA = re.compile(r"^\s*(?:Quota left:|Left:)")
# Narrow widths wrap the quota by provider: the lead row is followed by one `OAI ...` row.
QUOTA_WRAPPED = re.compile(r"^\s*(?:OpenAI|OAI) ")
STATUS = "STATUS-LINE-OK"
# Reset suffix: full `(resets ..)` or compact ` @..`.
RESET_SUFFIX = re.compile(r"\(resets [^)]+\)| @\S+")
OPENAI_FIVE_HOUR = re.compile(r"\b(?:OpenAI|OAI) 5h\b")


def preset_shows_resets(preset: Path) -> bool:
    """Whether the installed preset renders reset times (and so hides the OpenAI 5h cell).

    The personal stack installs the PUBLISHED `@nredd/pi-preset`, which predates the reset-time
    footer until a release carrying it is pinned; the local stack installs this workspace's preset.
    The marker is the exported `formatResetAt` of the installed `lib/footer-quota.ts`.

    Parameters:
        preset (Path): installed `pi-preset` package directory.

    Returns:
        bool: True when the installed footer is the reset-time one.
    """
    return "formatResetAt" in (preset / "lib" / "footer-quota.ts").read_text()


def assert_footer(pane: TmuxPane, width: int, *, resets: bool) -> None:
    """Wait for exactly one consecutive footer in the new tier, with no stale rows.

    The footer is four rows, or five when the quota wraps by provider at narrow widths. With a
    reset-time footer the 60-column quota wraps and carries reset suffixes, and never an
    OpenAI 5h cell; a pre-reset published footer stays on one row
    with no suffixes (its `OAI 5h` cell is not asserted either way).

    Parameters:
        pane (TmuxPane): actual terminal process.
        width (int): new OS-level terminal width.
        resets (bool): whether the installed preset is the reset-time footer.

    Raises:
        AssertionError: the full pane and footer never settle into the expected layout.
    """
    deadline = time.monotonic() + 20
    screen = ""
    while time.monotonic() < deadline:
        screen = pane.capture()
        rows = screen.splitlines()
        stats = [index for index, row in enumerate(rows) if STATS.search(row)]
        quota = [index for index, row in enumerate(rows) if QUOTA.search(row)]
        status = [index for index, row in enumerate(rows) if STATUS in row]
        wrapped = [index for index, row in enumerate(rows) if QUOTA_WRAPPED.search(row)]
        if len(stats) == len(quota) == len(status) == 1 and len(wrapped) <= 1:
            # Quota rows: the lead row, plus one provider row directly below it when wrapped.
            quota_rows = 1 + len(wrapped)
            # Only the 60-column tier is too narrow for one quota row (reset suffixes make it ~72 wide).
            if quota_rows != (2 if width == 60 and resets else 1):
                time.sleep(0.05)
                continue
            text = "\n".join(rows[quota[0] : quota[0] + quota_rows])
            # Three windows are shown (Anthropic 5h and weekly, OpenAI weekly): one reset each, or none.
            if len(RESET_SUFFIX.findall(text)) != (3 if resets else 0):
                time.sleep(0.05)
                continue
            # The published pre-reset footer still renders `OAI 5h`; only the reset-time footer is held to it.
            if resets and OPENAI_FIVE_HOUR.search(text):
                time.sleep(0.05)
                continue
            adjacent = not wrapped or wrapped[0] == quota[0] + 1
            if adjacent and quota[0] == stats[0] + 1 and status[0] == stats[0] + 1 + quota_rows:
                footer = rows[stats[0] - 1 : status[0] + 1]
                pattern = COMPACT_STATS if width == 60 else FULL_STATS
                if (
                    len(footer) == 3 + quota_rows
                    and pattern.match(rows[stats[0]])
                    and all(len(row) <= width for row in rows)
                ):
                    return
        time.sleep(0.05)
    raise AssertionError(f"Footer did not repaint cleanly at {width}:\n{screen}")


def test_resize_transitions_leave_no_stale_rows(sandbox: Sandbox, tui: Callable[..., TmuxPane]) -> None:
    """120 -> 60 -> 320 -> 120 preserves one stats/quota/status row without timer scaling.

    Parameters:
        sandbox (Sandbox): private installed stack with its declared preset selection.
        tui (Callable[..., TmuxPane]): actual terminal launcher for that sandbox.
    """
    # Require the declared installation. A missing unpublished pin must fail, not be
    # hidden behind a test-scoped local copy that bypasses the production filters.
    preset = find_package("pi-preset", sandbox.settings()["packages"], sandbox.agent_dir)
    resets = preset_shows_resets(preset)
    # The workspace preset IS this change: a local stack on the old footer is a regression, not a baseline.
    if (sandbox.agent_dir / "stack-name").read_text() == "local":
        assert resets, "Local stack's preset lost the reset-time footer (`formatResetAt`)"
    session = sandbox.root / "footer.jsonl"
    write_session(session, sandbox.workdir, 8)
    entries = [json.loads(line) for line in session.read_text().splitlines()]
    for entry in entries:
        if entry.get("message", {}).get("role") == "assistant":
            turn_usage = entry["message"]["usage"]
            turn_usage["cacheRead"] = 3000
            turn_usage["totalTokens"] += 3000
            # The frozen footer fixture has nonzero cost; the generic transcript generator
            # does not. Preserve the mandatory cost segment in both tier assertions.
            turn_usage["cost"]["cacheRead"] = turn_usage["cost"]["total"] = 0.004
    session.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    usage = install_usage_fixture(sandbox)
    usage.set(anthropic=(20, 40), codex=(30, 50))
    pane = tui(
        {"providers": {"faux": {"models": ["main"], "steps": []}}},
        width=120,
        height=40,
        extra_args=["-e", str(USAGE_FIXTURE_EXTENSION), "--session", str(session)],
        env=fixture_env(usage),
        wait_pattern=STATUS,
    )
    assert_footer(pane, 120, resets=resets)
    for width, height in ((60, 24), (320, 60), (120, 40)):
        pane.resize(width, height)
        assert_footer(pane, width, resets=resets)
