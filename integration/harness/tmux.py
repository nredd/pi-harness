"""Drive interactive pi in a real tmux pane: keys, raw SGR mouse input, and screen captures.

Each pane runs on a private tmux socket with a minimal config, so the user's tmux server and
`~/.tmux.conf` never take part.

References:
- tmux(1) `send-keys -H`, `capture-pane -p -e`: https://man.openbsd.org/tmux.1
- xterm SGR mouse mode (1006): https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Extended-coordinates
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from harness.paths import TMUX_BIN

if TYPE_CHECKING:
    from pathlib import Path

LOGGER = logging.getLogger(__name__)

TMUX_CONF = """\
set -g default-terminal "xterm-256color"
set -ga terminal-features ",xterm-256color:RGB"
set -g escape-time 0
set -g extended-keys on
set -g extended-keys-format csi-u
set -g history-limit 50000
set -g remain-on-exit on
set -g status off
"""
POLL_INTERVAL_S = 0.05
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;:?<>]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

# SGR mouse button codes.
BUTTON_LEFT = 0
WHEEL_UP = 64
WHEEL_DOWN = 65
MODIFIER_SHIFT = 4
MODIFIER_ALT = 8
MODIFIER_CTRL = 16


def strip_ansi(text: str) -> str:
    """Remove CSI and OSC sequences.

    Parameters:
        text (str): styled text.

    Returns:
        str: plain text.
    """
    return ANSI_ESCAPE.sub("", text)


def sgr_mouse(button: int, column: int, row: int, *, release: bool = False) -> bytes:
    """Encode one SGR (1006) mouse report.

    Parameters:
        button (int): button code including modifier bits, e.g. `BUTTON_LEFT | MODIFIER_ALT`.
        column (int): zero-based column.
        row (int): zero-based row.
        release (bool): encode a release (`m`) instead of a press (`M`).

    Returns:
        bytes: `ESC [ < b ; x ; y M|m` with one-based coordinates.

    Raises:
        ValueError: a coordinate or the button is negative.
    """
    if button < 0 or column < 0 or row < 0:
        raise ValueError(f"Mouse report fields must be non-negative: '{button}', '{column}', '{row}'")
    return f"\x1b[<{button};{column + 1};{row + 1}{'m' if release else 'M'}".encode()


class TmuxTimeoutError(AssertionError):
    """A pane never showed the expected content; carries the last capture."""

    def __init__(self, message: str, capture: str) -> None:
        """Build the error.

        Parameters:
            message (str): what was awaited.
            capture (str): last plain capture of the pane.
        """
        super().__init__(f"{message}\n--- last capture ---\n{capture}")
        self.capture = capture


@dataclass
class TmuxPane:
    """One detached tmux session holding a single pane.

    Attributes:
        socket (Path): private tmux socket path.
        name (str): session name.
        width (int): columns.
        height (int): rows.
    """

    socket: Path
    name: str
    width: int = 120
    height: int = 40
    exit_status_path: Path | None = None

    def _tmux(self, *args: str, env: dict[str, str] | None = None) -> str:
        """Run a tmux client command on the private socket.

        Parameters:
            *args (str): tmux arguments.
            env (dict[str, str] | None): client environment; only the first client's matters.

        Returns:
            str: stdout.

        Raises:
            RuntimeError: tmux exited non-zero.
        """
        conf = self.socket.with_suffix(".conf")
        try:
            return subprocess.check_output(
                [TMUX_BIN, "-S", str(self.socket), "-f", str(conf), *args],
                text=True,
                stderr=subprocess.PIPE,
                env=env,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"`tmux {' '.join(args[:2])}` failed: {e.stderr.strip()}") from e

    def start(self, argv: list[str], cwd: Path, env: dict[str, str]) -> None:
        """Launch `argv` in a new detached session.

        Parameters:
            argv (list[str]): command to run in the pane.
            cwd (Path): working directory.
            env (dict[str, str]): complete environment for the pane.
        """
        self.socket.with_suffix(".conf").write_text(TMUX_CONF)
        env_flags = [flag for key, value in sorted(env.items()) for flag in ("-e", f"{key}={value}")]
        self._tmux(
            "new-session",
            "-d",
            "-s",
            self.name,
            "-x",
            str(self.width),
            "-y",
            str(self.height),
            "-c",
            str(cwd),
            *env_flags,
            "--",
            *argv,
            env=env,
        )
        LOGGER.info(f"Started tmux pane '{self.name}' {self.width}x{self.height}: {argv}")

    def capture(self, *, styled: bool = False) -> str:
        """Capture the visible screen.

        Parameters:
            styled (bool): keep SGR sequences (`capture-pane -e`).

        Returns:
            str: one line per row.
        """
        return self._tmux("capture-pane", "-p", *(["-e"] if styled else []), "-t", self.name)

    def rows(self) -> list[str]:
        """Return the plain visible rows, trailing spaces removed.

        Returns:
            list[str]: exactly `height` rows when the pane is alive.
        """
        return [line.rstrip() for line in self.capture().split("\n")]

    def wait_for(self, pattern: str, *, timeout_s: float = 30.0, absent: bool = False) -> str:
        """Poll until a regex matches (or stops matching) the plain screen.

        Parameters:
            pattern (str): regex searched in the plain capture.
            timeout_s (float): give up after this long.
            absent (bool): wait for the pattern to disappear instead.

        Returns:
            str: the capture that satisfied the condition.

        Raises:
            TmuxTimeoutError: the condition never held.
        """
        compiled = re.compile(pattern, re.MULTILINE)
        deadline = time.monotonic() + timeout_s
        capture = ""
        while time.monotonic() < deadline:
            capture = self.capture()
            if bool(compiled.search(capture)) != absent:
                return capture
            time.sleep(POLL_INTERVAL_S)
        state = "disappear" if absent else "appear"
        raise TmuxTimeoutError(f"Timed out after {timeout_s}s waiting for /{pattern}/ to {state}", capture)

    def wait_stable(self, *, quiet_s: float = 2.0, timeout_s: float = 30.0) -> list[str]:
        """Wait until the plain screen stops changing for `quiet_s`.

        Parameters:
            quiet_s (float): how long the screen must stay identical.
            timeout_s (float): give up after this long.

        Returns:
            list[str]: the settled rows.

        Raises:
            TmuxTimeoutError: the screen kept changing.
        """
        deadline = time.monotonic() + timeout_s
        last = self.capture()
        since = time.monotonic()
        while time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL_S * 4)
            current = self.capture()
            if current != last:
                last, since = current, time.monotonic()
            elif time.monotonic() - since >= quiet_s:
                return [line.rstrip() for line in current.split("\n")]
        raise TmuxTimeoutError(f"Screen never settled for {quiet_s}s within {timeout_s}s", last)

    def resize(self, width: int, height: int) -> None:
        """Resize the window, as a terminal resize would.

        Parameters:
            width (int): columns.
            height (int): rows.
        """
        self._tmux("resize-window", "-t", self.name, "-x", str(width), "-y", str(height))
        self.width, self.height = width, height

    def send_keys(self, *keys: str) -> None:
        """Send tmux key names, e.g. `Enter`, `Escape`, `C-c`.

        Parameters:
            *keys (str): tmux key names.
        """
        self._tmux("send-keys", "-t", self.name, *keys)

    def type_text(self, text: str) -> None:
        """Type literal text.

        Parameters:
            text (str): characters to type.
        """
        self._tmux("send-keys", "-t", self.name, "-l", text)

    def write_raw(self, data: bytes) -> None:
        """Deliver raw bytes to the application as terminal input.

        Parameters:
            data (bytes): bytes to deliver.
        """
        self._tmux("send-keys", "-t", self.name, "-H", *(f"{byte:02x}" for byte in data))

    def click(self, column: int, row: int, *, button: int = BUTTON_LEFT) -> None:
        """Press and release a mouse button at a zero-based cell.

        Parameters:
            column (int): zero-based column.
            row (int): zero-based row.
            button (int): button code including modifier bits.
        """
        self.write_raw(sgr_mouse(button, column, row) + sgr_mouse(button, column, row, release=True))

    def drag(self, start: tuple[int, int], end: tuple[int, int]) -> None:
        """Press at `start`, move to `end` with the button held, release there.

        Parameters:
            start (tuple[int, int]): zero-based (column, row).
            end (tuple[int, int]): zero-based (column, row).
        """
        motion = BUTTON_LEFT | 32
        self.write_raw(
            sgr_mouse(BUTTON_LEFT, *start)
            + sgr_mouse(motion, *end)
            + sgr_mouse(BUTTON_LEFT, *end, release=True)
        )

    def wheel(self, column: int, row: int, *, down: bool = True, alt: bool = False) -> None:
        """Send one wheel notch.

        Parameters:
            column (int): zero-based column.
            row (int): zero-based row.
            down (bool): scroll down instead of up.
            alt (bool): hold Alt.
        """
        button = (WHEEL_DOWN if down else WHEEL_UP) | (MODIFIER_ALT if alt else 0)
        self.write_raw(sgr_mouse(button, column, row))

    def is_alive(self) -> bool:
        """Report whether the pane's process is still running.

        Returns:
            bool: False once the process exited (the pane remains for capture).
        """
        try:
            dead = self._tmux("display-message", "-p", "-t", self.name, "#{pane_dead}").strip()
        except RuntimeError:
            return False
        return dead == "0"

    def kill(self) -> None:
        """Tear down the private tmux server and its socket dir; safe to call twice."""
        try:
            self._tmux("kill-server")
        except RuntimeError:
            LOGGER.debug(f"tmux server for '{self.name}' was already gone")
        shutil.rmtree(self.socket.parent, ignore_errors=True)


def reap_stale_servers(socket_root: Path, max_age_s: float) -> list[Path]:
    """Kill private tmux servers left behind by aborted runs and remove their socket dirs.

    A pane is killed in fixture teardown, which an interrupted run never reaches, so servers
    (and the pi processes inside them) would otherwise pile up across runs.

    Parameters:
        socket_root (Path): directory holding the `pih-*` socket dirs.
        max_age_s (float): only reap dirs older than this, so a concurrent run is left alone.

    Returns:
        list[Path]: socket dirs that were removed.
    """
    reaped = []
    cutoff = time.time() - max_age_s
    for directory in socket_root.glob("pih-*"):
        try:
            if directory.stat().st_mtime > cutoff:
                continue
        except FileNotFoundError:
            continue
        for socket in directory.glob("*.sock"):
            subprocess.run(
                [TMUX_BIN, "-S", str(socket), "kill-server"], capture_output=True, check=False, timeout=10
            )
        shutil.rmtree(directory, ignore_errors=True)
        reaped.append(directory)
    if reaped:
        LOGGER.warning(f"Reaped {len(reaped)} stale tmux server dir(s) under '{socket_root}'")
    return reaped


def find_row(rows: list[str], pattern: str) -> int:
    """Return the index of the first row matching a regex.

    Parameters:
        rows (list[str]): plain rows.
        pattern (str): regex.

    Returns:
        int: row index.

    Raises:
        AssertionError: nothing matched.
    """
    compiled = re.compile(pattern)
    for index, row in enumerate(rows):
        if compiled.search(row):
            return index
    raise AssertionError(f"No row matches /{pattern}/:\n" + "\n".join(rows))
