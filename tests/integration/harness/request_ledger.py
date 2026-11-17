"""Pure accounting of original UTF-8 JSON request bytes, not tokens or spend.

Only explicit wire structure or exact caller-supplied provenance is attributed.
The wire adapter erases custom-message types; absent provenance remains shared.
JSON envelope syntax and control fields are serialization overhead. Tool objects,
call arguments and result values are indivisible serialized components, including
their internal syntax. XML sections count their escaped contents and tags, not
 their enclosing JSON quotes. No tokenizer vocabulary is bundled or downloaded.

References:
- https://github.com/nredd/pi-harness/issues/1004
- https://docs.anthropic.com/en/api/messages
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypedDict

if TYPE_CHECKING:
    from collections.abc import Callable

SECTION = re.compile(r"<([a-zA-Z_][a-zA-Z_0-9-]*)>(.*?)</\1>", re.DOTALL)
ESCAPE = re.compile(r"\\u[0-9a-fA-F]{4}|\\.|[^\\]", re.DOTALL)
SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:"


class CacheMarker(TypedDict):
    """Location of a cache-control block in original JSON serialization."""

    path: list[str | int]
    bytes_through_block: int


class Ledger(TypedDict):
    """One deterministic JSON-line-compatible structural measurement."""

    measurement: str
    request_bytes: int
    model: str | None
    buckets: dict[str, int]
    tool_array_sha256: str
    cache_markers: list[CacheMarker]
    common_prefix_previous_bytes: int | None
    common_prefix_parent_bytes: int | None
    token_estimates: None


@dataclass(frozen=True)
class _Node:
    """Decoded value and its half-open original character span."""

    value: Any
    start: int
    end: int


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Refuse duplicate keys rather than silently losing structural evidence.

    Raises:
        ValueError: an object repeats a key.
    """
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: '{key}'")
        result[key] = value
    return result


def _nodes(raw: str) -> dict[tuple[str | int, ...], _Node]:
    """Index validated JSON spans using the standard decoder, preserving whitespace.

    Returns:
        dict[tuple[str | int, ...], _Node]: nodes indexed by structural path.

    Raises:
        ValueError: the body is not a unique-key JSON object.
    """
    decoder = json.JSONDecoder(object_pairs_hook=_unique)
    body = json.loads(raw, object_pairs_hook=_unique)
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")
    result: dict[tuple[str | int, ...], _Node] = {}

    def visit(start: int, path: tuple[str | int, ...]) -> int:
        """Visit one value and its descendants, returning its exclusive end."""
        while raw[start].isspace():
            start += 1
        value, end = decoder.raw_decode(raw, start)
        result[path] = _Node(value, start, end)
        cursor = start + 1
        if isinstance(value, (dict, list)):
            keys = value if isinstance(value, dict) else range(len(value))
            for key in keys:
                while raw[cursor].isspace() or raw[cursor] == ",":
                    cursor += 1
                if isinstance(value, dict):
                    _, cursor = decoder.raw_decode(raw, cursor)
                    while raw[cursor].isspace() or raw[cursor] == ":":
                        cursor += 1
                cursor = visit(cursor, (*path, key))
        return end

    visit(0, ())
    return result


def _prefix(current: bytes, other: str | None) -> int | None:
    """Return literal common UTF-8 prefix length, or None without a comparator."""
    if other is None:
        return None
    encoded = other.encode()
    return next(
        (index for index, pair in enumerate(zip(current, encoded, strict=False)) if pair[0] != pair[1]),
        min(len(current), len(encoded)),
    )


def request_ledger(
    raw: str,
    *,
    owners: dict[str, str] | None = None,
    provenance: dict[str, str] | None = None,
    previous: str | None = None,
    parent: str | None = None,
) -> Ledger:
    """Partition one recorded request without mutation, I/O or provider usage.

    Parameters:
        raw (str): exact UTF-8 JSON body, not a reserialization of parsed data.
        owners (dict[str, str] | None): registered tool name -> sourceInfo owner.
        provenance (dict[str, str] | None): exact message text -> known category;
            extension:<customType> and subagent_notices must come from an observer,
            never inferred from arbitrary natural language.
        previous (str | None): preceding recorded request, original body.
        parent (str | None): spawning parent's request, original body.

    Returns:
        Ledger: additive bytes, tool-array hash, literal prefix and marker offsets.

    Raises:
        ValueError: invalid, non-object or duplicate-key JSON.
        UnicodeError: the body cannot be represented as UTF-8.
    """
    if provenance and any(
        category not in {"shared", "user", "assistant_text", "subagent_notices", "inherited_context"}
        and not (category.startswith("extension:") and len(category) > len("extension:"))
        for category in provenance.values()
    ):
        raise ValueError("Invalid `provenance` category")
    nodes = _nodes(raw)
    body = nodes[()].value
    encoded = raw.encode()
    buckets: dict[str, int] = {"shared": 0}
    owners = owners or {}
    provenance = provenance or {}

    def add(bucket: str, start: int, end: int) -> None:
        """Charge one disjoint original span to its bucket."""
        buckets[bucket] = buckets.get(bucket, 0) + len(raw[start:end].encode())

    def claim(path: tuple[str | int, ...], bucket: str) -> None:
        """Charge an indivisible serialized value if present."""
        node = nodes.get(path)
        if node is not None:
            add(bucket, node.start, node.end)

    def text(path: tuple[str | int, ...], category: str, system: bool = False) -> None:
        """Charge escaped string payload, splitting explicit XML sections only."""
        node = nodes[path]
        if not isinstance(node.value, str):
            claim(path, "shared")
            return
        payload = raw[node.start + 1 : node.end - 1]
        # Decode each escape independently to map decoded characters back to wire
        # spans. Surrogate pairs are kept together by the original wire spelling;
        # section tags are ASCII and cannot split a pair.
        offsets = [node.start + 1]
        for match in ESCAPE.finditer(payload):
            offsets.append(node.start + 1 + match.end())
        decoded = "".join(
            json.loads('"' + match.group() + '"') if match.group().startswith("\\") else match.group()
            for match in ESCAPE.finditer(payload)
        )
        cursor = 0
        for match in SECTION.finditer(decoded):
            add(category, offsets[cursor], offsets[match.start()])
            tag = match[1]
            bucket = f"system:{tag}" if system else category
            add(bucket, offsets[match.start()], offsets[match.end()])
            cursor = match.end()
        add(category, offsets[cursor], node.end - 1)

    tools = body.get("tools", [])
    for index, tool in enumerate(tools):
        name = str(tool.get("name", "unknown"))
        claim(("tools", index), f"tool:{name}:owner:{owners.get(name) or 'unknown'}")
    system = body.get("system", [])
    if isinstance(system, str):
        text(("system",), "shared", system=True)
    else:
        for index, block in enumerate(system):
            if "text" in block:
                text(("system", index, "text"), "shared", system=True)
    _messages(body, provenance, owners, text, claim)
    control = {
        "model",
        "max_tokens",
        "stream",
        "temperature",
        "thinking",
        "metadata",
        "top_p",
        "top_k",
        "stop_sequences",
    }
    for key in body.keys() - {"system", "tools", "messages"} - control:
        claim((key,), "shared")
    markers: list[CacheMarker] = [
        {"path": list(path), "bytes_through_block": len(raw[: node.end].encode())}
        for path, node in nodes.items()
        if (
            isinstance(node.value, dict)
            and "cache_control" in node.value
            and (
                (path[:1] in {("system",), ("tools",)} and len(path) == 2)
                or (path[:1] == ("messages",) and len(path) == 4 and path[2] == "content")
            )
        )
    ]
    buckets["serialization_overhead"] = len(encoded) - sum(buckets.values())
    return {
        "measurement": "utf8_wire_bytes",
        "request_bytes": len(encoded),
        "model": body.get("model"),
        "buckets": dict(sorted(buckets.items())),
        "tool_array_sha256": hashlib.sha256(
            json.dumps(tools, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "cache_markers": markers,
        "common_prefix_previous_bytes": _prefix(encoded, previous),
        "common_prefix_parent_bytes": _prefix(encoded, parent),
        "token_estimates": None,
    }


def _messages(
    body: dict[str, Any],
    provenance: dict[str, str],
    owners: dict[str, str],
    text: Callable[[tuple[str | int, ...], str, bool], None],
    claim: Callable[[tuple[str | int, ...], str], None],
) -> None:
    """Attribute message components by wire role, tool identity and exact provenance."""
    calls = {
        block["id"]: block["name"]
        for message in body.get("messages", [])
        for block in message.get("content", [])
        if isinstance(block, dict) and block.get("type") == "tool_use"
    }
    for index, message in enumerate(body.get("messages", [])):
        path: tuple[str | int, ...] = ("messages", index, "content")
        content = message.get("content", [])
        role = message.get("role")
        category = {"assistant": "assistant_text", "user": "user"}.get(role, "shared")
        blocks: list[tuple[tuple[str | int, ...], dict[str, Any]]] = (
            [(path, {"type": "text", "text": content})]
            if isinstance(content, str)
            else [((*path, block_index), block) for block_index, block in enumerate(content)]
        )
        for block_path, block in blocks:
            kind = block.get("type")
            if kind == "text":
                value = block.get("text", "")
                bucket = provenance.get(
                    value, "compaction_summary" if value.startswith(SUMMARY_PREFIX) else category
                )
                text(
                    block_path if isinstance(content, str) else (*block_path, "text"),
                    bucket,
                    role == "system",
                )
            elif kind == "thinking":
                claim((*block_path, "thinking"), "thinking")
                claim((*block_path, "signature"), "thinking")
            elif kind == "redacted_thinking":
                claim((*block_path, "data"), "thinking")
            elif kind == "tool_addition":
                name = block["tool"]["definition"]["name"]
                claim(
                    (*block_path, "tool", "definition"), f"tool:{name}:owner:{owners.get(name) or 'unknown'}"
                )
            elif kind == "tool_use":
                claim((*block_path, "input"), f"tool_call_args:{block['name']}")
            elif kind == "tool_result":
                claim(
                    (*block_path, "content"),
                    f"tool_result:{calls.get(block.get('tool_use_id'), 'owner:unknown')}",
                )
            else:
                claim(block_path, "shared")
