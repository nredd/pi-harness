"""Run the selected core's check list without letting Biome rewrite the checkout.

References:
    https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import subprocess
import sys

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


def run(cmd: list[str], *, capture: bool = False) -> tuple[int, bytes]:
    """Run one command using the Node toolchain on the workflow PATH.

    Parameters:
        cmd (list[str]): Fixed argument vector from this module.
        capture (bool): Capture stdout instead of streaming it to the runner.

    Returns:
        tuple[int, bytes]: Shell-compatible status and captured stdout, if any.
    """
    try:
        child = subprocess.run(cmd, stdout=subprocess.PIPE if capture else None, timeout=1200, check=False)
    except OSError as exc:
        sys.stderr.write(f"{cmd[0]}: {exc}\n")
        return 127, b""
    except subprocess.TimeoutExpired as exc:
        sys.stderr.write(f"{cmd[0]}: {exc}\n")
        return 124, b""
    status = child.returncode
    return (128 - status if status < 0 else status), (child.stdout if capture else b"")


def main() -> int:
    """Refuse check-list drift, then execute each approved check in order.

    Returns:
        int: Zero on success, the first failing command status, or one on drift.
    """
    status, stdout = run(["node", "-p", 'require("./package.json").scripts.check'], capture=True)
    if status:
        return status
    actual = stdout.rstrip(b"\n")  # Bash command substitution strips trailing LFs, not spaces or CRs.
    if actual != EXPECTED_CHECK.encode():
        sys.stdout.buffer.write(
            b"::error::forks/pi changed its check script; update this step: " + actual + b"\n"
        )
        return 1
    for command in CHECKS:
        status, _ = run(CI_OVERRIDES.get(command, command).split())
        if status:
            return status
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
