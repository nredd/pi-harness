"""Run the selected core's check list without letting Biome rewrite the checkout.

References:
    https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

CHECKS = (
    "node scripts/worktree.mjs check",
    "node scripts/biome-check.mjs --write",
    "npm run check:binary-release",
    "npm run check:fork-audit",
    "npm run check:pinned-deps",
    "npm run check:runtime-deps",
    "npm run check:ts-imports",
    "npm run check:entry-graphs",
    "npm run check:install-lock:coding-agent",
    "tsc --noEmit",
    "npm run check:browser-smoke",
)
EXPECTED_CHECK = " && ".join(CHECKS)
CI_OVERRIDES = {
    "node scripts/biome-check.mjs --write": "node scripts/biome-check.mjs",
    "tsc --noEmit": "npx tsc --noEmit",
}


def resolve_tool(name: str, path: str) -> tuple[Path | None, Path | None]:
    """Record the executable or the non-executable PATH entry Bash would report.

    Parameters:
        name (str): Node tool name.
        path (str): Workflow PATH after setup-node.

    Returns:
        tuple[Path | None, Path | None]: Absolute executable and diagnostic path, respectively.
    """
    if executable := shutil.which(name, path=path):
        # Keep the selected symlink name (npm and npx may share a launcher).
        return Path(executable).absolute(), None
    denied = next(
        (entry for directory in path.split(os.pathsep) if (entry := Path(directory) / name).is_file()), None
    )
    return None, denied


def run(
    cmd: list[str], tools: Mapping[str, tuple[Path | None, Path | None]], line: int, *, capture: bool = False
) -> tuple[int, bytes]:
    """Run one resolved command without shortening the workflow job deadline.

    Parameters:
        cmd (list[str]): Tool name and fixed arguments from this module.
        tools (Mapping[str, tuple[Path | None, Path | None]]): Initial PATH resolution.
        line (int): Command line in the original Bash block.
        capture (bool): Capture stdout instead of streaming it to the runner.

    Returns:
        tuple[int, bytes]: Shell-compatible status and captured stdout, if any.
    """
    executable, denied = tools[cmd[0]]
    prefix = f"fork-check: line {line}: "
    if executable is None:
        if denied is not None:
            sys.stderr.write(f"{prefix}{denied}: Permission denied\n")
            return 126, b""
        sys.stderr.write(f"{prefix}{cmd[0]}: command not found\n")
        return 127, b""
    try:
        child = subprocess.run(
            [str(executable), *cmd[1:]], stdout=subprocess.PIPE if capture else None, check=False
        )
    except FileNotFoundError:
        sys.stderr.write(f"{prefix}{executable}: No such file or directory\n")
        return 127, b""
    except OSError as exc:
        sys.stderr.write(f"{prefix}{executable}: {exc.strerror}\n")
        return 126, b""
    status = child.returncode
    return (128 - status if status < 0 else status), (child.stdout if capture else b"")


def main() -> int:
    """Refuse check-list drift, then execute each approved check in order.

    Returns:
        int: Zero on success, the first failing command status, or one on drift.
    """
    path = os.environ.get("PATH", os.defpath)
    tools = {name: resolve_tool(name, path) for name in ("node", "npm", "npx")}
    # Fail at the original command, so preceding output and failures still win.
    status, stdout = run(["node", "-p", 'require("./package.json").scripts.check'], tools, 4, capture=True)
    if status:
        return status
    # Bash 3 strips NUL silently; Bash 4.4+ also warns. Refuse malformed probe output.
    if b"\0" in stdout:
        sys.stdout.buffer.write(b"::error::forks/pi check script contains a NUL byte\n")
        return 1
    actual = stdout.rstrip(b"\n")  # Bash command substitution strips trailing LFs, not spaces or CRs.
    if actual != EXPECTED_CHECK.encode():
        sys.stdout.buffer.write(
            b"::error::forks/pi changed its check script; update this step: " + actual + b"\n"
        )
        return 1
    for line, command in enumerate(CHECKS, start=9):
        status, _ = run(CI_OVERRIDES.get(command, command).split(), tools, line)
        if status:
            return status
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
