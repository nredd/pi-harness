"""Resolve the repos a scenario needs to the exact commits the live harness runs.

A scenario must never test a different checkout than the one pi loads, so repos are located by
the chezmoi `git:` pins, not by `~/code/<name>`. The installed checkout is used when it already
sits on the pin; otherwise the pin is cloned into a cache.
"""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

from harness.config_checks import GitPin, checkout_matches_ref, git_pins
from harness.paths import CACHE_DIR, GIT_BIN, LIVE_AGENT_DIR

if TYPE_CHECKING:
    from pathlib import Path


def pinned_checkout(repo: str, packages: list[object], overrides: dict[str, Path] | None = None) -> Path:
    """Return a checkout of `repo` at the commit chezmoi pins.

    Parameters:
        repo (str): repo name, e.g. `pi-subagents`.
        packages (list[object]): rendered settings `packages`.
        overrides (dict[str, Path] | None): `HARNESS_LOCAL` checkouts; these win, by explicit request.

    Returns:
        Path: working tree whose HEAD is the pinned ref.

    Raises:
        LookupError: `repo` is not a pinned git package.
        RuntimeError: cloning or checking out the pin failed.
    """
    if overrides and repo in overrides:
        return overrides[repo]
    pin = next((p for p in git_pins(packages) if p.repo == repo), None)
    if pin is None:
        raise LookupError(f"`{repo}` is not a pinned git package in the chezmoi settings")
    installed = LIVE_AGENT_DIR / "git" / pin.host / pin.owner / pin.repo
    if installed.is_dir() and checkout_matches_ref(installed, pin.ref)[0]:
        return installed
    return clone_at_pin(pin)


def clone_at_pin(pin: GitPin) -> Path:
    """Clone `pin` over SSH into the cache and check out its ref, reusing a previous clone.

    Parameters:
        pin (GitPin): the pinned package.

    Returns:
        Path: cached working tree on the pinned ref.

    Raises:
        RuntimeError: git failed or the cache holds a different commit than the pin.
    """
    target = CACHE_DIR / f"{pin.repo}@{pin.ref}"
    if not target.is_dir():
        target.parent.mkdir(parents=True, exist_ok=True)
        url = f"git@{pin.host}:{pin.owner}/{pin.repo}.git"
        # `--branch` takes tags and branches; a bare commit pin falls back to fetch + checkout.
        cloned = subprocess.run(
            [GIT_BIN, "clone", "--quiet", "--branch", pin.ref, url, str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        if cloned.returncode != 0:
            raise RuntimeError(f"Cannot clone {url} at '{pin.ref}': {cloned.stderr.strip()}")
    matches, detail = checkout_matches_ref(target, pin.ref)
    if not matches:
        raise RuntimeError(f"Cached clone '{target}' is not on the pin: {detail}")
    return target
