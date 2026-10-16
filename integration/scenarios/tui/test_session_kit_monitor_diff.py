"""pi-session-kit `/diff` overlay across widths, and orphaned-monitor sweeping between two live panes.

Real pi in tmux, the kit selected from sandbox package settings, the usage fixture supplying a status row so
"footer intact" is checkable (cwd row, stats row, status row). The `/diff` overlay covers the whole
screen, so the checks are structural: title on row 0, help row on the last row, the file-list separator
in one column on every body row, no row wider than the pane (display cells, CJK counted double). A
line that overflowed would wrap and push the title off the top. The sweep scenario SIGKILLs one pi
and starts a third; only the dead owner's children may die, a second live session's must not.

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
- `src/diff/component.ts`, `src/diff/view.ts`: layout and keys; `src/monitor/pidfiles.ts`: orphan sweep
- `scenarios/tui/test_footer_cache.py`: width matrix and footer helpers this follows
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
STATS = re.compile(r"\bctx \d+(\.\d+)?%/\S+ \(auto\)")
WIDTHS = [60, 80, 120, 160, 200, 240, 320]
TALL = {320: 60}
TITLE = re.compile(r"^ /diff \S+\s+\d+ files?\s+\+\d+ -\d+")
POSITION = re.compile(r"(\d+)/(\d+)\s+(\d+)-(\d+)/(\d+)\s*$")
SEPARATOR = "│"
GIT = [GIT_BIN, "-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false"]
# 500 columns on one added line, a tab, a wide-character line and a lone surrogate-free emoji.
LONG_LINE = "wide_" + "0123456789" * 50
WIDE_LINE = "漢字かな交じり文" * 12
EXPECTED_FILES = 5
LONG_DIR = "docs/a/really/deeply/nested/directory/structure/that/goes/on"


def git(repo: Path, *args: str) -> None:
    """Run git in `repo`, failing the test on a non-zero exit.

    Parameters:
        repo (Path): working tree.
        *args (str): git arguments.
    """
    subprocess.check_call([*GIT, "-C", str(repo), *args], stdout=subprocess.DEVNULL)


def make_repo(repo: Path, *, dirty: bool) -> None:
    """Create a repo with one commit and, when `dirty`, five changed paths of every status.

    The five: modified (many hunks, an overlong line, a tab, wide characters), staged add, worktree
    delete, a file with a very long path, and an untracked file. Counts are asserted via the title.

    Parameters:
        repo (Path): directory to initialise (the pane's cwd).
        dirty (bool): leave uncommitted changes.
    """
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "-q")
    (repo / "app.py").write_text("".join(f"line {i}\n" for i in range(1, 301)))
    (repo / "gone.txt").write_text("to be deleted\n" * 30)
    (repo / LONG_DIR).mkdir(parents=True)
    (repo / LONG_DIR / "file_with_a_rather_long_name.txt").write_text("old\n" * 5)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    if not dirty:
        return
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


def cells(text: str) -> int:
    """Display width of plain text: wide and fullwidth characters take two cells.

    Parameters:
        text (str): one screen row.

    Returns:
        int: terminal cells.
    """
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def script(steps: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Faux provider script.

    Parameters:
        steps (list[dict[str, Any]] | None): parent steps.

    Returns:
        dict[str, Any]: script for `HARNESS_SCRIPT`.
    """
    return {"providers": {"faux": {"models": ["main"], "steps": steps or []}}}


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
        env = fixture_env(usage, FAST_TIMERS) | {"TMPDIR": str(sandbox.root / "tmp")}
        return tui(
            script(steps),
            width=width,
            height=height or TALL.get(width, 40),
            extra_args=["-e", str(USAGE_FIXTURE_EXTENSION), *kit_args(sandbox)],
            env=env,
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
    make_repo(sandbox.workdir, dirty=True)
    return sandbox.workdir


def screen(pane: TmuxPane) -> list[str]:
    """The visible rows, exactly `height` of them (a capture ends with one empty extra line).

    Parameters:
        pane (TmuxPane): running pane.

    Returns:
        list[str]: rows, trailing spaces removed.
    """
    return pane.rows()[: pane.height]


def open_diff(pane: TmuxPane, command: str = "/diff") -> list[str]:
    """Run a diff command and wait for the overlay title.

    Parameters:
        pane (TmuxPane): running pane.
        command (str): slash command.

    Returns:
        list[str]: screen rows once the overlay is up.
    """
    submit(pane, command)
    pane.wait_for(r"^ /diff \S+\s+\d+ files?", timeout_s=20)
    return screen(pane)


def check_layout(pane: TmuxPane, files: int = EXPECTED_FILES) -> list[str]:
    """Assert the overlay is structurally sound at the pane's size and return its rows.

    Parameters:
        pane (TmuxPane): pane showing the overlay.
        files (int): expected file count in the title.

    Returns:
        list[str]: screen rows.
    """
    time.sleep(0.4)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert len(rows) == pane.height, shown
    assert TITLE.match(rows[0]), f"title not on row 0 (wrapped?)\n{shown}"
    assert f"{files} files" in rows[0], rows[0]
    wide = [(i, cells(r)) for i, r in enumerate(rows) if cells(r) > pane.width]
    assert not wide, f"rows wider than {pane.width}: {wide}\n{shown}"
    help_row = rows[-1]
    assert POSITION.search(help_row), f"help row not last\n{shown}"
    assert "q" in help_row, f"help row not last\n{shown}"
    if pane.width >= 24:
        columns = {i: r.index(SEPARATOR) for i, r in enumerate(rows[1:-1], 1) if SEPARATOR in r}
        assert len(columns) == len(rows) - 2, f"separator missing on some body rows\n{shown}"
        assert len(set(columns.values())) == 1, f"separator column drifts: {columns}\n{shown}"
    assert STATUS not in shown, "overlay should cover the footer while open"
    return rows


def position(pane: TmuxPane) -> tuple[int, int, int, int, int]:
    """Parse the help row: selected file, file count, first and last visible patch line, patch length.

    Parameters:
        pane (TmuxPane): pane showing the overlay.

    Returns:
        tuple[int, int, int, int, int]: `(file, files, first, last, total)`.
    """
    match = POSITION.search(screen(pane)[-1])
    assert match, pane.capture()
    file, files, first, last, total = (int(g) for g in match.groups())
    return file, files, first, last, total


def wait_position(pane: TmuxPane, **want: int) -> tuple[int, int, int, int, int]:
    """Poll until the help row shows the wanted `file` and/or `first` values.

    Parameters:
        pane (TmuxPane): pane showing the overlay.
        **want (int): any of `file`, `first`.

    Returns:
        tuple[int, int, int, int, int]: the matching position.
    """
    deadline = time.monotonic() + 8
    current = position(pane)
    while time.monotonic() < deadline:
        current = position(pane)
        if all(current[{"file": 0, "first": 2}[k]] == v for k, v in want.items()):
            return current
        time.sleep(0.1)
    pytest.fail(f"position never became {want}, last {current}\n{pane.capture()}")


def assert_footer_intact(pane: TmuxPane) -> None:
    """Assert the overlay is gone and cwd, stats and status rows are drawn again.

    Parameters:
        pane (TmuxPane): pane after closing the overlay.
    """
    pane.wait_for(STATUS, timeout_s=10)
    rows = screen(pane)
    shown = "\n".join(rows)
    assert not TITLE.search(shown), shown
    assert not any(POSITION.search(r) for r in rows), shown
    stats = [i for i, r in enumerate(rows) if STATS.search(r)]
    assert len(stats) == 1, shown
    assert any(STATUS in r for r in rows[stats[0] + 1 :]), shown
    assert "/" in rows[stats[0] - 1], f"cwd row missing\n{shown}"


@pytest.mark.parametrize("width", WIDTHS)
def test_diff_overlay_layout_navigation_and_close(
    launch: Callable[..., TmuxPane], dirty_repo: Path, width: int
) -> None:
    """At every width the overlay fits, files and scroll navigate, `q` closes, the footer returns."""
    pane = launch(width=width)
    open_diff(pane)
    check_layout(pane)
    assert position(pane)[:2] == (1, EXPECTED_FILES)
    # file navigation: n walks every file (each one still fits), p walks back, clamped at both ends
    for expected in range(2, EXPECTED_FILES + 1):
        pane.send_keys("n")
        wait_position(pane, file=expected)
        check_layout(pane)
    pane.send_keys("n")
    time.sleep(0.3)
    assert position(pane)[0] == EXPECTED_FILES
    for expected in range(EXPECTED_FILES - 1, 0, -1):
        pane.send_keys("p")
        wait_position(pane, file=expected)
    pane.send_keys("p")
    time.sleep(0.3)
    assert position(pane)[0] == 1
    # scrolling: the first file in list order is the long one when sorted by path
    _, _, first, last, total = position(pane)
    assert first == 1, f"expected a scrollable patch, got {position(pane)}"
    assert total > last, f"expected a scrollable patch, got {position(pane)}"
    pane.send_keys("j")
    wait_position(pane, first=2)
    pane.send_keys("k")
    wait_position(pane, first=1)
    pane.send_keys("PageDown")
    _, _, paged, _, _ = wait_position(pane, first=last)
    assert paged == last > 1
    pane.send_keys("G")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and position(pane)[3] != total:
        time.sleep(0.1)
    assert position(pane)[3] == total, pane.capture()
    check_layout(pane)
    pane.send_keys("PageUp")
    assert position(pane)[2] < total
    pane.send_keys("g")
    wait_position(pane, first=1)
    check_layout(pane)
    pane.send_keys("q")
    assert_footer_intact(pane)


def test_diff_overlay_survives_resize(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """Resizing the terminal re-lays the overlay out at every width, up and down."""
    pane = launch(width=120)
    open_diff(pane)
    for width, height in [(60, 24), (320, 60), (80, 30), (240, 50), (60, 40)]:
        pane.resize(width, height)
        time.sleep(0.8)
        check_layout(pane)
    pane.send_keys("Escape")
    assert_footer_intact(pane)


def test_diff_lists_every_status_and_shortens_long_paths(
    launch: Callable[..., TmuxPane], dirty_repo: Path
) -> None:
    """Modified, added, deleted and untracked files each show their letter; long paths keep the file name."""
    pane = launch(width=80)
    open_diff(pane)
    shown = "\n".join(check_layout(pane))
    for letter, name in [("M", "app.py"), ("A", "staged.py"), ("D", "gone.txt"), ("?", "untracked.md")]:
        assert (
            re.search(rf"^\s*{re.escape(letter)} {re.escape(name)}", shown, re.MULTILINE)
            or f"{letter} {name}" in shown
        ), (
            letter,
            name,
            shown,
        )
    assert "file_with_a_rather_long_name.txt" in shown or "…" in shown, shown
    # untracked content is shown as an added patch
    for _ in range(EXPECTED_FILES - 1):
        pane.send_keys("n")
    wait_position(pane, file=EXPECTED_FILES)
    pane.wait_for(r"# untracked", timeout_s=5)
    pane.send_keys("q")
    assert_footer_intact(pane)


def test_diff_bad_ref_notifies_and_opens_nothing(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """An unknown ref is a notification; the editor and footer stay put, and a good ref still works."""
    pane = launch(width=120)
    submit(pane, "/diff no-such-ref-xyz")
    pane.wait_for(r"/diff: ", timeout_s=15)
    assert not re.search(r"^ /diff \S+\s+\d+ files?", pane.capture(), re.MULTILINE)
    assert_footer_intact(pane)
    open_diff(pane, "/diff HEAD")
    check_layout(pane)
    pane.send_keys("q")
    assert_footer_intact(pane)


def test_diff_with_too_many_args_is_usage(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """Two refs print usage and open nothing."""
    pane = launch(width=120)
    submit(pane, "/diff HEAD HEAD~1")
    pane.wait_for(r"usage: /diff \[ref\]", timeout_s=10)


def test_diff_with_no_changes_says_so(launch: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """A clean tree is a notification, not an empty overlay."""
    make_repo(sandbox.workdir, dirty=False)
    pane = launch(width=120)
    submit(pane, "/diff")
    pane.wait_for(r"no changes vs", timeout_s=15)
    assert not re.search(r"^ /diff \S+\s+\d+ files?", pane.capture(), re.MULTILINE)
    assert_footer_intact(pane)


def test_diff_outside_a_repo_notifies(launch: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """No repo is a notification too."""
    pane = launch(width=120)
    submit(pane, "/diff")
    pane.wait_for(r"/diff: ", timeout_s=15)
    assert_footer_intact(pane)


def test_diff_is_allowed_in_plan_mode(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """`/diff` is a command, not a tool, so Plan mode does not stop it."""
    pane = launch(width=120)
    submit(pane, "/plan start")
    pane.wait_for(r"(?i)plan", timeout_s=15)
    open_diff(pane)
    check_layout(pane)
    pane.send_keys("q")
    pane.wait_for(STATUS, timeout_s=10)
    assert not re.search(r"^ /diff \S+\s+\d+ files?", pane.capture(), re.MULTILINE)


def test_diff_is_read_only(launch: Callable[..., TmuxPane], dirty_repo: Path) -> None:
    """Browsing changes neither the tree nor the index (`status --porcelain` is identical)."""

    def status() -> str:
        return subprocess.check_output([*GIT, "-C", str(dirty_repo), "status", "--porcelain=v1"], text=True)

    before = status()
    pane = launch(width=120)
    open_diff(pane)
    for key in ["n", "n", "G", "g", "p", "j", "x", "d", "u", "q"]:
        pane.send_keys(key)
    time.sleep(0.5)
    assert status() == before


# --- two panes: orphan sweep ---------------------------------------------------------------------


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
    """SIGKILL leaves A's child and pidfile; a new session reaps them and leaves live B's alone."""
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
        # B still owns it: its own list shows it running, and C (a third session) has none
        submit(pane_b, "/monitor")
        pane_b.wait_for(r'm1 "beta" running', timeout_s=10)
        submit(pane_c, "/monitor")
        pane_c.wait_for(r"no monitors", timeout_s=10)
        # restarting another session while B lives still leaves B alone
        launch()
        time.sleep(2)
        assert ps_lines(tag_b)
        assert records["beta"][0].exists()
    finally:
        for tag in (tag_a, tag_b):
            subprocess.run(["/usr/bin/pkill", "-f", f"/bin/sleep {tag}"], check=False)
