"""Parse native Pi, Claude, and Codex session token accounting.

References:
- https://docs.anthropic.com/en/api/messages
- https://platform.openai.com/docs/api-reference/responses
- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
- https://docs.anthropic.com/en/docs/claude-code
- https://github.com/openai/codex
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from pi_harness_benchmark.models import (
    ActivityBreakdown,
    ActualExecutionMetadata,
    AuxiliaryUsageAccounting,
    Clarification,
    Harness,
    InteractionCounts,
    NativeSessionAnalysis,
    PlanningQuality,
    StageMetrics,
    StageName,
    TokenUsage,
)

if TYPE_CHECKING:
    from pathlib import Path

EPOCH_MILLISECOND_THRESHOLD = 10_000_000_000


@dataclass(frozen=True)
class UsageEvent:
    """One unique response usage event or cumulative usage snapshot."""

    timestamp: datetime | None
    usage: TokenUsage
    key: str
    auxiliary: bool = False
    category: str | None = None
    interval_usage: TokenUsage | None = None


@dataclass(frozen=True)
class CodexUsageStream:
    """One independently cumulative Codex main-thread or subagent rollout."""

    key: str
    auxiliary: bool
    events: tuple[UsageEvent, ...]


@dataclass(frozen=True)
class EvidenceEvent:
    """Timestamped text or structured-question planning evidence."""

    timestamp: datetime | None
    text: str
    kind: str


@dataclass(frozen=True)
class ActivityEvent:
    """One deduplicated assistant turn, tool call, or blocked call."""

    timestamp: datetime | None
    kind: str
    key: str
    name: str | None = None


@dataclass(frozen=True)
class SessionWindow:
    """Operator-recorded native session stage boundaries."""

    started_at: datetime
    transition_at: datetime | None
    stopped_at: datetime


def _integer(value: object) -> int | None:
    """Coerce a JSON numeric field to a nonnegative integer.

    Parameters:
        value (object): Parsed JSON value.

    Returns:
        int | None: Nonnegative integer, or None for unavailable input.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(int(value), 0)


def _float_or_none(value: object) -> float | None:
    """Coerce a JSON numeric field to a nonnegative float.

    Parameters:
        value (object): Parsed JSON value.

    Returns:
        float | None: Numeric value or None.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(float(value), 0.0)


def _timestamp(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp when available.

    Parameters:
        value (object): Potential timestamp string or epoch number.

    Returns:
        datetime | None: UTC-aware timestamp when parseable.
    """
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = value / 1000 if value > EPOCH_MILLISECOND_THRESHOLD else value
        return datetime.fromtimestamp(seconds, tz=UTC)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _read_json_lines(paths: list[Path]) -> list[dict[str, Any]]:
    """Read parseable JSON objects from redacted session files.

    Parameters:
        paths (list[Path]): Redacted JSON or JSONL paths.

    Returns:
        list[dict[str, Any]]: Parsed top-level objects in file order.
    """
    records: list[dict[str, Any]] = []
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            whole = json.loads(text)
        except json.JSONDecodeError:
            whole = None
        if isinstance(whole, dict):
            records.append(whole)
            continue
        if isinstance(whole, list):
            records.extend(item for item in whole if isinstance(item, dict))
            continue
        for line in text.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                records.append(item)
    return records


def _pi_usage(raw: dict[str, Any]) -> TokenUsage:
    """Normalize Pi's camel-case usage object.

    Parameters:
        raw (dict[str, Any]): Pi usage object.

    Returns:
        TokenUsage: Normalized token usage.
    """
    return TokenUsage(
        input_tokens=_integer(raw.get("input")),
        output_tokens=_integer(raw.get("output")),
        cache_read_tokens=_integer(raw.get("cacheRead")),
        cache_write_tokens=_integer(raw.get("cacheWrite")),
        reasoning_tokens=_integer(raw.get("reasoning")),
        total_tokens=_integer(raw.get("totalTokens")),
        cost_usd=_float_or_none(raw.get("cost")),
    )


def _pi_tool_usage_events(
    message: dict[str, Any],
    timestamp: datetime | None,
    index: int,
) -> list[UsageEvent]:
    """Extract non-overlapping usage exposed by one Pi tool result.

    Parameters:
        message (dict[str, Any]): Pi tool-result message.
        timestamp (datetime | None): Native message timestamp.
        index (int): Stable fallback record index.

    Returns:
        list[UsageEvent]: Direct or nested auxiliary usage, never both.
    """
    role = message.get("role")
    if role not in {"toolResult", "tool_result"}:
        return []
    call_id = str(message.get("toolCallId") or message.get("tool_call_id") or index)
    direct = message.get("usage")
    if isinstance(direct, dict):
        usage = _pi_usage(direct)
        return (
            [
                UsageEvent(
                    timestamp=timestamp,
                    usage=usage,
                    key=f"tool-result-{call_id}",
                    auxiliary=True,
                    category="tool-result",
                )
            ]
            if usage.total_tokens
            else []
        )
    details = _mapping(message.get("details"))
    results = details.get("results")
    if not isinstance(results, list):
        return []
    events: list[UsageEvent] = []
    for result_index, result in enumerate(results):
        usage_raw = _mapping(_mapping(result).get("usage"))
        usage = _pi_usage(usage_raw)
        if usage.total_tokens:
            events.append(
                UsageEvent(
                    timestamp=timestamp,
                    usage=usage,
                    key=f"tool-result-{call_id}-{result_index}",
                    auxiliary=True,
                    category="subagent",
                )
            )
    return events


def parse_pi_events(paths: list[Path]) -> list[UsageEvent]:
    """Parse finalized Pi assistant messages without duplicate counting.

    Parameters:
        paths (list[Path]): Redacted Pi session files.

    Returns:
        list[UsageEvent]: Unique finalized assistant usage events.
    """
    events: dict[str, UsageEvent] = {}
    for index, record in enumerate(_read_json_lines(paths)):
        message = record.get("message", record)
        if not isinstance(message, dict):
            continue
        timestamp = _timestamp(record.get("timestamp") or message.get("timestamp"))
        for event in _pi_tool_usage_events(message, timestamp, index):
            events[event.key] = event
        if message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        key = str(message.get("id") or record.get("id") or f"line-{index}")
        normalized = _pi_usage(usage)
        if normalized.total_tokens in {None, 0}:
            continue
        events[key] = UsageEvent(timestamp=timestamp, usage=normalized, key=key)
    return list(events.values())


def _claude_usage(raw: dict[str, Any]) -> TokenUsage:
    """Normalize one Claude message usage object.

    Parameters:
        raw (dict[str, Any]): Claude usage object.

    Returns:
        TokenUsage: Normalized token usage.
    """
    details = raw.get("output_tokens_details")
    detail_map = details if isinstance(details, dict) else {}
    return TokenUsage(
        input_tokens=_integer(raw.get("input_tokens")),
        output_tokens=_integer(raw.get("output_tokens")),
        cache_read_tokens=_integer(raw.get("cache_read_input_tokens")),
        cache_write_tokens=_integer(raw.get("cache_creation_input_tokens")),
        reasoning_tokens=_integer(detail_map.get("thinking_tokens")),
    )


def parse_claude_events(paths: list[Path]) -> list[UsageEvent]:
    """Deduplicate Claude content chunks by message ID and retain final usage.

    Parameters:
        paths (list[Path]): Redacted Claude session files.

    Returns:
        list[UsageEvent]: One nonzero final usage record per assistant message.
    """
    events: dict[str, UsageEvent] = {}
    for index, record in enumerate(_read_json_lines(paths)):
        message = record.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        key = str(message.get("id") or record.get("uuid") or f"line-{index}")
        auxiliary = record.get("isSidechain") is True
        candidate = UsageEvent(
            timestamp=_timestamp(record.get("timestamp") or message.get("timestamp")),
            usage=_claude_usage(usage),
            key=key,
            auxiliary=auxiliary,
            category="sidechain" if auxiliary else None,
        )
        if candidate.usage.total_tokens in {None, 0}:
            continue
        current = events.get(key)
        current_tokens = current.usage.total_tokens if current is not None else None
        candidate_tokens = candidate.usage.total_tokens
        if current_tokens is None or (
            candidate_tokens is not None and candidate_tokens >= current_tokens
        ):
            events[key] = candidate
    return [event for event in events.values() if event.usage.total_tokens is not None]


def _codex_usage(raw: dict[str, Any]) -> TokenUsage:
    """Normalize one cumulative Codex token snapshot.

    Parameters:
        raw (dict[str, Any]): Codex total_token_usage object.

    Returns:
        TokenUsage: Normalized cumulative usage.
    """
    cached = _integer(raw.get("cached_input_tokens"))
    provider_input = _integer(raw.get("input_tokens"))
    uncached = (
        max(provider_input - cached, 0)
        if provider_input is not None and cached is not None
        else None
    )
    return TokenUsage(
        input_tokens=uncached,
        output_tokens=_integer(raw.get("output_tokens")),
        cache_read_tokens=cached,
        reasoning_tokens=_integer(raw.get("reasoning_output_tokens")),
        total_tokens=_integer(raw.get("total_tokens")),
    )


def _codex_rollout_is_auxiliary(records: list[dict[str, Any]]) -> bool:
    """Return whether Codex session metadata identifies a subagent rollout.

    Parameters:
        records (list[dict[str, Any]]): Records from one rollout path.

    Returns:
        bool: True for a native subagent rollout.
    """
    metadata = next(
        (
            _mapping(record.get("payload"))
            for record in records
            if record.get("type") == "session_meta"
        ),
        {},
    )
    source = metadata.get("source")
    return bool(
        metadata.get("parent_thread_id")
        or metadata.get("agent_role")
        or (isinstance(source, dict) and source.get("subagent"))
    )


def _codex_streams(paths: list[Path]) -> list[CodexUsageStream]:
    """Parse independently cumulative Codex rollout streams without cross-thread summing.

    Parameters:
        paths (list[Path]): Redacted Codex rollout files.

    Returns:
        list[CodexUsageStream]: Deduplicated main and subagent streams.
    """
    streams: dict[str, CodexUsageStream] = {}
    for path_index, path in enumerate(paths):
        records = _read_json_lines([path])
        metadata = next(
            (
                _mapping(record.get("payload"))
                for record in records
                if record.get("type") == "session_meta"
            ),
            {},
        )
        auxiliary = _codex_rollout_is_auxiliary(records)
        stream_key = str(metadata.get("id") or f"path-{path_index}-{path.name}")
        events: list[UsageEvent] = []
        for record_index, record in enumerate(records):
            if record.get("type") != "event_msg":
                continue
            payload = _mapping(record.get("payload"))
            if payload.get("type") != "token_count":
                continue
            info = _mapping(payload.get("info"))
            usage = _mapping(info.get("total_token_usage"))
            last_usage = info.get("last_token_usage")
            normalized = _codex_usage(usage)
            if normalized.total_tokens in {None, 0}:
                continue
            events.append(
                UsageEvent(
                    timestamp=_timestamp(record.get("timestamp")),
                    usage=normalized,
                    key=f"{stream_key}-snapshot-{record_index}",
                    auxiliary=auxiliary,
                    category="subagent" if auxiliary else None,
                    interval_usage=(
                        _codex_usage(last_usage) if isinstance(last_usage, dict) else None
                    ),
                )
            )
        ordered = tuple(
            sorted(events, key=lambda event: event.timestamp or datetime.min.replace(tzinfo=UTC))
        )
        candidate = CodexUsageStream(
            key=stream_key,
            auxiliary=auxiliary,
            events=ordered,
        )
        current = streams.get(stream_key)
        current_total = (
            current.events[-1].usage.total_tokens or 0 if current and current.events else 0
        )
        candidate_total = ordered[-1].usage.total_tokens or 0 if ordered else 0
        if current is None or candidate_total >= current_total:
            streams[stream_key] = candidate
    return list(streams.values())


def _codex_stream_usage(
    stream: CodexUsageStream,
    through: datetime | None = None,
) -> TokenUsage | None:
    """Return non-overlapping usage for one independently cumulative rollout.

    Parameters:
        stream (CodexUsageStream): Main or auxiliary cumulative stream.
        through (datetime | None): Optional inclusive timestamp boundary.

    Returns:
        TokenUsage | None: Main cumulative total, auxiliary delta, or unavailable usage.
    """
    eligible = [
        event
        for event in stream.events
        if through is None or (event.timestamp is not None and event.timestamp <= through)
    ]
    if not eligible:
        return None
    final = eligible[-1].usage
    if not stream.auxiliary or not stream.events:
        return final
    if all(event.interval_usage is not None for event in eligible):
        return _sum_events(
            [
                UsageEvent(
                    timestamp=event.timestamp,
                    usage=event.interval_usage or TokenUsage(total_tokens=0),
                    key=event.key,
                )
                for event in eligible
            ]
        )
    return _subtract_usage(final, stream.events[0].usage)


def parse_codex_events(paths: list[Path]) -> list[UsageEvent]:
    """Parse Codex snapshots while retaining their independent stream identity.

    Parameters:
        paths (list[Path]): Redacted Codex rollout files.

    Returns:
        list[UsageEvent]: Cumulative snapshots, never summed by this parser.
    """
    return [event for stream in _codex_streams(paths) for event in stream.events]


def _subtract_usage(final: TokenUsage, initial: TokenUsage) -> TokenUsage:
    """Subtract two cumulative snapshots without allowing negatives.

    Parameters:
        final (TokenUsage): Later cumulative snapshot.
        initial (TokenUsage): Earlier cumulative snapshot.

    Returns:
        TokenUsage: Nonnegative interval usage.
    """

    def subtract_optional(final_value: int | None, initial_value: int | None) -> int | None:
        if final_value is None or initial_value is None:
            return None
        return max(final_value - initial_value, 0)

    cost = None
    if final.cost_usd is not None and initial.cost_usd is not None:
        cost = max(final.cost_usd - initial.cost_usd, 0.0)
    return TokenUsage(
        input_tokens=subtract_optional(final.input_tokens, initial.input_tokens),
        output_tokens=subtract_optional(final.output_tokens, initial.output_tokens),
        cache_read_tokens=subtract_optional(final.cache_read_tokens, initial.cache_read_tokens),
        cache_write_tokens=subtract_optional(final.cache_write_tokens, initial.cache_write_tokens),
        reasoning_tokens=subtract_optional(final.reasoning_tokens, initial.reasoning_tokens),
        total_tokens=subtract_optional(final.total_tokens, initial.total_tokens),
        cost_usd=cost,
    )


def _sum_events(events: list[UsageEvent]) -> TokenUsage | None:
    """Sum disjoint response usage events.

    Parameters:
        events (list[UsageEvent]): Unique response events.

    Returns:
        TokenUsage | None: Combined usage, or None when no usable events exist.
    """
    if not events:
        return None
    total = events[0].usage
    for event in events[1:]:
        total = total + event.usage
    return total


def _zero_like(usage: TokenUsage) -> TokenUsage:
    """Return known zeroes while preserving unavailable categories.

    Parameters:
        usage (TokenUsage): Availability template.

    Returns:
        TokenUsage: Zero-valued usage with matching category availability.
    """
    return TokenUsage(
        input_tokens=0 if usage.input_tokens is not None else None,
        output_tokens=0 if usage.output_tokens is not None else None,
        cache_read_tokens=0 if usage.cache_read_tokens is not None else None,
        cache_write_tokens=0 if usage.cache_write_tokens is not None else None,
        reasoning_tokens=0 if usage.reasoning_tokens is not None else None,
        total_tokens=0 if usage.total_tokens is not None else None,
        cost_usd=0.0 if usage.cost_usd is not None else None,
    )


def _duration(start: datetime | None, end: datetime | None) -> float | None:
    """Calculate a nonnegative duration when both timestamps exist.

    Parameters:
        start (datetime | None): Interval start.
        end (datetime | None): Interval end.

    Returns:
        float | None: Duration in seconds.
    """
    if start is None or end is None:
        return None
    return max((end - start).total_seconds(), 0.0)


def stage_usage(
    harness: Harness,
    paths: list[Path],
    *,
    started_at: datetime,
    transition_at: datetime | None,
    stopped_at: datetime,
) -> tuple[TokenUsage | None, list[StageMetrics], list[str]]:
    """Parse total usage and split it at the recorded plan transition.

    Parameters:
        harness (Harness): Native CLI that produced the logs.
        paths (list[Path]): Redacted native JSON/JSONL session paths.
        started_at (datetime): Post-setup model start.
        transition_at (datetime | None): Plan acceptance timestamp.
        stopped_at (datetime): Agent stop timestamp.

    Returns:
        tuple[TokenUsage | None, list[StageMetrics], list[str]]: Total, stages, and warnings.
    """
    warnings: list[str] = []
    if harness is Harness.CODEX:
        streams = _codex_streams(paths)
        events = [event for stream in streams for event in stream.events]
        stream_events: list[UsageEvent] = []
        for stream in streams:
            stream_usage = _codex_stream_usage(stream)
            if stream_usage is not None:
                stream_events.append(UsageEvent(timestamp=None, usage=stream_usage, key=stream.key))
        total = _sum_events(stream_events)
        if transition_at is None:
            return (
                total,
                [
                    StageMetrics(
                        stage=StageName.UNSPLIT,
                        started_at=started_at,
                        ended_at=stopped_at,
                        duration_seconds=_duration(started_at, stopped_at),
                        usage=total,
                        source_events=len(events),
                    )
                ],
                ["No plan transition timestamp; Codex usage is unsplit"],
            )
        boundary_events: list[UsageEvent] = []
        for stream in streams:
            stream_usage = _codex_stream_usage(stream, transition_at)
            if stream_usage is not None:
                boundary_events.append(
                    UsageEvent(timestamp=transition_at, usage=stream_usage, key=stream.key)
                )
        plan = _sum_events(boundary_events)
        if total is not None and plan is None:
            plan = _zero_like(total)
        implementation = (
            _subtract_usage(total, plan) if total is not None and plan is not None else None
        )
        return (
            total,
            [
                StageMetrics(
                    stage=StageName.PLAN,
                    started_at=started_at,
                    ended_at=transition_at,
                    duration_seconds=_duration(started_at, transition_at),
                    usage=plan,
                    source_events=sum(
                        event.timestamp is not None and event.timestamp <= transition_at
                        for event in events
                    ),
                ),
                StageMetrics(
                    stage=StageName.IMPLEMENTATION,
                    started_at=transition_at,
                    ended_at=stopped_at,
                    duration_seconds=_duration(transition_at, stopped_at),
                    usage=implementation,
                    source_events=sum(
                        event.timestamp is None or event.timestamp > transition_at
                        for event in events
                    ),
                ),
            ],
            warnings,
        )

    events = parse_claude_events(paths) if harness is Harness.CLAUDE else parse_pi_events(paths)
    total = _sum_events(events)
    if transition_at is None or any(event.timestamp is None for event in events):
        reason = (
            "No plan transition timestamp"
            if transition_at is None
            else "One or more native usage events lack timestamps"
        )
        warnings.append(f"{reason}; response usage is unsplit")
        return (
            total,
            [
                StageMetrics(
                    stage=StageName.UNSPLIT,
                    started_at=started_at,
                    ended_at=stopped_at,
                    duration_seconds=_duration(started_at, stopped_at),
                    usage=total,
                    source_events=len(events),
                )
            ],
            warnings,
        )
    plan_events = [
        event for event in events if event.timestamp and event.timestamp <= transition_at
    ]
    implementation_events = [
        event for event in events if event.timestamp and event.timestamp > transition_at
    ]
    return (
        total,
        [
            StageMetrics(
                stage=StageName.PLAN,
                started_at=started_at,
                ended_at=transition_at,
                duration_seconds=_duration(started_at, transition_at),
                usage=(
                    _sum_events(plan_events)
                    if plan_events
                    else _zero_like(total)
                    if total is not None
                    else None
                ),
                source_events=len(plan_events),
            ),
            StageMetrics(
                stage=StageName.IMPLEMENTATION,
                started_at=transition_at,
                ended_at=stopped_at,
                duration_seconds=_duration(transition_at, stopped_at),
                usage=(
                    _sum_events(implementation_events)
                    if implementation_events
                    else _zero_like(total)
                    if total is not None
                    else None
                ),
                source_events=len(implementation_events),
            ),
        ],
        warnings,
    )


def _mapping(value: object) -> dict[str, Any]:
    """Return a string-keyed mapping or an empty mapping.

    Parameters:
        value (object): Parsed JSON value.

    Returns:
        dict[str, Any]: Mapping when valid.
    """
    return value if isinstance(value, dict) else {}


def _content_items(value: object) -> list[dict[str, Any]]:
    """Normalize native message content into object items.

    Parameters:
        value (object): Native content value.

    Returns:
        list[dict[str, Any]]: Content objects.
    """
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def _content_text(value: object) -> str:
    """Flatten native text content for question and denial detection.

    Parameters:
        value (object): Native content value.

    Returns:
        str: Concatenated textual content.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_content_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(
            _content_text(value.get(key)) for key in ("text", "message", "content", "output")
        )
    return ""


def _is_blocked(value: object) -> bool:
    """Detect an explicit native approval or policy block.

    Parameters:
        value (object): Native result or event object.

    Returns:
        bool: True only for explicit blocked or denied evidence.
    """
    text = _content_text(value).lower()
    return "blocked" in text or "denied" in text or "not approved" in text


def _single_value(values: list[str]) -> str | None:
    """Return one consistent nonempty value.

    Parameters:
        values (list[str]): Extracted native values.

    Returns:
        str | None: Unique value or None when absent/inconsistent.
    """
    unique = list(dict.fromkeys(value for value in values if value))
    return unique[0] if len(unique) == 1 else None


def _pi_metadata(records: list[dict[str, Any]]) -> ActualExecutionMetadata:
    """Extract Pi provider, model, and thinking level.

    Parameters:
        records (list[dict[str, Any]]): Parsed Pi records.

    Returns:
        ActualExecutionMetadata: Native identity.
    """
    session_records = [
        record
        for record in records
        if record.get("type") in {"session", "model_change", "thinking_level_change"}
    ]
    return ActualExecutionMetadata(
        provider=_single_value([str(record.get("provider") or "") for record in session_records]),
        model=_single_value(
            [str(record.get("model") or record.get("modelId") or "") for record in session_records]
        ),
        reasoning_level=_single_value(
            [
                str(record.get("thinkingLevel") or record.get("thinking") or "")
                for record in session_records
            ]
        ),
    )


def _claude_metadata(records: list[dict[str, Any]]) -> ActualExecutionMetadata:
    """Extract Claude's exact assistant-message model.

    Parameters:
        records (list[dict[str, Any]]): Parsed Claude records.

    Returns:
        ActualExecutionMetadata: Native identity.
    """
    models = [
        str(message.get("model") or "")
        for record in records
        if record.get("isSidechain") is not True
        and (message := _mapping(record.get("message"))).get("role") == "assistant"
    ]
    model = _single_value(models)
    return ActualExecutionMetadata(
        provider="anthropic" if model and model.startswith("claude-") else None,
        model=model,
        reasoning_level=None,
    )


def _codex_metadata(records: list[dict[str, Any]]) -> ActualExecutionMetadata:
    """Extract Codex session and turn-context identity.

    Parameters:
        records (list[dict[str, Any]]): Parsed Codex records.

    Returns:
        ActualExecutionMetadata: Native identity.
    """
    session_payloads = [
        _mapping(record.get("payload"))
        for record in records
        if record.get("type") == "session_meta"
    ]
    turn_payloads = [
        _mapping(record.get("payload"))
        for record in records
        if record.get("type") == "turn_context"
    ]
    return ActualExecutionMetadata(
        provider=_single_value(
            [str(payload.get("model_provider") or "") for payload in session_payloads]
        ),
        model=_single_value([str(payload.get("model") or "") for payload in turn_payloads]),
        reasoning_level=_single_value(
            [
                str(
                    payload.get("reasoning_effort")
                    or payload.get("reasoning")
                    or payload.get("effort")
                    or ""
                )
                for payload in turn_payloads
            ]
        ),
    )


def _actual_metadata(
    harness: Harness, records: list[dict[str, Any]]
) -> tuple[ActualExecutionMetadata, list[str]]:
    """Extract actual provider, model, and reasoning from native records.

    Parameters:
        harness (Harness): Native session format.
        records (list[dict[str, Any]]): Parsed session records.

    Returns:
        tuple[ActualExecutionMetadata, list[str]]: Extracted identity and warnings.
    """
    if harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        metadata = _pi_metadata(records)
    elif harness is Harness.CLAUDE:
        metadata = _claude_metadata(records)
    else:
        metadata = _codex_metadata(records)
    warnings = [
        f"Native session does not establish actual {field}"
        for field, value in metadata.model_dump().items()
        if value is None
    ]
    return metadata, warnings


def _add_activity(
    events: dict[str, ActivityEvent],
    *,
    timestamp: datetime | None,
    kind: str,
    key: str,
    name: str | None = None,
) -> None:
    """Add or replace one deduplicated activity event.

    Parameters:
        events (dict[str, ActivityEvent]): Mutable event index.
        timestamp (datetime | None): Native event timestamp.
        kind (str): Turn, tool, or blocked category.
        key (str): Stable native identity.
        name (str | None): Raw native tool name.
    """
    events[f"{kind}:{key}"] = ActivityEvent(
        timestamp=timestamp,
        kind=kind,
        key=key,
        name=name,
    )


def _structured_question_texts(tool_name: str, arguments: object) -> list[str]:
    """Extract question strings from native structured-question tool arguments.

    Parameters:
        tool_name (str): Native tool name.
        arguments (object): Parsed object or JSON argument string.

    Returns:
        list[str]: Structured question prompts for supported native tools.
    """
    normalized_name = re.sub(r"[^a-z0-9]", "", tool_name.lower())
    if normalized_name not in {
        "planmodequestion",
        "askuserquestion",
        "requestuserinput",
    }:
        return []
    parsed = arguments
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return []
    questions = _mapping(parsed).get("questions")
    if not isinstance(questions, list):
        return []
    return [
        question
        for item in questions
        if isinstance((question := _mapping(item).get("question")), str) and question
    ]


def _evidence(timestamp: datetime | None, text: str, kind: str) -> EvidenceEvent:
    """Build nonempty timestamped planning evidence.

    Parameters:
        timestamp (datetime | None): Native event timestamp.
        text (str): Native text or structured question.
        kind (str): Evidence provenance.

    Returns:
        EvidenceEvent: Normalized evidence event.
    """
    return EvidenceEvent(timestamp=timestamp, text=text.strip(), kind=kind)


def _pi_activity(
    records: list[dict[str, Any]],
) -> tuple[list[ActivityEvent], list[EvidenceEvent]]:
    """Extract deduplicated Pi activity and planning evidence.

    Parameters:
        records (list[dict[str, Any]]): Parsed Pi records.

    Returns:
        tuple[list[ActivityEvent], list[EvidenceEvent]]: Activity and evidence.
    """
    events: dict[str, ActivityEvent] = {}
    evidence: list[EvidenceEvent] = []
    tool_names: dict[str, str] = {}
    for index, record in enumerate(records):
        message = _mapping(record.get("message", record))
        timestamp = _timestamp(record.get("timestamp") or message.get("timestamp"))
        role = message.get("role")
        text = _content_text(message.get("content"))
        if text and role in {"assistant", "user"}:
            evidence.append(_evidence(timestamp, text, f"{role}-text"))
        if role == "assistant":
            message_id = str(message.get("id") or record.get("id") or f"line-{index}")
            _add_activity(events, timestamp=timestamp, kind="turn", key=message_id)
            for item_index, item in enumerate(_content_items(message.get("content"))):
                if item.get("type") not in {"toolCall", "tool_call", "tool_use"}:
                    continue
                call_id = str(item.get("id") or f"{message_id}-{item_index}")
                name = str(item.get("name") or "unknown")
                evidence.extend(
                    _evidence(timestamp, question, "structured-question")
                    for question in _structured_question_texts(
                        name, item.get("arguments") or item.get("input")
                    )
                )
                tool_names[call_id] = name
                _add_activity(events, timestamp=timestamp, kind="tool", key=call_id, name=name)
        if role in {"toolResult", "tool_result"} and _is_blocked(message):
            call_id = str(message.get("toolCallId") or message.get("tool_call_id") or index)
            name = str(message.get("toolName") or tool_names.get(call_id) or "unknown")
            _add_activity(events, timestamp=timestamp, kind="blocked", key=call_id, name=name)
    return list(events.values()), evidence


def _claude_activity(
    records: list[dict[str, Any]],
) -> tuple[list[ActivityEvent], list[EvidenceEvent]]:
    """Extract deduplicated Claude activity and planning evidence.

    Parameters:
        records (list[dict[str, Any]]): Parsed Claude records.

    Returns:
        tuple[list[ActivityEvent], list[EvidenceEvent]]: Activity and evidence.
    """
    events: dict[str, ActivityEvent] = {}
    evidence: list[EvidenceEvent] = []
    tool_names: dict[str, str] = {}
    for index, record in enumerate(records):
        message = _mapping(record.get("message"))
        timestamp = _timestamp(record.get("timestamp") or message.get("timestamp"))
        role = message.get("role")
        text = _content_text(message.get("content"))
        if text and role in {"assistant", "user"}:
            evidence.append(_evidence(timestamp, text, f"{role}-text"))
        if role == "assistant":
            message_id = str(message.get("id") or record.get("uuid") or f"line-{index}")
            _add_activity(events, timestamp=timestamp, kind="turn", key=message_id)
            for item_index, item in enumerate(_content_items(message.get("content"))):
                if item.get("type") != "tool_use":
                    continue
                call_id = str(item.get("id") or f"{message_id}-{item_index}")
                name = str(item.get("name") or "unknown")
                evidence.extend(
                    _evidence(timestamp, question, "structured-question")
                    for question in _structured_question_texts(name, item.get("input"))
                )
                tool_names[call_id] = name
                _add_activity(events, timestamp=timestamp, kind="tool", key=call_id, name=name)
        for item in _content_items(message.get("content")):
            if item.get("type") == "tool_result" and _is_blocked(item):
                call_id = str(item.get("tool_use_id") or index)
                _add_activity(
                    events,
                    timestamp=timestamp,
                    kind="blocked",
                    key=call_id,
                    name=tool_names.get(call_id, "unknown"),
                )
    return list(events.values()), evidence


def _codex_activity(
    records: list[dict[str, Any]],
) -> tuple[list[ActivityEvent], list[EvidenceEvent]]:
    """Extract deduplicated Codex activity and planning evidence.

    Parameters:
        records (list[dict[str, Any]]): Parsed Codex records.

    Returns:
        tuple[list[ActivityEvent], list[EvidenceEvent]]: Activity and evidence.
    """
    events: dict[str, ActivityEvent] = {}
    evidence: list[EvidenceEvent] = []
    tool_names: dict[str, str] = {}
    for index, record in enumerate(records):
        payload = _mapping(record.get("payload"))
        timestamp = _timestamp(record.get("timestamp"))
        payload_type = payload.get("type")
        if record.get("type") == "response_item" and payload_type == "message":
            role = payload.get("role")
            text = _content_text(payload.get("content"))
            if text and role in {"assistant", "user"}:
                evidence.append(_evidence(timestamp, text, f"{role}-text"))
            if role == "assistant":
                message_id = str(payload.get("id") or f"line-{index}")
                _add_activity(events, timestamp=timestamp, kind="turn", key=message_id)
        if record.get("type") == "response_item" and payload_type in {
            "function_call",
            "custom_tool_call",
        }:
            call_id = str(payload.get("call_id") or payload.get("id") or index)
            name = str(payload.get("name") or payload_type)
            evidence.extend(
                _evidence(timestamp, question, "structured-question")
                for question in _structured_question_texts(name, payload.get("arguments"))
            )
            tool_names[call_id] = name
            _add_activity(events, timestamp=timestamp, kind="tool", key=call_id, name=name)
        if record.get("type") == "event_msg" and payload_type == "user_message":
            text = _content_text(payload.get("message") or payload.get("content"))
            if text:
                evidence.append(_evidence(timestamp, text, "user-text"))
        if record.get("type") == "event_msg" and _is_blocked(payload):
            call_id = str(payload.get("call_id") or index)
            _add_activity(
                events,
                timestamp=timestamp,
                kind="blocked",
                key=call_id,
                name=tool_names.get(call_id, str(payload.get("name") or "unknown")),
            )
    return list(events.values()), evidence


def _counts(events: list[ActivityEvent] | None) -> InteractionCounts:
    """Aggregate activity events while preserving raw tool categories.

    Parameters:
        events (list[ActivityEvent] | None): Events or None when a stage is unknowable.

    Returns:
        InteractionCounts: Nullable aggregate counts.
    """
    if events is None:
        return InteractionCounts(
            turns=None,
            tool_calls=None,
            blocked_calls=None,
            tool_calls_by_name=None,
            blocked_calls_by_name=None,
        )
    tools: dict[str, int] = {}
    blocked: dict[str, int] = {}
    for event in events:
        target = tools if event.kind == "tool" else blocked if event.kind == "blocked" else None
        if target is not None:
            name = event.name or "unknown"
            target[name] = target.get(name, 0) + 1
    return InteractionCounts(
        turns=sum(event.kind == "turn" for event in events),
        tool_calls=sum(event.kind == "tool" for event in events),
        blocked_calls=sum(event.kind == "blocked" for event in events),
        tool_calls_by_name=dict(sorted(tools.items())),
        blocked_calls_by_name=dict(sorted(blocked.items())),
    )


def _activity_breakdown(
    events: list[ActivityEvent],
    *,
    records_available: bool,
    transition_at: datetime | None,
) -> tuple[ActivityBreakdown, list[str]]:
    """Split interaction counts at the plan transition.

    Parameters:
        events (list[ActivityEvent]): Deduplicated activity.
        records_available (bool): Whether native records were parseable.
        transition_at (datetime | None): Operator stage boundary.

    Returns:
        tuple[ActivityBreakdown, list[str]]: Counts and limitations.
    """
    if not records_available:
        unknown = _counts(None)
        return ActivityBreakdown(plan=unknown, implementation=unknown, combined=unknown), [
            "Native format did not provide parseable records; interaction counts are unavailable"
        ]
    combined = _counts(events)
    if transition_at is None or any(event.timestamp is None for event in events):
        unknown = _counts(None)
        return ActivityBreakdown(plan=unknown, implementation=unknown, combined=combined), [
            "Native timestamps cannot establish Plan and implementation interaction counts"
        ]
    plan = [event for event in events if event.timestamp and event.timestamp <= transition_at]
    implementation = [
        event for event in events if event.timestamp and event.timestamp > transition_at
    ]
    return ActivityBreakdown(
        plan=_counts(plan),
        implementation=_counts(implementation),
        combined=combined,
    ), []


def _qualifying_question(event: EvidenceEvent) -> bool:
    """Return whether evidence asks the unresolved limit question.

    Parameters:
        event (EvidenceEvent): Native text or structured question.

    Returns:
        bool: True for the required filtering/ordering limit question.
    """
    lowered = event.text.lower()
    explicit_question = event.kind == "structured-question" or "?" in event.text
    describes_tradeoff = event.kind == "structured-question" or any(
        word in lowered for word in ("filter", "order")
    )
    return explicit_question and "limit" in lowered and describes_tradeoff


def _explicit_choice(event: EvidenceEvent) -> bool:
    """Return whether evidence commits to either unresolved product choice.

    Parameters:
        event (EvidenceEvent): Native planning evidence.

    Returns:
        bool: True for a choice statement, never for a question.
    """
    if event.kind != "assistant-text" or "?" in event.text:
        return False
    lowered = event.text.lower()
    return "limit" in lowered and (
        ("after" in lowered and ("filter" in lowered or "order" in lowered))
        or ("before" in lowered and ("input" in lowered or "filter" in lowered))
        or ("emitted active" in lowered and "not input" in lowered)
    )


def _planning_quality(
    clarification: Clarification | None,
    evidence_events: list[EvidenceEvent],
    transition_at: datetime | None,
) -> tuple[PlanningQuality, list[str]]:
    """Determine whether a timestamped ambiguity question preceded every choice.

    Parameters:
        clarification (Clarification | None): Required fixed clarification metadata.
        evidence_events (list[EvidenceEvent]): Timestamped native planning evidence.
        transition_at (datetime | None): Plan-to-implementation boundary.

    Returns:
        tuple[PlanningQuality, list[str]]: Planning result and limitations.
    """
    if clarification is None:
        return PlanningQuality(required=False, asked_before_choosing=None, evidence=None), []
    if not evidence_events:
        return PlanningQuality(required=True, asked_before_choosing=None, evidence=None), [
            "Native session text cannot establish whether the ambiguity question was asked"
        ]
    eligible = [
        event
        for event in evidence_events
        if event.timestamp is not None
        and (transition_at is None or event.timestamp <= transition_at)
    ]
    questions = [event for event in eligible if _qualifying_question(event)]
    unknown_questions = [
        event
        for event in evidence_events
        if event.timestamp is None and _qualifying_question(event)
    ]
    all_choices = [event for event in evidence_events if _explicit_choice(event)]
    choices = [event for event in all_choices if event.timestamp is not None]
    unknown_choices = [event for event in all_choices if event.timestamp is None]
    first_choice = min((event.timestamp for event in choices if event.timestamp), default=None)
    qualifying = [
        event
        for event in questions
        if event.timestamp is not None and (first_choice is None or event.timestamp < first_choice)
    ]
    if (qualifying and unknown_choices) or unknown_questions:
        missing_kind = "choice" if unknown_choices else "question"
        return PlanningQuality(required=True, asked_before_choosing=None, evidence=None), [
            f"Qualifying {missing_kind} lacks a native timestamp; ordering cannot be established"
        ]
    if qualifying:
        candidate = min(
            qualifying,
            key=lambda event: event.timestamp or datetime.max.replace(tzinfo=UTC),
        )
        return PlanningQuality(
            required=True,
            asked_before_choosing=True,
            evidence=f"{candidate.kind}: {candidate.text}"[:500],
        ), []
    if questions and first_choice is not None:
        choice = min(
            choices,
            key=lambda event: event.timestamp or datetime.max.replace(tzinfo=UTC),
        )
        return PlanningQuality(
            required=True,
            asked_before_choosing=False,
            evidence=f"Explicit choice preceded qualifying question: {choice.text}"[:500],
        ), []
    return PlanningQuality(
        required=True,
        asked_before_choosing=False,
        evidence="No qualifying timestamped pre-choice question found",
    ), []


def _auxiliary_accounting(harness: Harness, paths: list[Path]) -> AuxiliaryUsageAccounting:
    """Describe included auxiliary usage and native completeness limits.

    Parameters:
        harness (Harness): Native session format.
        paths (list[Path]): Redacted session paths.

    Returns:
        AuxiliaryUsageAccounting: Explicit auxiliary evidence and limitation.
    """
    if harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        auxiliary = [event for event in parse_pi_events(paths) if event.auxiliary]
        limitation = (
            "Equivalent complete auxiliary accounting cannot be established across native formats; "
            "Pi tool-result auxiliary usage is included only when optional native usage fields "
            "are present."
        )
    elif harness is Harness.CLAUDE:
        auxiliary = [event for event in parse_claude_events(paths) if event.auxiliary]
        limitation = (
            "Equivalent complete auxiliary accounting cannot be established across native formats; "
            "Claude sidechain usage is included when discovered, but native linkage cannot prove "
            "that every auxiliary session was retained."
        )
    else:
        auxiliary = []
        for stream in _codex_streams(paths):
            stream_usage = _codex_stream_usage(stream)
            if stream.auxiliary and stream_usage is not None:
                auxiliary.append(
                    UsageEvent(
                        timestamp=None,
                        usage=stream_usage,
                        key=stream.key,
                        auxiliary=True,
                        category="subagent",
                    )
                )
        limitation = (
            "Equivalent complete auxiliary accounting cannot be established across native formats; "
            "Codex subagent usage uses native interval counts when exposed and otherwise excludes "
            "each rollout's first cumulative snapshot as a possible inherited baseline, but "
            "rollout discovery and fallback first-turn usage cannot be proven complete."
        )
    usage = _sum_events(auxiliary) or TokenUsage()
    return AuxiliaryUsageAccounting(
        detected=bool(auxiliary),
        included=usage.total_tokens is not None and usage.total_tokens > 0,
        separable=bool(auxiliary),
        usage=usage,
        categories=sorted({event.category or "unknown" for event in auxiliary}),
        full_accounting_established=False,
        limitation=limitation,
    )


def analyze_session(
    harness: Harness,
    paths: list[Path],
    window: SessionWindow,
    clarification: Clarification | None,
) -> NativeSessionAnalysis:
    """Extract all native usage, activity, identity, and planning-quality metrics.

    Parameters:
        harness (Harness): Native CLI session format.
        paths (list[Path]): Redacted native session files.
        window (SessionWindow): Operator-recorded stage boundaries.
        clarification (Clarification | None): Required ambiguity clarification.

    Returns:
        NativeSessionAnalysis: Validated native analysis with explicit limitations.
    """
    records = _read_json_lines(paths)
    usage, stages, warnings = stage_usage(
        harness,
        paths,
        started_at=window.started_at,
        transition_at=window.transition_at,
        stopped_at=window.stopped_at,
    )
    identity_records = records
    if harness is Harness.CODEX:
        identity_records = [
            record
            for path in paths
            if not _codex_rollout_is_auxiliary(path_records := _read_json_lines([path]))
            for record in path_records
        ]
    metadata, metadata_warnings = _actual_metadata(harness, identity_records)
    if harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        events, texts = _pi_activity(records)
    elif harness is Harness.CLAUDE:
        events, texts = _claude_activity(records)
    else:
        events, texts = _codex_activity(records)
    activity, activity_warnings = _activity_breakdown(
        events,
        records_available=bool(records),
        transition_at=window.transition_at,
    )
    planning_quality, planning_warnings = _planning_quality(
        clarification,
        texts,
        window.transition_at,
    )
    auxiliary_usage = _auxiliary_accounting(harness, paths)
    if auxiliary_usage.limitation:
        warnings.append(auxiliary_usage.limitation)
    if usage is None:
        warnings.append("Native token usage is unavailable")
    input_tokens = usage.input_tokens if usage is not None else None
    cache_read_tokens = usage.cache_read_tokens if usage is not None else None
    denominator = (
        input_tokens + cache_read_tokens
        if input_tokens is not None and cache_read_tokens is not None
        else None
    )
    cache_hit_ratio = (
        cache_read_tokens / denominator
        if denominator is not None and denominator > 0 and cache_read_tokens is not None
        else None
    )
    return NativeSessionAnalysis(
        actual_metadata=metadata,
        usage=usage,
        stages=stages,
        activity=activity,
        cache_hit_ratio=cache_hit_ratio,
        planning_quality=planning_quality,
        auxiliary_usage=auxiliary_usage,
        warnings=list(
            dict.fromkeys(warnings + metadata_warnings + activity_warnings + planning_warnings)
        ),
    )
