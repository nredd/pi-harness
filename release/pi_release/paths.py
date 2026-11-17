"""Platform and executable locations shared by release tools and test harnesses.

References:
- https://github.com/nredd/pi-harness/issues/884
"""

from __future__ import annotations

import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def is_wsl(version_file: Path = Path("/proc/version")) -> bool:
    """Report whether this is WSL2 (`microsoft` or `WSL` in `/proc/version`).

    Parameters:
        version_file (Path): kernel version file; overridable for tests.

    Returns:
        bool: True under WSL, False on macOS, native Linux, or an unreadable file.
    """
    try:
        text = version_file.read_text()
    except OSError:
        return False
    return "microsoft" in text.lower() or "wsl" in text.lower()


def _tool(name: str, fallback: str) -> str:
    """Resolve a tool on `PATH`, falling back to the macOS Homebrew location."""
    return shutil.which(name) or fallback


TMUX_BIN = _tool("tmux", "/opt/homebrew/bin/tmux")
GIT_BIN = _tool("git", "/usr/bin/git")
NODE_BIN = _tool("node", "/opt/homebrew/bin/node")
GH_BIN = _tool("gh", "/opt/homebrew/bin/gh")
NPM_BIN = _tool("npm", "/opt/homebrew/bin/npm")
