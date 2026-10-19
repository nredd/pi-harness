"""One real SIGWINCH seam with an explicit test-scoped local preset source.

The live footer remains the formatting-identical dotfiles copy. Preset adoption is
deferred to profiles (#21); adding it here does not alter the personal stack.

References:
- https://github.com/nredd/pi-harness/blob/main/packages/preset/extensions/expanded-footer.ts
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from typing import TYPE_CHECKING

import pytest

from harness.paths import REPO_ROOT, pi_command
from harness.quota import USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.sessions import write_session

if TYPE_CHECKING:
    from collections.abc import Callable

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
STATUS = "STATUS-LINE-OK"


def assert_footer(pane: TmuxPane, width: int) -> None:
    """Wait for exactly one consecutive four-row footer in the new tier, with no stale rows.

    Parameters:
        pane (TmuxPane): actual terminal process.
        width (int): new OS-level terminal width.

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
        if (
            len(stats) == len(quota) == len(status) == 1
            and quota[0] == stats[0] + 1
            and status[0] == stats[0] + 2
        ):
            footer = rows[stats[0] - 1 : status[0] + 1]
            pattern = COMPACT_STATS if width == 60 else FULL_STATS
            if len(footer) == 4 and pattern.match(rows[stats[0]]) and all(len(row) <= width for row in rows):
                return
        time.sleep(0.05)
    raise AssertionError(f"Footer did not repaint cleanly at {width}:\n{screen}")


def test_resize_transitions_leave_no_stale_rows(sandbox: Sandbox, tui: Callable[..., TmuxPane]) -> None:
    """120 -> 60 -> 320 -> 120 preserves one stats/quota/status row without timer scaling.

    Parameters:
        sandbox (Sandbox): private installed stack with a test-scoped preset.
        tui (Callable[..., TmuxPane]): actual terminal launcher for that sandbox.
    """
    # Install only into this test's writable copy. Keep resolved sources after Pi's
    # installer saves cwd-relative paths, and avoid loading the local preset twice.
    source = str(REPO_ROOT.parent / "packages/preset")
    packages = sandbox.settings()["packages"]
    subprocess.check_output(
        [*pi_command(), "install", source],
        cwd=sandbox.workdir,
        env=sandbox.env({"PI_OFFLINE": "0"}, installing=True),
        text=True,
        stderr=subprocess.STDOUT,
        timeout=600,
    )
    sandbox.patch_json("settings.json", {"packages": packages if source in packages else [*packages, source]})
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
    assert_footer(pane, 120)
    for width, height in ((60, 24), (320, 60), (120, 40)):
        pane.resize(width, height)
        assert_footer(pane, width)
