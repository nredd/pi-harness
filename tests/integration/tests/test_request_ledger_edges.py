"""Wire-ledger edge cases: escaping, provenance, markers, prefixes, safety and span integrity.

References:
- https://github.com/nredd/pi-harness/issues/1004
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

from harness.anthropic_mock import AnthropicMock
from harness.request_ledger import SpanCollector, request_ledger, stable_owner


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
    assert request_ledger(raw, previous="")["common_prefix_previous_bytes"] == 0


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


def test_nontext_system_and_missing_result() -> None:
    """Unknown nontext values stay shared; absent fields claim no phantom bytes."""
    raw = json.dumps(
        {
            "system": [{"type": "text", "text": 123}, {"type": "future"}],
            "messages": [
                {"role": "user", "content": [{"type": "tool_result"}]},
            ],
        }
    )
    ledger = request_ledger(raw)
    assert ledger["buckets"]["shared"] == 3
    assert sum(ledger["buckets"].values()) == len(raw.encode())


def test_scripted_tool_sse_preserves_raw_request() -> None:
    """The loopback recorder retains exact bytes and scripts one real tool-use stream."""
    raw = b'{ "model" : "fixture", "messages" : [] }'
    with AnthropicMock(message_tools=[{"name": "Agent", "input": {"subagent_type": "Explore"}}]) as mock:
        request = Request(mock.url + "/v1/messages", data=raw, headers={"content-type": "application/json"})
        with urlopen(request, timeout=5) as response:
            stream = response.read().decode()
        assert '"type": "tool_use"' in stream
        assert '"stop_reason": "tool_use"' in stream
        assert '"partial_json"' in stream
        assert mock.messages[0].raw_body.encode() == raw
        assert mock.messages[0].body == {"model": "fixture", "messages": []}
        assert mock.message_tools == []
        with urlopen(request, timeout=5) as response:
            plain = response.read().decode()
        assert '"text": "MOCK ANTHROPIC OK"' in plain
        assert len(mock.messages) == 2


def test_spans_must_be_in_bounds_and_disjoint() -> None:
    """Overlapping or out-of-bounds charges are refused, so the exact sum is not a residual artifact."""
    raw = '{"a":"bc"}'
    for start, end in [(-1, 2), (3, 2), (0, len(raw) + 1)]:
        with pytest.raises(ValueError, match="out of bounds"):
            SpanCollector(raw).add("x", start, end)
    with pytest.raises(ValueError, match="residual"):
        SpanCollector(raw).add("serialization_overhead", 0, 1)
    overlapping = SpanCollector(raw)
    overlapping.add("x", 0, 5)
    overlapping.add("y", 4, 8)
    with pytest.raises(ValueError, match="Overlapping spans"):
        overlapping.finish()
    adjacent = SpanCollector(raw)
    adjacent.add("x", 0, 5)
    adjacent.add("y", 5, 5)
    adjacent.add("z", 5, 8)
    buckets = adjacent.finish()
    assert buckets == {"serialization_overhead": 2, "shared": 0, "x": 5, "z": 3}
    assert buckets["serialization_overhead"] >= 0
    assert sum(buckets.values()) == len(raw.encode())


def test_unicode_charge_is_counted_in_bytes_not_characters() -> None:
    """A non-ASCII span adds its UTF-8 size, and overhead stays the exact remainder."""
    raw = '{"a":"é"}'
    collector = SpanCollector(raw)
    collector.add("x", 5, 8)
    assert collector.finish() == {"serialization_overhead": 6, "shared": 0, "x": 4}


def test_published_owner_labels_are_machine_independent() -> None:
    """Checkout paths become root-relative; foreign absolute paths and hostile owners never leak."""
    root = Path("/work/checkout")
    assert stable_owner("/work/checkout/packages/subagents", root) == "packages/subagents"
    assert stable_owner("/home/someone/elsewhere/pkg", root) == "external"
    assert stable_owner("C:/Users/someone/pkg", root) == "external"
    assert stable_owner("npm:pi-web-access@0.43.0", root) == "npm:pi-web-access@0.43.0"
    assert stable_owner("builtin", root) == "builtin"
    raw = json.dumps({"tools": [{"name": "a"}, {"name": "b"}, {"name": "c"}, {"name": "d"}]})
    owners = {
        "a": "/work/checkout/packages/x",
        "b": "C:/Users/someone/pkg",
        "c": "evil\nowner\x00",
        "d": "packages/x",
    }
    buckets = request_ledger(raw, owners=owners)["buckets"]
    keys = sorted(key for key in buckets if key.startswith("tool:"))
    assert keys[0] == "tool:a:owner:external"
    assert keys[1] == "tool:b:owner:external"
    assert keys[2].startswith("tool:c:owner:unsafe-")
    assert keys[3] == "tool:d:owner:packages/x"
    assert "/work" not in "".join(buckets)


def test_hostile_names_never_become_raw_bucket_keys() -> None:
    """Tool, tag, call and custom-type text from the body is allowlisted or hashed."""
    hostile = 'x"}\n{"y":1} \ud800 ' + "z" * 200
    body = {
        "system": [{"text": f"<{'t' * 80}>text</{'t' * 80}>"}],
        "tools": [{"name": hostile}, {"name": 7}, {"description": "unnamed"}],
        "messages": [
            {"role": "assistant", "content": [{"type": "tool_use", "id": "h", "name": hostile, "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "h", "content": "r"}]},
        ],
    }
    raw = json.dumps(body)
    buckets = request_ledger(raw, owners={hostile: "builtin"}, provenance={"hi": "extension:a b\nc"})[
        "buckets"
    ]
    assert sum(buckets.values()) == len(raw.encode())
    for key in buckets:
        assert len(key) < 120
        assert all(char.isalnum() or char in "_.:@/+-" for char in key), key
    assert any(key.startswith("tool:unsafe-") and key.endswith(":owner:builtin") for key in buckets)
    assert "tool:7:owner:unknown" in buckets
    assert "tool:unknown:owner:unknown" in buckets
    assert any(key.startswith("tool_call_args:unsafe-") for key in buckets)
    assert any(key.startswith("tool_result:unsafe-") for key in buckets)
    assert any(key.startswith("system:unsafe-") for key in buckets)


def test_extension_custom_types_are_sanitized() -> None:
    """A colon-bearing custom type is kept; whitespace or control characters are hashed."""
    raw = json.dumps({"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]})
    provenance = {"a": "extension:pi-plan-mode:plan-approved", "b": "extension:bad type\n"}
    buckets = request_ledger(raw, provenance=provenance)["buckets"]
    assert buckets["extension:pi-plan-mode:plan-approved"] == 1
    assert any(key.startswith("extension:unsafe-") for key in buckets)
