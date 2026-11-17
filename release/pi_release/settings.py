"""Merge stack defaults with explicit settings overlays.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md
"""

from __future__ import annotations

from typing import Any


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursively overlay objects, replacing arrays and scalars.

    Parameters:
        base (dict[str, Any]): original object.
        overlay (dict[str, Any]): winning values.

    Returns:
        dict[str, Any]: merged copy.
    """
    merged = dict(base)
    for key, value in overlay.items():
        existing = merged.get(key)
        merged[key] = (
            deep_merge(existing, value) if isinstance(existing, dict) and isinstance(value, dict) else value
        )
    return merged
