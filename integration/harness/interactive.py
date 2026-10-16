"""Launch interactive pi inside a tmux pane against faux providers."""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness.paths import FAUX_EXTENSION, pi_command
from harness.tmux import TmuxPane

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

# Unix socket paths are capped near 104 bytes on macOS, far shorter than pytest temp paths.
SOCKET_ROOT = Path("/tmp")
# The footer names the selected model once the first frame is drawn.
FIRST_FRAME_PATTERN = r"\bmain\b"
STARTUP_TIMEOUT_S = 60.0
AUTOCOMPLETE_SETTLE_S = 0.3


def launch_tui(
    sandbox: Sandbox,
    script: dict[str, Any],
    *,
    name: str = "pi",
    width: int = 120,
    height: int = 40,
    model: str = "faux/main",
    extra_args: list[str] | None = None,
    env: dict[str, str] | None = None,
    wait_pattern: str | None = FIRST_FRAME_PATTERN,
) -> TmuxPane:
    """Start interactive pi in a fresh tmux pane and wait for its first frame.

    Parameters:
        sandbox (Sandbox): pi home.
        script (dict[str, Any]): faux provider script, see `providers/faux.ts`.
        name (str): tmux session name, unique per sandbox.
        width (int): pane columns.
        height (int): pane rows.
        model (str): `provider/id` to select.
        extra_args (list[str] | None): additional pi flags.
        env (dict[str, str] | None): extra environment.
        wait_pattern (str | None): regex that marks the first frame; `None` skips waiting.

    Returns:
        TmuxPane: the running pane. The caller kills it.
    """
    script_path = sandbox.root / f"script-{name}-{time.monotonic_ns()}.json"
    script_path.write_text(json.dumps(script))
    socket_dir = Path(tempfile.mkdtemp(prefix="pih-", dir=SOCKET_ROOT))
    pane = TmuxPane(socket=socket_dir / f"{name}.sock", name=name, width=width, height=height)
    pi_argv = [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", model, *(extra_args or [])]
    # Extensions that print to stderr would scribble over the TUI; keep it as an artifact instead.
    stderr_path = sandbox.root / f"{name}.stderr"
    argv = ["/bin/sh", "-c", 'exec "$@" 2>>"$PI_HARNESS_STDERR"', "sh", *pi_argv]
    pane_env = {"HARNESS_SCRIPT": str(script_path), "PI_HARNESS_STDERR": str(stderr_path)} | (env or {})
    try:
        pane.start(argv, sandbox.workdir, sandbox.env(pane_env))
        if wait_pattern is not None:
            pane.wait_for(wait_pattern, timeout_s=STARTUP_TIMEOUT_S)
    except BaseException:
        # The caller cannot register teardown until we return ownership of the pane.
        pane.kill()
        raise
    return pane


def submit(pane: TmuxPane, text: str) -> None:
    """Type a message into the editor and press Enter.

    A slash command opens the autocomplete list, whose Enter both submits and re-inserts the
    selected completion into the editor. Escape closes the list first.

    Parameters:
        pane (TmuxPane): running pi pane.
        text (str): message or slash command.
    """
    pane.type_text(text)
    if text.startswith("/"):
        time.sleep(AUTOCOMPLETE_SETTLE_S)
        pane.send_keys("Escape")
    pane.send_keys("Enter")
