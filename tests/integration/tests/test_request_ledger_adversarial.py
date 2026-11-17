"""Wire-ledger regression cases for escaping, provenance and prefix boundaries.

References:
- https://github.com/nredd/pi-harness/issues/1004
"""

from __future__ import annotations

import json

import pytest

from harness.request_ledger import request_ledger


def test_only_provider_block_locations_are_cache_markers() -> None:
    """A tool argument/property named cache_control is not an API cache marker."""
    raw = json.dumps(
        {
            "cache_control": {"type": "ephemeral"},
            "system": [{"text": "system", "cache_control": {"type": "ephemeral"}}],
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "call",
                            "name": "fixture",
                            "input": {"cache_control": {"type": "ephemeral"}},
                        }
                    ],
                }
            ],
        }
    )
    ledger = request_ledger(raw)
    assert [marker["path"] for marker in ledger["cache_markers"]] == [["system", 0]]
    assert sum(ledger["buckets"].values()) == len(raw.encode())


def test_native_system_deltas_and_opaque_thinking() -> None:
    """Native tool additions and system deltas retain their structural ownership."""
    body = {
        "messages": [
            {
                "role": "system",
                "content": [
                    {"type": "text", "text": "<rules>delta</rules>"},
                    {
                        "type": "tool_addition",
                        "tool": {"type": "tool_definition", "definition": {"name": "late"}},
                    },
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "think", "signature": "sig"},
                    {"type": "redacted_thinking", "data": "opaque"},
                ],
            },
        ]
    }
    raw = json.dumps(body)
    ledger = request_ledger(raw, owners={"late": "fixture"})
    assert ledger["buckets"]["system:rules"] == 20
    assert ledger["buckets"]["tool:late:owner:fixture"] == 16
    assert ledger["buckets"]["thinking"] == 20
    assert sum(ledger["buckets"].values()) == len(raw.encode())


def test_whitespace_surrogates_and_escaped_tag_spelling() -> None:
    """Charge original escapes, not a decoded-text reserialization."""
    raw = ' \n{ "system" : "\\ud83e\\udda9\\u003crules>é</rules>\\n", "future" : [1, true, null] }\n'
    ledger = request_ledger(raw)
    assert ledger["buckets"]["system:rules"] == 22
    assert ledger["buckets"]["shared"] == 29
    assert sum(ledger["buckets"].values()) == len(raw.encode())


def test_tool_array_hash_is_canonical_but_array_order_matters() -> None:
    """Ignore key order/whitespace, but never sort the actual tools array."""
    original = request_ledger('{"tools":[{"name":"a","description":"x"},{"name":"b"}]}')
    reordered_keys = request_ledger('{ "tools" : [ {"description":"x","name":"a"},{"name":"b"} ]}')
    reordered_tools = request_ledger('{"tools":[{"name":"b"},{"name":"a","description":"x"}]}')
    assert original["tool_array_sha256"] == reordered_keys["tool_array_sha256"]
    assert original["tool_array_sha256"] != reordered_tools["tool_array_sha256"]


def test_literal_prefix_is_in_bytes_and_handles_shorter_comparator() -> None:
    """A common Unicode prefix counts UTF-8 bytes, even if the comparator ends there."""
    raw = '{"x":"é"}'
    ledger = request_ledger(raw, previous=raw[:-1], parent=raw + " ")
    assert ledger["common_prefix_previous_bytes"] == 9
    assert ledger["common_prefix_parent_bytes"] == 10


@pytest.mark.parametrize("category", ["serialization_overhead", "extension:", "arbitrary"])
def test_reserved_or_unknown_provenance_is_refused(category: str) -> None:
    """Never let caller labels collide with the framing bucket or fabricate categories."""
    with pytest.raises(ValueError, match="Invalid `provenance` category"):
        request_ledger('{"messages":[]}', provenance={"text": category})


def test_unmarked_text_cannot_be_guessed_to_be_an_extension() -> None:
    """Prose resembling a notice stays a wire-role message without explicit provenance."""
    raw = json.dumps({"messages": [{"role": "user", "content": "subagent-notification"}]})
    buckets = request_ledger(raw)["buckets"]
    assert buckets["user"] == 21
    assert "subagent_notices" not in buckets
