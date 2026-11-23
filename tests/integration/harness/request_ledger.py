"""Account for original UTF-8 JSON bytes in wire bodies and faux SDK transcripts.

Only explicit wire structure or exact caller-supplied provenance is attributed.
The wire adapter erases custom-message types; absent provenance remains shared.
Exact caller-supplied text prefixes split one text block; inherited parent context
that a subagent prepends to its own task prompt is verified and bound to that block.
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
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final, TypedDict

if TYPE_CHECKING:
    from collections.abc import Mapping

SECTION = re.compile(r"<([a-zA-Z_][a-zA-Z_0-9-]*)>(.*?)</\1>", re.DOTALL)
ESCAPE = re.compile(r"\\u[0-9a-fA-F]{4}|\\.|[^\\]", re.DOTALL)
# Bucket keys reach published JSONL, so body-derived text must match a pattern or be replaced by a hash.
SAFE_NAME = re.compile(r"[A-Za-z0-9_.-]{1,64}")
SAFE_EXTENSION = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
SAFE_OWNER = re.compile(r"[A-Za-z0-9_.:@/+-]{1,128}")
WINDOWS_DRIVE = re.compile(r"[A-Za-z]:[\\/]")
FIXED_CATEGORIES = frozenset({"shared", "user", "assistant_text", "subagent_notices", "inherited_context"})
CONTROL_FIELDS = frozenset(
    {
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
)
MESSAGE_CATEGORIES: Final[Mapping[str, str]] = MappingProxyType(
    {"assistant": "assistant_text", "user": "user"}
)
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

    Parameters:
        pairs (list[tuple[str, Any]]): decoded object entries in wire order.

    Returns:
        dict[str, Any]: unique-key object.

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

    Parameters:
        raw (str): original JSON body.

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
        """Visit one value and its descendants.

        Parameters:
            start (int): character offset before the value.
            path (tuple[str | int, ...]): structural path to the value.

        Returns:
            int: exclusive character offset after the value.
        """
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
    """Measure the literal common UTF-8 prefix.

    Parameters:
        current (bytes): original encoded request.
        other (str | None): comparator body, or no comparator.

    Returns:
        int | None: matching byte count, or None without a comparator.
    """
    if other is None:
        return None
    encoded = other.encode()
    return next(
        (index for index, pair in enumerate(zip(current, encoded, strict=False)) if pair[0] != pair[1]),
        min(len(current), len(encoded)),
    )


def _digest(value: str) -> str:
    """Return a short stable digest, tolerating lone surrogates from hostile bodies.

    Parameters:
        value (str): untrusted label text.

    Returns:
        str: first twelve hexadecimal SHA-256 characters.
    """
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:12]


def _safe(value: object, pattern: re.Pattern[str]) -> str:
    """Return `value` when it matches `pattern`, else a stable `unsafe-<digest>` label.

    Parameters:
        value (object): body-derived text, such as a tool name or tag.
        pattern (re.Pattern[str]): full-match allowlist.

    Returns:
        str: a label safe to embed in a bucket key.
    """
    text = value if isinstance(value, str) else str(value)
    return text if pattern.fullmatch(text) else f"unsafe-{_digest(text)}"


def stable_owner(source: str, root: Path) -> str:
    """Return a machine-independent owner label for a `sourceInfo.source`.

    Parameters:
        source (str): registered `sourceInfo.source`, e.g. `builtin`, `npm:pkg@1` or a checkout path.
        root (Path): repository root; paths beneath it become root-relative.

    Returns:
        str: the source, a root-relative path, or `external` for any other absolute path.
    """
    if source.startswith("/") or WINDOWS_DRIVE.match(source):
        path = Path(source)
        return path.relative_to(root).as_posix() if path.is_relative_to(root) else "external"
    return source


def _owner_label(owner: str | None) -> str:
    """Label an owner for a bucket key without leaking unsafe values.

    Parameters:
        owner (str | None): registered source label, or no known owner.

    Returns:
        str: safe label, `unknown`, or `external`.
    """
    if not owner:
        return "unknown"
    if owner.startswith("/") or WINDOWS_DRIVE.match(owner):
        return "external"
    return _safe(owner, SAFE_OWNER)


def _categories(provenance: dict[str, str], *, name: str = "provenance") -> dict[str, str]:
    """Validate caller provenance and sanitize extension custom types.

    Parameters:
        provenance (dict[str, str]): exact message text, or a text prefix, mapped to known categories.
        name (str): argument name for error messages.

    Returns:
        dict[str, str]: validated categories with safe extension labels.

    Raises:
        ValueError: a category is neither fixed nor `extension:<customType>`.
    """
    result: dict[str, str] = {}
    for text, category in provenance.items():
        if category in FIXED_CATEGORIES:
            result[text] = category
        elif category.startswith("extension:") and len(category) > len("extension:"):
            result[text] = "extension:" + _safe(category.removeprefix("extension:"), SAFE_EXTENSION)
        else:
            raise ValueError(f"Invalid `{name}` category")
    return result


def _utf16_units(text: str) -> int:
    """Count UTF-16 code units, so lone surrogates and escaped pairs measure alike.

    Parameters:
        text (str): decoded text, possibly holding lone surrogates.

    Returns:
        int: UTF-16 code units.
    """
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


class SpanCollector:
    """Charge disjoint, in-bounds spans of one body; the remainder is serialization overhead.

    Attributes:
        raw (str): the original body.
    """

    def __init__(self, raw: str) -> None:
        """Start with no charges and an always-present `shared` bucket.

        Parameters:
            raw (str): original body text.
        """
        self.raw = raw
        self._spans: list[tuple[int, int, str]] = []
        self._buckets: dict[str, int] = {"shared": 0}

    def add(self, bucket: str, start: int, end: int) -> None:
        """Charge the characters `raw[start:end]` to `bucket`.

        Parameters:
            bucket (str): destination bucket key.
            start (int): inclusive character offset.
            end (int): exclusive character offset.

        Raises:
            ValueError: the span is reversed or outside the body, or `bucket` is the reserved
                `serialization_overhead`.
        """
        if bucket == "serialization_overhead":
            raise ValueError("`serialization_overhead` is the residual and cannot be charged")
        if not 0 <= start <= end <= len(self.raw):
            raise ValueError(f"Span out of bounds: {start}..{end} of {len(self.raw)}")
        if start == end:
            return
        self._spans.append((start, end, bucket))
        self._buckets[bucket] = self._buckets.get(bucket, 0) + len(self.raw[start:end].encode())

    def finish(self) -> dict[str, int]:
        """Verify disjointness and add the residual `serialization_overhead`.

        Returns:
            dict[str, int]: sorted buckets summing exactly to the body's UTF-8 size.

        Raises:
            ValueError: two spans overlap.
        """
        cursor = 0
        for start, end, bucket in sorted(self._spans):
            if start < cursor:
                raise ValueError(f"Overlapping spans: '{bucket}' starts at {start} before {cursor}")
            cursor = end
        # Disjoint, in-bounds spans cannot charge more bytes than the body holds, so this is >= 0.
        overhead = len(self.raw.encode()) - sum(self._buckets.values())
        return dict(sorted((self._buckets | {"serialization_overhead": overhead}).items()))


class _Attributor:
    """Walk a parsed request and charge each component to a bucket."""

    def __init__(
        self,
        nodes: dict[tuple[str | int, ...], _Node],
        raw: str,
        owners: dict[str, str],
        provenance: dict[str, str],
        prefixes: dict[str, str],
        *,
        inherited: InheritedContext | None = None,
    ) -> None:
        """Bind the indexed body and attribution inputs.

        Parameters:
            nodes (dict[tuple[str | int, ...], _Node]): structural path -> span.
            raw (str): original body.
            owners (dict[str, str]): tool name -> owner label.
            provenance (dict[str, str]): validated exact text -> category.
            prefixes (dict[str, str]): validated exact text prefix -> category, longest first.
            inherited (InheritedContext | None): verified parent context, re-verified against this body.
        """
        self.nodes = nodes
        self.raw = raw
        self.owners = owners
        self.provenance = provenance
        self.prefixes = dict(sorted(prefixes.items(), key=lambda item: -len(item[0])))
        self.inherited = inherited
        self.collector = SpanCollector(raw)
        self.calls: dict[str, str] = {}

    def claim(self, path: tuple[str | int, ...], bucket: str) -> None:
        """Charge an indivisible serialized value if present.

        Parameters:
            path (tuple[str | int, ...]): structural path to the value.
            bucket (str): destination bucket key.

        Returns:
            None: charges the collector in place.
        """
        node = self.nodes.get(path)
        if node is not None:
            self.collector.add(bucket, node.start, node.end)

    def tool_bucket(self, name: object) -> str:
        """Return the schema bucket for a tool, with its registered owner.

        Parameters:
            name (object): body-derived tool name.

        Returns:
            str: safe tool-and-owner bucket key.
        """
        return f"tool:{_safe(name, SAFE_NAME)}:owner:{_owner_label(self.owners.get(str(name)))}"

    def text(
        self,
        path: tuple[str | int, ...],
        category: str,
        *,
        system: bool = False,
        prefix: tuple[str, str] | None = None,
    ) -> None:
        """Charge escaped string payload, splitting an exact leading prefix and explicit XML sections.

        Parameters:
            path (tuple[str | int, ...]): structural path to the string value.
            category (str): destination for text outside tagged system sections.
            system (bool): attribute explicit tags as system sections.
            prefix (tuple[str, str] | None): decoded leading text the value starts with, and its category.

        Returns:
            None: charges the collector in place.
        """
        node = self.nodes[path]
        if not isinstance(node.value, str):
            self.claim(path, "shared")
            return
        payload = self.raw[node.start + 1 : node.end - 1]
        # Decode each escape independently to map decoded characters back to wire
        # spans. Surrogate pairs are kept together by the original wire spelling;
        # section tags are ASCII and cannot split a pair.
        escapes = [match.group() for match in ESCAPE.finditer(payload)]
        offsets = [node.start + 1]
        for escape in escapes:
            offsets.append(offsets[-1] + len(escape))
        units = [json.loads(f'"{e}"') if e.startswith("\\") else e for e in escapes]
        decoded = "".join(units)
        cursor = 0
        if prefix is not None:
            # The caller checked `value.startswith(text)` on the decoded value, so the prefix ends on a
            # unit boundary: an escaped surrogate pair is two units, a literal one is one.
            remaining = _utf16_units(prefix[0])
            while remaining > 0:
                remaining -= _utf16_units(units[cursor])
                cursor += 1
            self.collector.add(prefix[1], offsets[0], offsets[cursor])
        for match in SECTION.finditer(decoded, cursor):
            self.collector.add(category, offsets[cursor], offsets[match.start()])
            tag = _safe(match[1], SAFE_NAME)
            self.collector.add(
                f"system:{tag}" if system else category, offsets[match.start()], offsets[match.end()]
            )
            cursor = match.end()
        self.collector.add(category, offsets[cursor], node.end - 1)

    def system(self, body: dict[str, Any]) -> None:
        """Attribute the system prompt, string or text blocks.

        Parameters:
            body (dict[str, Any]): decoded request object.

        Returns:
            None: charges the collector in place.
        """
        system = body.get("system", [])
        if isinstance(system, str):
            self.text(("system",), "shared", system=True)
            return
        for index, block in enumerate(system):
            if "text" in block:
                self.text(("system", index, "text"), "shared", system=True)

    def tools(self, body: dict[str, Any]) -> None:
        """Attribute each top-level tool schema to its registered owner.

        Parameters:
            body (dict[str, Any]): decoded request object.

        Returns:
            None: charges the collector in place.
        """
        for index, tool in enumerate(body.get("tools", [])):
            self.claim(("tools", index), self.tool_bucket(tool.get("name", "unknown")))

    def messages(self, body: dict[str, Any]) -> None:
        """Attribute message components by wire role, tool identity and exact provenance.

        Parameters:
            body (dict[str, Any]): decoded request object.

        Returns:
            None: records tool identities and charges the collector in place.
        """
        self.calls = {
            block["id"]: block["name"]
            for message in body.get("messages", [])
            for block in message.get("content", [])
            if isinstance(block, dict) and block.get("type") == "tool_use"
        }
        for index, message in enumerate(body.get("messages", [])):
            path: tuple[str | int, ...] = ("messages", index, "content")
            content = message.get("content", [])
            role = message.get("role")
            category = MESSAGE_CATEGORIES.get(role, "shared")
            blocks: list[tuple[tuple[str | int, ...], dict[str, Any]]] = (
                [(path, {"type": "text", "text": content})]
                if isinstance(content, str)
                else [((*path, number), block) for number, block in enumerate(content)]
            )
            for block_path, block in blocks:
                self.block(block_path, block, isinstance(content, str), category, role == "system")

    def sdk_messages(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        """Attribute a public SDK transcript, where system messages declare tools.

        Parameters:
            body (dict[str, Any]): serialized model id and faux factory `TranscriptContext`.

        Returns:
            list[dict[str, Any]]: ordered tool declarations, including mid-session additions.
        """
        tools: list[dict[str, Any]] = []
        for index, message in enumerate(body["messages"]):
            path = ("messages", index)
            role = message["role"]
            if role == "toolResult":
                self.claim((*path, "content"), f"tool_result:{_safe(message['toolName'], SAFE_NAME)}")
                continue
            if role == "system":
                for number, tool in enumerate(message.get("toolsAdded", [])):
                    tools.append(tool)
                    self.claim((*path, "toolsAdded", number), self.tool_bucket(tool["name"]))
                for name, text in message.get("sections", {}).items():
                    if text is not None:
                        self.text((*path, "sections", name), f"system:{_safe(name, SAFE_NAME)}")
            category = MESSAGE_CATEGORIES.get(role, "shared")
            content_path = (*path, "content")
            content = message["content"]
            if isinstance(content, str):
                self.block(content_path, {"type": "text", "text": content}, True, category, role == "system")
                continue
            for number, block in enumerate(content):
                block_path = (*content_path, number)
                if block["type"] == "toolCall":
                    self.claim(
                        (*block_path, "arguments"), f"tool_call_args:{_safe(block['name'], SAFE_NAME)}"
                    )
                elif block["type"] == "thinking":
                    for field in ("thinking", "thinkingSignature"):
                        self.claim((*block_path, field), "thinking")
                else:
                    self.block(block_path, block, False, category, role == "system")
        return tools

    def block(
        self,
        path: tuple[str | int, ...],
        block: dict[str, Any],
        bare: bool,
        category: str,
        system: bool,
    ) -> None:
        """Attribute one content block.

        Parameters:
            path (tuple[str | int, ...]): block (or bare string content) path.
            block (dict[str, Any]): the block, or a synthetic text block for string content.
            bare (bool): content was a bare string, so `path` is the text itself.
            category (str): role-derived default bucket.
            system (bool): message is a native system delta.
        """
        kind = block.get("type")
        if kind == "text":
            value = block.get("text", "")
            default = "compaction_summary" if value.startswith(SUMMARY_PREFIX) else category
            exact = self.provenance.get(value)
            bound = self.inherited
            if bound is not None and bound.path == path:
                self.text(
                    path if bare else (*path, "text"),
                    default,
                    system=system,
                    prefix=(bound.context, "inherited_context"),
                )
                return
            prefix = (
                None
                if exact is not None
                else next(
                    (
                        (text, prefix_category)
                        for text, prefix_category in self.prefixes.items()
                        if value.startswith(text)
                    ),
                    None,
                )
            )
            self.text(path if bare else (*path, "text"), exact or default, system=system, prefix=prefix)
        elif kind in {"thinking", "redacted_thinking"}:
            for field in ("thinking", "signature", "data"):
                self.claim((*path, field), "thinking")
        elif kind == "tool_addition":
            self.claim((*path, "tool", "definition"), self.tool_bucket(block["tool"]["definition"]["name"]))
        elif kind == "tool_use":
            self.claim((*path, "input"), f"tool_call_args:{_safe(block['name'], SAFE_NAME)}")
        elif kind == "tool_result":
            name = self.calls.get(block.get("tool_use_id", ""))
            label = "owner:unknown" if name is None else _safe(name, SAFE_NAME)
            self.claim((*path, "content"), f"tool_result:{label}")
        else:
            self.claim(path, "shared")


@dataclass(frozen=True)
class InheritedContext:
    """Verified parent context bound to the one child text block that carries it.

    Attributes:
        path (tuple[str | int, ...]): structural path of that block, or of bare string content.
        context (str): exact rendered parent context, charged to `inherited_context`.
        prompt (str): exact task prompt that follows `context` with no separator.
    """

    path: tuple[str | int, ...]
    context: str
    prompt: str


def inherited_prefix(raw: str, context: str, prompt: str) -> InheritedContext:
    """Bind independently observed parent context to the child block that must equal it plus the task.

    `inherit_context` renders the parent history (`buildParentContext` in
    `packages/subagents/src/context.ts`, ending `# Your Task (below)\\n`) and appends the task prompt
    with no separator. The caller renders `context` from what it observed on the parent's request and
    knows `prompt`, so the child's first user text block must be exactly `context + prompt`; a merely
    matching suffix proves nothing.

    Parameters:
        raw (str): the child's first recorded request body.
        context (str): exact rendered parent context the caller observed, not read from `raw`.
        prompt (str): exact task prompt the caller passed to the child.

    Returns:
        InheritedContext: the verified block path and texts, for `request_ledger(inherited=...)`.

    Raises:
        ValueError: `context` or `prompt` is empty, or the first user message's first text is not
            exactly `context + prompt`, e.g. no user message, a non-text first block, a shared suffix
            without that context or extra text around it.
    """
    messages = json.loads(raw).get("messages", [])
    index, content = next(
        (
            (number, message.get("content"))
            for number, message in enumerate(messages)
            if message.get("role") == "user"
        ),
        (0, None),
    )
    path: tuple[str | int, ...] = ("messages", index, "content")
    if (
        isinstance(content, list)
        and content
        and isinstance(content[0], dict)
        and content[0].get("type") == "text"
    ):
        path, content = (*path, 0), content[0].get("text")
    if not context or not prompt or content != context + prompt:
        raise ValueError("Child first user text is not the observed parent context then the task prompt")
    return InheritedContext(path, context, prompt)


def request_ledger(
    raw: str,
    *,
    owners: dict[str, str] | None = None,
    provenance: dict[str, str] | None = None,
    prefixes: dict[str, str] | None = None,
    inherited: InheritedContext | None = None,
    previous: str | None = None,
    parent: str | None = None,
    sdk: bool = False,
) -> Ledger:
    """Partition one recorded request without mutation, I/O or provider usage.

    Parameters:
        raw (str): exact UTF-8 JSON body, not a reserialization of parsed data.
        owners (dict[str, str] | None): registered tool name -> owner label, see `stable_owner`.
        provenance (dict[str, str] | None): exact message text -> known category;
            extension:<customType> and subagent_notices must come from an observer,
            never inferred from arbitrary natural language.
        prefixes (dict[str, str] | None): exact leading text of a message-content text block ->
            known category, the rest of the block keeping its default; exact `provenance` wins and
            the longest prefix applies. Top-level `system` blocks and SDK `sections` never match;
            tagged sections in a native system delta's remainder keep their own buckets.
        inherited (InheritedContext | None): verified parent context from `inherited_prefix`, charged
            to `inherited_context` in its bound block only; other blocks never match it.
        previous (str | None): preceding recorded request, original body.
        parent (str | None): spawning parent's request, original body.
        sdk (bool): account for a faux factory transcript instead of an Anthropic wire body.

    Returns:
        Ledger: additive bytes, tool-array hash, literal prefix and marker offsets.

    Raises:
        ValueError: invalid, non-object or duplicate-key JSON, an invalid provenance or prefix
            category, an empty prefix text, an `inherited` binding whose context and prompt are not
            this body's first user text or whose block path differs, or spans that are out of
            bounds or overlap.
        KeyError: a required structural field is missing, such as SDK `messages` or message `content`.
        UnicodeError: the body cannot be represented as UTF-8.
    """
    if inherited is not None and inherited_prefix(raw, inherited.context, inherited.prompt) != inherited:
        raise ValueError("`inherited` is bound to another block")
    categories = _categories(provenance or {})
    if "" in (prefixes or {}):
        raise ValueError("Empty `prefixes` text would match every block")
    leading = _categories(prefixes or {}, name="prefixes")
    nodes = _nodes(raw)
    body = nodes[()].value
    encoded = raw.encode()
    attributor = _Attributor(nodes, raw, owners or {}, categories, leading, inherited=inherited)
    if sdk:
        tools = attributor.sdk_messages(body)
    else:
        attributor.tools(body)
        attributor.system(body)
        attributor.messages(body)
        tools = body.get("tools", [])
    for key in body.keys() - {"system", "tools", "messages"} - CONTROL_FIELDS:
        attributor.claim((key,), "shared")
    markers: list[CacheMarker] = [
        {"path": list(path), "bytes_through_block": len(raw[: node.end].encode())}
        for path, node in nodes.items()
        if (
            not sdk
            and isinstance(node.value, dict)
            and "cache_control" in node.value
            and (
                (path[:1] in {("system",), ("tools",)} and len(path) == 2)
                or (path[:1] == ("messages",) and len(path) == 4 and path[2] == "content")
            )
        )
    ]
    return {
        "measurement": "utf8_sdk_context_bytes" if sdk else "utf8_wire_bytes",
        "request_bytes": len(encoded),
        "model": body.get("model"),
        "buckets": attributor.collector.finish(),
        "tool_array_sha256": hashlib.sha256(
            json.dumps(tools, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
                "utf-8", "surrogatepass"
            )
        ).hexdigest(),
        "cache_markers": markers,
        "common_prefix_previous_bytes": _prefix(encoded, previous),
        "common_prefix_parent_bytes": _prefix(encoded, parent),
        "token_estimates": None,
    }
