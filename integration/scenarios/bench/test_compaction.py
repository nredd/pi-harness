"""Auto-compaction fires at exactly the token count core's formula predicts.

Core (`packages/coding-agent/src/core/compaction/compaction.ts`) compacts after a turn when

    contextTokens > contextWindow - reserveTokens

where `contextTokens` is the last assistant message's `usage.totalTokens` (or the sum of its
parts). Each run resumes a fresh copy of a generated 16-message history and sends one prompt,
so exactly one faux reply reports usage (faux usage is not monotonic across turns, so a
multi-turn run would cross the threshold early). A first run with a huge window reads that
usage `U`; then the faux model's `contextWindow` is set to `U + reserve` (exactly at the
threshold: no compaction) and to `U + reserve - 1` (one token over: compaction).
"""

from __future__ import annotations

import shutil
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, run_headless
from harness.sessions import write_session

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.bench

RESERVE_TOKENS = 2048
HUGE_WINDOW = 1_000_000
HISTORY_MESSAGES = 16
REPLY = "REPLY"


def script(context_window: int) -> dict[str, Any]:
    """One short reply, then the compaction summary.

    Parameters:
        context_window (int): faux model `contextWindow`.

    Returns:
        dict[str, Any]: faux script.
    """
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "contextWindow": context_window,
                "steps": [{"text": REPLY}, {"text": "SUMMARY OF EARLIER TURNS"}],
            }
        }
    }


def context_tokens(usage: dict[str, Any]) -> int:
    """Mirror core's `calculateContextTokens`.

    Parameters:
        usage (dict[str, Any]): assistant `usage`.

    Returns:
        int: `totalTokens`, or the sum of its parts when it is zero.
    """
    total = int(usage.get("totalTokens") or 0)
    if total:
        return total
    return sum(int(usage.get(key) or 0) for key in ("input", "output", "cacheRead", "cacheWrite"))


def reply_tokens(result: RunResult) -> int:
    """Return the context tokens reported with the reply to the prompt.

    Parameters:
        result (RunResult): headless run.

    Returns:
        int: context tokens of the `REPLY` message.

    Raises:
        AssertionError: the run has no `REPLY` message.
    """
    for event in result.of_type("message_end"):
        message = event.get("message", {})
        if message.get("role") == "assistant" and REPLY in str(message.get("content")):
            return context_tokens(message.get("usage") or {})
    raise AssertionError(f"no `{REPLY}` reply\n" + result.transcript())


def run_resumed(sandbox: Sandbox, history: Path, context_window: int, name: str) -> RunResult:
    """Resume a fresh copy of `history` and send one prompt.

    Parameters:
        sandbox (Sandbox): pi home.
        history (Path): generated session to copy.
        context_window (int): faux model `contextWindow`.
        name (str): copy name, unique per run.

    Returns:
        RunResult: the run.
    """
    session = history.with_name(f"{name}.jsonl")
    shutil.copy2(history, session)
    result = run_headless(sandbox, script(context_window), ["go"], extra_args=["--session", str(session)])
    assert result.returncode == 0, result.transcript()
    return result


def compaction_reasons(result: RunResult) -> list[str]:
    """Return the `reason` of every `compaction_start`.

    Parameters:
        result (RunResult): headless run.

    Returns:
        list[str]: reasons in order.
    """
    return [str(event.get("reason")) for event in result.of_type("compaction_start")]


def test_compaction_triggers_one_token_past_the_threshold(sandbox: Sandbox) -> None:
    """`U + reserve` does not compact; `U + reserve - 1` does, once, for `threshold`."""
    sandbox.patch_json(
        "settings.json",
        {"compaction": {"enabled": True, "reserveTokens": RESERVE_TOKENS, "keepRecentTokens": 1}},
    )
    history = sandbox.root / "compaction-sessions" / "history.jsonl"
    write_session(history, sandbox.workdir, HISTORY_MESSAGES)
    measured = run_resumed(sandbox, history, HUGE_WINDOW, "measured")
    assert not compaction_reasons(measured), measured.transcript()
    tokens = reply_tokens(measured)

    at_threshold = run_resumed(sandbox, history, tokens + RESERVE_TOKENS, "at-threshold")
    assert reply_tokens(at_threshold) == tokens, "usage is not deterministic across runs"
    assert not compaction_reasons(at_threshold), (
        f"compacted at contextTokens == window - reserve ({tokens})\n" + at_threshold.transcript()
    )

    past = run_resumed(sandbox, history, tokens + RESERVE_TOKENS - 1, "past")
    assert reply_tokens(past) == tokens, "usage is not deterministic across runs"
    assert compaction_reasons(past) == ["threshold"], (
        f"no threshold compaction at contextTokens == window - reserve + 1 ({tokens})\n" + past.transcript()
    )
    ends = past.of_type("compaction_end")
    assert ends, past.transcript()
    assert ends[-1].get("result"), f"compaction did not complete: {ends[-1]}\n" + past.transcript()
