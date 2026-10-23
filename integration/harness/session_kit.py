"""History fixtures and explicit installed session-kit resource selection.

References:
- https://github.com/nredd/pi-session-kit
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, TypedDict

from harness.stack import find_package, package_manifest

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

KIT = "pi-session-kit"
STATS_DAYS = 45


class SeededStats(TypedDict):
    """What `/stats` should conclude from `seed_stats_sessions`.

    Attributes:
        favorite (str): `provider/model` with the most tokens.
    """

    favorite: str


STATS_MODELS = [
    ("anthropic", "claude-opus-5-5", 9),
    ("anthropic", "claude-sonnet-5-5", 4),
    ("openai-codex", "gpt-6.1-sol", 6),
    ("openai-codex", "gpt-5.6-terra", 2),
]


def kit_args(box: Sandbox, *, explicit: bool = False) -> list[str]:
    """Use package discovery, or explicitly load the declared package's entry.

    Parameters:
        box (Sandbox): installed sandbox.
        explicit (bool): caller disabled extension discovery.

    Returns:
        list[str]: no flags for discovery, one explicit entry otherwise.
    """
    if not explicit:
        return []
    directory = find_package(KIT, box.settings().get("packages", []), box.agent_dir)
    manifest = package_manifest(directory)
    return ["-e", str(directory / manifest["pi"]["extensions"][0])]


def compact(value: Any) -> str:
    """JSON the way pi writes session entries: no spaces.

    Parameters:
        value (Any): entry.

    Returns:
        str: one JSONL line.
    """
    return json.dumps(value, separators=(",", ":"))


def iso(moment: datetime) -> str:
    """UTC ISO timestamp the way pi writes it.

    Parameters:
        moment (datetime): local naive time.

    Returns:
        str: `2026-10-13T12:00:00.000Z`.
    """
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def assistant(moment: datetime, provider: str, model: str, tokens: int) -> str:
    """One assistant entry with usage.

    Parameters:
        moment (datetime): local time of the call.
        provider (str): provider id.
        model (str): model id.
        tokens (int): output tokens; input and cache write scale from it.

    Returns:
        str: JSONL line.
    """
    ms = int(moment.timestamp() * 1000)
    usage = {
        "input": tokens * 2,
        "output": tokens,
        "cacheRead": tokens * 20,
        "cacheWrite": tokens * 3,
        "totalTokens": tokens * 26,
        "cost": {"total": tokens / 100_000},
    }
    message = {"role": "assistant", "content": [], "provider": provider, "model": model, "usage": usage}
    return compact(
        {"type": "message", "id": f"{ms:x}", "timestamp": iso(moment), "message": message | {"timestamp": ms}}
    )


def seed_stats_sessions(agent_dir: Path) -> SeededStats:
    """Seed `/stats` history: 45 days, two providers, four models, plus rows it must ignore.

    Ignored rows: a `faux` call, a zero-usage `router/default` stub, a `steer_subagent` tool result
    carrying `usage`, and a forked copy of the newest call.

    Parameters:
        agent_dir (Path): sandbox agent dir; files go under `sessions/`.

    Returns:
        SeededStats: expected facts.
    """
    root = agent_dir / "sessions" / "--seed--"
    root.mkdir(parents=True, exist_ok=True)
    today = datetime.now(UTC) - timedelta(hours=1)
    lines: list[str] = []
    for back in range(STATS_DAYS):
        day = today - timedelta(days=back)
        for provider, model, weight in STATS_MODELS:
            if (back + weight) % 4 == 0:
                continue
            lines.append(assistant(day, provider, model, weight * 1000 * (1 + back % 6)))
    start = today - timedelta(days=STATS_DAYS)
    header = {"type": "session", "version": 3, "id": "seed", "timestamp": iso(start), "cwd": "/seed"}
    ignored = [
        assistant(today, "faux", "faux-1", 10_000_000),
        assistant(today, "router", "default", 0),
        compact(
            {
                "type": "message",
                "timestamp": iso(today),
                "message": {
                    "role": "toolResult",
                    "toolName": "steer_subagent",
                    "content": [],
                    "usage": {"input": 50_000_000, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                },
            }
        ),
    ]
    (root / "main.jsonl").write_text("\n".join([compact(header), *lines, *ignored]) + "\n")
    fork_header = header | {"id": "fork", "timestamp": iso(today), "parentSession": str(root / "main.jsonl")}
    (root / "fork.jsonl").write_text("\n".join([compact(fork_header), lines[-1]]) + "\n")
    return {"favorite": "anthropic/claude-opus-5-5"}
