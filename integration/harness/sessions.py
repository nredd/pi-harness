"""Generate pi session files (`.jsonl`, version 3) for resume-based scenarios and benchmarks.

A turn is four messages: the user prompt, an assistant `bash` call, its tool result, and an
assistant markdown reply. Tool rows and markdown are the expensive components to render, so a
long generated session stresses the transcript the way a real one does.

References:
- session format: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session.md
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

SESSION_VERSION = 3
MESSAGES_PER_TURN = 4
SESSION_ID = "01a0ffff-0000-7000-8000-000000000000"
EPOCH = datetime(2026, 1, 1, tzinfo=UTC)
ZERO_COST = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}


def usage(tokens: int) -> dict[str, Any]:
    """Build an assistant `usage` block.

    Parameters:
        tokens (int): input tokens to report.

    Returns:
        dict[str, Any]: usage with zero cost.
    """
    return {
        "input": tokens,
        "output": 20,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": tokens + 20,
        "cost": ZERO_COST,
    }


def turn_messages(turn: int) -> list[dict[str, Any]]:
    """Return the four messages of one generated turn.

    Parameters:
        turn (int): one-based turn number, embedded in every message.

    Returns:
        list[dict[str, Any]]: user, assistant tool call, tool result, assistant reply.
    """
    call_id = f"call_{turn:05d}"
    assistant = {"api": "faux-api", "provider": "faux", "model": "main"}
    return [
        {"role": "user", "content": [{"type": "text", "text": f"turn {turn}: list the files"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "toolCall",
                    "id": call_id,
                    "name": "bash",
                    "arguments": {"command": f"ls -la dir{turn}"},
                }
            ],
            **assistant,
            "usage": usage(1000 + turn),
            "stopReason": "toolUse",
        },
        {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": "bash",
            "content": [{"type": "text", "text": "\n".join(f"file{turn}_{n}.txt" for n in range(8))}],
            "isError": False,
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": f"Turn **{turn}** found 8 files in `dir{turn}`:\n\n- first `file{turn}_0.txt`\n"
                    f"- last `file{turn}_7.txt`\n\nNothing else to report for this directory.",
                }
            ],
            **assistant,
            "usage": usage(1100 + turn),
            "stopReason": "stop",
        },
    ]


def write_session(path: Path, cwd: Path, messages: int) -> int:
    """Write a session file holding `messages` transcript messages.

    Parameters:
        path (Path): destination `.jsonl`.
        cwd (Path): working directory recorded in the header.
        messages (int): message count, a multiple of `MESSAGES_PER_TURN`.

    Returns:
        int: number of turns written.

    Raises:
        ValueError: `messages` is not a positive multiple of `MESSAGES_PER_TURN`.
    """
    if messages <= 0 or messages % MESSAGES_PER_TURN:
        raise ValueError(f"`messages` must be a positive multiple of {MESSAGES_PER_TURN}, got '{messages}'")
    turns = messages // MESSAGES_PER_TURN
    entries: list[dict[str, Any]] = [
        {
            "type": "session",
            "version": SESSION_VERSION,
            "id": SESSION_ID,
            "timestamp": EPOCH.isoformat().replace("+00:00", "Z"),
            "cwd": str(cwd),
        }
    ]
    parent: str | None = None
    index = 0
    for turn in range(1, turns + 1):
        for message in turn_messages(turn):
            stamp = EPOCH + timedelta(seconds=index)
            entry_id = f"{index:08x}"
            entries.append(
                {
                    "type": "message",
                    "id": entry_id,
                    "parentId": parent,
                    "timestamp": stamp.isoformat().replace("+00:00", "Z"),
                    "message": {**message, "timestamp": int(stamp.timestamp() * 1000)},
                }
            )
            parent = entry_id
            index += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
    return turns
