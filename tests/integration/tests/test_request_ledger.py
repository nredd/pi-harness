"""Structural wire-ledger contracts with independent literal byte counts.

References:
- https://github.com/nredd/pi-harness/issues/1004
"""

from __future__ import annotations

import json

import pytest

from harness.request_ledger import request_ledger


def test_exact_bytes_and_unknown_owner() -> None:
    """Keep unknown ownership distinct from shared text and count UTF-8 exactly."""
    raw = '{"model":"fixture","system":[{"text":"π<rules>ok</rules>!"}],"tools":[{"name":"read"}]}'
    ledger = request_ledger(raw)
    assert ledger["request_bytes"] == len(raw.encode())
    buckets = ledger["buckets"]
    assert buckets["system:rules"] == 17
    assert buckets["shared"] == 3
    assert buckets["tool:read:owner:unknown"] == 15
    assert sum(buckets.values()) == len(raw.encode())
    assert ledger == request_ledger(raw)


def test_empty_request_has_only_framing() -> None:
    """Account for even an empty body without inventing payload."""
    assert request_ledger("{}")["buckets"] == {"serialization_overhead": 2, "shared": 0}


@pytest.mark.parametrize("raw", ["[]", "null", '{"x":1,"x":2}', "{} trailing"])
def test_refuse_ambiguous_json(raw: str) -> None:
    """Invalid or duplicate-key bodies cannot have reliable attribution."""
    with pytest.raises(ValueError, match=r"JSON|Duplicate|Extra data"):
        request_ledger(raw)


def test_messages_cache_markers_hash_and_comparisons() -> None:
    """Measure original byte prefixes, never inferred provider cache behavior."""
    body = {
        "model": "fixture",
        "tools": [
            {"name": "read", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}}
        ],
        "messages": [
            {"role": "user", "content": "hello"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "private"},
                    {"type": "text", "text": "reply"},
                    {"type": "tool_use", "id": "call", "name": "read", "input": {"path": "x"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "call",
                        "content": "result",
                        "cache_control": {"type": "ephemeral"},
                    },
                    {"type": "tool_result", "tool_use_id": "missing", "content": "unknown"},
                    {"type": "image", "source": {"data": "opaque"}},
                ],
            },
        ],
    }
    raw = json.dumps(body, ensure_ascii=False)
    ledger = request_ledger(raw, owners={"read": "builtin"}, previous=raw, parent='{"model":"other"}')
    assert sum(ledger["buckets"].values()) == len(raw.encode())
    assert ledger["common_prefix_previous_bytes"] == len(raw.encode())
    assert ledger["common_prefix_parent_bytes"] == 9
    assert ledger["tool_array_sha256"] == "9c1884186834e8d0bc914b66d146685a8dfdfa57fc68c58a86dae612a7fe40a0"
    assert [marker["bytes_through_block"] for marker in ledger["cache_markers"]] == [
        raw.index('], "messages"'),
        raw.index('}, {"type": "tool_result", "tool_use_id": "missing"') + 1,
    ]
    assert set(ledger["buckets"]) >= {
        "user",
        "assistant_text",
        "thinking",
        "tool_call_args:read",
        "tool_result:read",
        "tool_result:owner:unknown",
        "shared",
    }
    assert ledger["model"] == "fixture"
    assert ledger["measurement"] == "utf8_wire_bytes"
    assert ledger["token_estimates"] is None


def test_escaped_sections_and_provenance() -> None:
    """Split only explicit tags and exact supplied provenance, not text guesses."""
    body = {
        "system": [{"text": "<rules>é\n</rules>"}],
        "messages": [
            {"role": "user", "content": "custom"},
            {"role": "user", "content": "notice"},
            {"role": "user", "content": "<subagent_context>parent</subagent_context>"},
            {
                "role": "user",
                "content": (
                    "The conversation history before this point was compacted into the following summary:"
                    "\n\n<summary>old</summary>"
                ),
            },
        ],
    }
    raw = json.dumps(body)
    ledger = request_ledger(
        raw,
        provenance={
            "custom": "extension:fixture",
            "notice": "subagent_notices",
            "<subagent_context>parent</subagent_context>": "inherited_context",
        },
    )
    buckets = ledger["buckets"]
    assert buckets["system:rules"] == len(r"<rules>\u00e9\n</rules>")
    assert set(buckets) >= {
        "extension:fixture",
        "subagent_notices",
        "inherited_context",
        "compaction_summary",
    }
    assert sum(buckets.values()) == len(raw.encode())
