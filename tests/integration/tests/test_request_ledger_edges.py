"""Wire spelling and incomplete payloads remain additive without inferred ownership.

References:
- https://github.com/nredd/pi-harness/issues/1004
"""

from __future__ import annotations

import json
from urllib.request import Request, urlopen

from harness.anthropic_mock import AnthropicMock
from harness.request_ledger import request_ledger


def test_whitespace_escaped_tags_and_unknown_payload() -> None:
    """Preserve escaped tag spelling, metadata and unknown payload bytes."""
    raw = ' \n{ "system" : "\\u003crules>hi</rules>", "extra" : [1, true, null], "messages": [] } '
    ledger = request_ledger(raw, previous="", parent=raw + " ")
    assert ledger["buckets"]["system:rules"] == 22
    assert ledger["buckets"]["shared"] == 15
    assert sum(ledger["buckets"].values()) == len(raw.encode())
    assert ledger["common_prefix_previous_bytes"] == 0
    assert ledger["common_prefix_parent_bytes"] == len(raw.encode())


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
