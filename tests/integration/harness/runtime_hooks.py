"""Runtime adapter: inject harness preloads and GC into Node and compiled Bun standalones alike.

A compiled Bun standalone ignores `NODE_OPTIONS` entirely (`--import`, `--require` and `--expose-gc`
all do nothing), so every harness hook must be expressed twice: Node reads `NODE_OPTIONS`, a
compiled Bun reads `BUN_OPTIONS` (`--preload`, `--expose-gc`) before its entrypoint. Each runtime
ignores the other's variable, so setting both is safe. Bun does NOT parse quotes in `BUN_OPTIONS`
and silently drops a hook whose path holds whitespace, so such paths are refused here.

References:
- https://bun.sh/docs/runtime/bunfig#preload
- https://github.com/nredd/pi-harness/issues/14
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from pathlib import Path

UNSAFE_PATH = re.compile(r"[\s\"']")


def runtime_hooks(
    preloads: Iterable[Path] = (), *, expose_gc: bool = False, env: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Return the environment that loads `preloads` and optionally exposes `gc` on either runtime.

    Parameters:
        preloads (Iterable[Path]): modules to evaluate before the entrypoint, in order.
        expose_gc (bool): expose a synchronous global `gc()` (Node `--expose-gc`, Bun `--expose-gc`).
        env (Mapping[str, str] | None): existing options to prepend verbatim, preserving caller flags/paths.

    Returns:
        dict[str, str]: `NODE_OPTIONS` and `BUN_OPTIONS`; empty when no hook is requested.

    Raises:
        ValueError: a preload path holds whitespace or a quote, which Bun would silently drop.
    """
    node: list[str] = []
    bun: list[str] = []
    for path in preloads:
        if UNSAFE_PATH.search(str(path)):
            raise ValueError(
                f"Preload path '{path}' holds whitespace or a quote; `BUN_OPTIONS` cannot quote it"
            )
        node += ["--import", str(path)]
        bun += ["--preload", str(path)]
    if expose_gc:
        node.append("--expose-gc")
        bun.append("--expose-gc")
    if not node:
        return {}
    existing = env or {}
    return {
        key: " ".join(part for part in (existing.get(key, ""), value) if part)
        for key, value in {"NODE_OPTIONS": " ".join(node), "BUN_OPTIONS": " ".join(bun)}.items()
    }
