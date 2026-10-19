"""Stack-only Plan/diff interaction and cross-process monitor orphan sweeping.

Package-native terminal scenarios own diff layout, navigation, errors and read-only checks.

References:
- https://github.com/nredd/pi-harness/tree/main/packages/session-kit/test/scenarios
"""

from __future__ import annotations

import json
import os
import random
import re
import signal
import subprocess
import time
import unicodedata
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.paths import GIT_BIN
from harness.quota import FAST_TIMERS, USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture
from harness.session_kit import kit_args

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

STATUS = "STATUS-LINE-OK"
TITLE = re.compile(r"^ /diff \S+\s+\d+ files?\s+\+\d+ -\d+")
POSITION = re.compile(r"(\d+)/(\d+)\s+(\d+)-(\d+)/(\d+)\s*$")
GIT = [GIT_BIN, "-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false"]
LONG_LINE = "wide_" + "0123456789" * 50
WIDE_LINE = "漢字かな交じり文" * 12
LONG_DIR = "docs/a/really/deeply/nested/directory/structure/that/goes/on"


def git(repo: Path, *args: str) -> None:
    """Run git in `repo`, failing the test on a non-zero exit.

    Parameters:
        repo (Path): working tree.
        *args (str): git arguments.
    """
    subprocess.check_call([*GIT, "-C", str(repo), *args], stdout=subprocess.DEVNULL)


def make_repo(repo: Path) -> None:
    """Create a repo with one commit and five changed paths of every status.

    The five: modified (many hunks, an overlong line, a tab, wide characters), staged add, worktree
    delete, a file with a very long path, and an untracked file. Counts are asserted via the title.

    Parameters:
        repo (Path): directory to initialise (the pane's cwd).
    """
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q")
    (repo / "app.py").write_text("".join(f"line {i}\n" for i in range(1, 301)))
    (repo / "gone.txt").write_text("to be deleted\n" * 30)
    (repo / LONG_DIR).mkdir(parents=True)
    (repo / LONG_DIR / "file_with_a_rather_long_name.txt").write_text("old\n" * 5)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    lines = [f"line {i}\n" for i in range(1, 301)]
    for i in range(10, 300, 25):
        lines[i] = f"changed {i}\t{WIDE_LINE if i % 50 == 10 else 'tab'}\n"
    lines.append(f"{LONG_LINE}\n")
    (repo / "app.py").write_text("".join(lines))
    (repo / "staged.py").write_text("print('staged')\n" * 20)
    git(repo, "add", "staged.py")
    (repo / "gone.txt").unlink()
    (repo / LONG_DIR / "file_with_a_rather_long_name.txt").write_text("new\n" * 5)
    (repo / "untracked.md").write_text("# untracked\n" + LONG_LINE + "\n")


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
def launch(tui: Callable[..., TmuxPane], sandbox: Sandbox, usage: UsageFixture) -> Callable[..., TmuxPane]:
    """A launcher for panes with the kit and the status fixture, pidfile root inside the sandbox.

    Parameters:
        tui (Callable[..., TmuxPane]): shared pane launcher (kills panes at teardown).
        sandbox (Sandbox): sandbox the panes run in.
        usage (UsageFixture): status fixture.

    Returns:
        Callable[..., TmuxPane]: `start(width=, height=, steps=)`.
    """
    (sandbox.root / "tmp").mkdir(exist_ok=True)

    def start(
        *, width: int = 120, height: int | None = None, steps: list[dict[str, Any]] | None = None
    ) -> TmuxPane:
        """Launch one pane and wait for its status row.

        Parameters:
            width (int): pane columns.
            height (int | None): pane rows; defaults by width.
            steps (list[dict[str, Any]] | None): faux steps.

        Returns:
            TmuxPane: pane showing the first frame.
        """
        return tui(
            {"providers": {"faux": {"models": ["main"], "steps": steps or []}}},
            width=width,
            height=height or (60 if width == 320 else 40),
            extra_args=["-e", str(USAGE_FIXTURE_EXTENSION), *kit_args(sandbox)],
            env=fixture_env(usage, FAST_TIMERS) | {"TMPDIR": str(sandbox.root / "tmp")},
            wait_pattern=STATUS,
        )

    return start


@pytest.fixture
def dirty_repo(sandbox: Sandbox) -> Path:
    """The pane cwd as a repo with five changed paths.

    Parameters:
        sandbox (Sandbox): sandbox whose workdir becomes the repo.

    Returns:
        Path: the repo.
    """
    make_repo(sandbox.workdir)
    return sandbox.workdir


def open_diff(pane: TmuxPane) -> None:
    """Run `/diff` and wait for the overlay title.

    Parameters:
        pane (TmuxPane): running pane.
    """
    submit(pane, "/diff")
    pane.wait_for(r"^ /diff \S+\s+\d+ files?", timeout_s=20)


def check_layout(pane: TmuxPane) -> None:
    """Assert the overlay is structurally sound at the pane's size.

    Parameters:
        pane (TmuxPane): pane showing the overlay.
    """
    time.sleep(0.4)
    rows = pane.rows()[: pane.height]
    shown = "\n".join(rows)
    assert len(rows) == pane.height, shown
    assert TITLE.match(rows[0]), f"title not on row 0 (wrapped?)\n{shown}"
    assert "5 files" in rows[0], rows[0]
    wide = [
        (i, sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in row))
        for i, row in enumerate(rows)
        if sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in row) > pane.width
    ]
    assert not wide, f"rows wider than {pane.width}: {wide}\n{shown}"
    assert POSITION.search(rows[-1]), f"help row not last\n{shown}"
    assert "q" in rows[-1], f"help row not last\n{shown}"
    if pane.width >= 24:
        columns = {i: r.index("│") for i, r in enumerate(rows[1:-1], 1) if "│" in r}
        assert len(columns) == len(rows) - 2, f"separator missing on some body rows\n{shown}"
        assert len(set(columns.values())) == 1, f"separator column drifts: {columns}\n{shown}"
    assert STATUS not in shown, "overlay should cover the footer while open"


def test_diff_is_allowed_in_plan_mode(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """`/diff` is a command, not a tool, so Plan mode does not stop it.

    Parameters:
        launch (Callable[..., TmuxPane]): pane launcher with the kit and status fixture.
        dirty_repo (Path): pane cwd seeded with five changed paths.
    """
    pane = launch(width=120)
    submit(pane, "/plan start")
    pane.wait_for(r"(?i)plan", timeout_s=15)
    open_diff(pane)
    check_layout(pane)
    pane.send_keys("q")
    pane.wait_for(STATUS, timeout_s=10)
    assert not re.search(r"^ /diff \S+\s+\d+ files?", pane.capture(), re.MULTILINE)


def pid_of(pane: TmuxPane) -> int:
    """Process id of the program running in a pane (`exec` replaced the wrapper shell).

    Parameters:
        pane (TmuxPane): running pane.

    Returns:
        int: pid of pi.
    """
    return int(pane._tmux("display-message", "-p", "-t", pane.name, "#{pane_pid}").strip())


def ps_lines(tag: int) -> list[str]:
    """Process lines carrying `sleep <tag>`.

    Parameters:
        tag (int): unique sleep duration.

    Returns:
        list[str]: `ps` lines.
    """
    out = subprocess.run(
        ["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True
    ).stdout
    return [line.strip() for line in out.splitlines() if f"sleep {tag}" in line]


def wait_until(check: Callable[[], bool], what: str, timeout_s: float = 20.0) -> None:
    """Poll until `check()` holds.

    Parameters:
        check (Callable[[], bool]): condition.
        what (str): failure description.
        timeout_s (float): give up after this long.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.2)
    pytest.fail(f"timed out waiting for: {what}")


def monitor_steps(name: str, tag: int) -> list[dict[str, Any]]:
    """Faux steps: promote the deferred monitor tools, start one passive monitor, say `STARTED <name>`.

    Parameters:
        name (str): monitor name.
        tag (int): unique sleep duration.

    Returns:
        list[dict[str, Any]]: faux steps.
    """
    search = {"name": "search_tools", "args": {"query": "background monitor process watcher", "kind": "tool"}}
    begin = {"name": "monitor_start", "args": {"argv": ["/bin/sh", "-c", f"/bin/sleep {tag}"], "name": name}}
    return [{"tools": [search]}, {"tools": [begin]}, {"text": f"STARTED {name}"}]


def test_next_session_sweeps_only_dead_owners(launch: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """SIGKILL leaves A's child and pidfile; a new session reaps them and leaves live B's alone.

    Parameters:
        launch (Callable[..., TmuxPane]): pane launcher sharing the sandbox pidfile root.
        sandbox (Sandbox): sandbox containing per-session monitor pidfiles.
    """
    root = sandbox.root / "tmp"
    tag_a, tag_b = (900_000_000 + random.randint(0, 99_999) for _ in range(2))
    try:
        pane_a = launch(steps=monitor_steps("alpha", tag_a))
        submit(pane_a, "go")
        pane_a.wait_for(r"STARTED alpha", timeout_s=30)
        pane_b = launch(steps=monitor_steps("beta", tag_b))
        submit(pane_b, "go")
        pane_b.wait_for(r"STARTED beta", timeout_s=30)
        files = sorted(root.glob("pi-monitors-*/*/*.json"))
        assert len(files) == 2, files
        records = {json.loads(f.read_text())["name"]: (f, json.loads(f.read_text())) for f in files}
        owner_a = pid_of(pane_a)
        assert records["alpha"][1]["ownerPid"] == owner_a
        assert records["alpha"][0].parent != records["beta"][0].parent, "one directory per session"

        os.kill(owner_a, signal.SIGKILL)
        wait_until(lambda: not pane_a.is_alive(), "pane A to die")
        assert ps_lines(tag_a), "SIGKILL cannot be handled: A's child must be orphaned"
        assert records["alpha"][0].exists(), "A's pidfile must survive SIGKILL"

        pane_c = launch()
        wait_until(lambda: not ps_lines(tag_a), "the sweep to kill A's orphan")
        wait_until(lambda: not records["alpha"][0].exists(), "the sweep to remove A's pidfile")
        assert ps_lines(tag_b), "a live session's monitor must never be swept"
        assert records["beta"][0].exists(), "a live owner's pidfile must stay"
        assert pane_b.is_alive()
        submit(pane_b, "/monitor")
        pane_b.wait_for(r'm1 "beta" running', timeout_s=10)
        submit(pane_c, "/monitor")
        pane_c.wait_for(r"no monitors", timeout_s=10)
        launch()
        time.sleep(2)
        assert ps_lines(tag_b)
        assert records["beta"][0].exists()
    finally:
        for tag in (tag_a, tag_b):
            subprocess.run(["/usr/bin/pkill", "-f", f"/bin/sleep {tag}"], check=False)
