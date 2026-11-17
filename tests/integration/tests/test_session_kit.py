"""Seeded `/stats` history: counted calls, ignored rows and the forked copy; no Pi process.

References:
- https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from harness.session_kit import STATS_DAYS, STATS_MODELS, seed_stats_sessions

if TYPE_CHECKING:
    from pathlib import Path


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Parse one seeded session file.

    Parameters:
        path (Path): JSONL session.

    Returns:
        list[dict[str, Any]]: entries in file order.
    """
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_seeded_history_counts_four_models_over_the_window(tmp_path: Path) -> None:
    """The favorite is the real token leader, and every counted call sits inside the window.

    Parameters:
        tmp_path (Path): private agent directory.
    """
    before = datetime.now(UTC)
    assert seed_stats_sessions(tmp_path) == {"favorite": "anthropic/claude-opus-5-5"}
    root = tmp_path / "sessions" / "--seed--"
    assert sorted(path.name for path in root.iterdir()) == ["fork.jsonl", "main.jsonl"]
    header, *entries = read_jsonl(root / "main.jsonl")
    assert header["type"] == "session"
    assert (header["id"], header["version"], header["cwd"]) == ("seed", 3, "/seed")
    counted = [
        entry
        for entry in entries
        if entry["message"]["role"] == "assistant"
        and entry["message"]["provider"] in {"anthropic", "openai-codex"}
        and entry["message"]["usage"]["totalTokens"] > 0
    ]
    assert len(entries) - len(counted) == 3
    totals: Counter[str] = Counter()
    for entry in counted:
        message = entry["message"]
        totals[f"{message['provider']}/{message['model']}"] += message["usage"]["totalTokens"]
        stamp = datetime.fromisoformat(entry["timestamp"])
        assert before - timedelta(days=STATS_DAYS) <= stamp <= before
        assert message["timestamp"] // 1000 == int(stamp.timestamp())
    assert set(totals) == {f"{provider}/{model}" for provider, model, _ in STATS_MODELS}
    assert totals.most_common(1)[0][0] == "anthropic/claude-opus-5-5"


def test_seeded_history_carries_each_row_stats_must_ignore(tmp_path: Path) -> None:
    """Faux, zero-usage router, tool-result usage and a forked copy are all present to be ignored.

    Parameters:
        tmp_path (Path): private agent directory.
    """
    seed_stats_sessions(tmp_path)
    root = tmp_path / "sessions" / "--seed--"
    header, *entries = read_jsonl(root / "main.jsonl")
    faux, router, tool = entries[-3:]
    assert (faux["message"]["provider"], faux["message"]["usage"]["output"]) == ("faux", 10_000_000)
    assert (router["message"]["provider"], router["message"]["usage"]["totalTokens"]) == ("router", 0)
    assert tool["message"]["role"] == "toolResult"
    assert tool["message"]["toolName"] == "steer_subagent"
    assert tool["message"]["usage"]["input"] == 50_000_000
    fork_header, copied = read_jsonl(root / "fork.jsonl")
    assert fork_header == header | {
        "id": "fork",
        "timestamp": fork_header["timestamp"],
        "parentSession": str(root / "main.jsonl"),
    }
    assert copied == entries[-4]


def test_seeding_again_rewrites_rather_than_appends(tmp_path: Path) -> None:
    """A second seed into the same agent dir replaces both files, so totals never double.

    Parameters:
        tmp_path (Path): private agent directory.
    """
    seed_stats_sessions(tmp_path)
    main = tmp_path / "sessions" / "--seed--" / "main.jsonl"
    count = len(main.read_text().splitlines())
    seed_stats_sessions(tmp_path)
    assert len(main.read_text().splitlines()) == count
