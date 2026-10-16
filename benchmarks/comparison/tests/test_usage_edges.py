from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from pi_harness_benchmark.fixtures import AMBIGUITY_CLARIFICATION
from pi_harness_benchmark.models import Harness, StageName
from pi_harness_benchmark.usage import (
    SessionWindow,
    analyze_session,
    parse_claude_events,
    parse_codex_events,
    parse_pi_events,
    stage_usage,
)


def test_parsers_skip_malformed_and_zero_usage_records(tmp_path: Path) -> None:
    path = tmp_path / "mixed.jsonl"
    path.write_text(
        "not-json\n"
        + json.dumps({"message": {"role": "user", "usage": {"totalTokens": 2}}})
        + "\n"
        + json.dumps({"message": {"role": "assistant", "usage": "invalid"}})
        + "\n"
        + json.dumps(
            {
                "timestamp": 1_700_000_000_000,
                "message": {
                    "id": "zero",
                    "role": "assistant",
                    "usage": {"input": True, "output": "bad", "totalTokens": 0},
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    assert parse_pi_events([path]) == []
    assert parse_claude_events([path]) == []
    assert parse_codex_events([path]) == []


def test_pi_missing_event_timestamp_returns_explicit_unsplit_stage(tmp_path: Path) -> None:
    path = tmp_path / "pi.json"
    path.write_text(
        json.dumps(
            {
                "message": {
                    "id": "one",
                    "role": "assistant",
                    "usage": {
                        "input": 2,
                        "output": 1,
                        "cacheRead": 3,
                        "cacheWrite": 4,
                        "reasoning": 1,
                        "totalTokens": 10,
                        "cost": "unknown",
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)
    stop = datetime(2026, 1, 1, 0, 0, 2, tzinfo=UTC)

    total, stages, warnings = stage_usage(
        Harness.PI_OPENAI,
        [path],
        started_at=start,
        transition_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=UTC),
        stopped_at=stop,
    )

    assert total is not None
    assert total.total_tokens == 10
    assert stages[0].stage is StageName.UNSPLIT
    assert stages[0].duration_seconds == 2
    assert warnings == [
        "One or more native usage events lack timestamps; response usage is unsplit"
    ]


def test_missing_native_records_leave_counts_nullable_with_warnings() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [],
        SessionWindow(start, start, start),
        AMBIGUITY_CLARIFICATION,
    )

    assert analysis.activity.plan.turns is None
    assert analysis.activity.implementation.tool_calls is None
    assert analysis.activity.combined.blocked_calls is None
    assert analysis.planning_quality.asked_before_choosing is None
    assert any("counts are unavailable" in warning for warning in analysis.warnings)
    assert any("question was asked" in warning for warning in analysis.warnings)


def test_pi_includes_nonoverlapping_nested_tool_result_usage(tmp_path: Path) -> None:
    path = tmp_path / "pi.jsonl"
    records = [
        {
            "type": "session",
            "timestamp": "2026-01-01T00:00:00Z",
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "thinkingLevel": "medium",
        },
        {
            "type": "message",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "id": "main",
                "role": "assistant",
                "content": [],
                "usage": {"input": 6, "output": 4, "totalTokens": 10},
            },
        },
        {
            "type": "message",
            "timestamp": "2026-01-01T00:00:02Z",
            "message": {
                "role": "toolResult",
                "toolCallId": "subagent-call",
                "toolName": "subagent",
                "content": "done",
                "details": {
                    "results": [
                        {
                            "usage": {
                                "input": 3,
                                "output": 2,
                                "cacheRead": 1,
                                "cacheWrite": 0,
                            }
                        },
                        {
                            "usage": {
                                "input": 4,
                                "output": 1,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                            }
                        },
                    ]
                },
            },
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [path],
        SessionWindow(start, start, datetime(2026, 1, 1, 0, 0, 3, tzinfo=UTC)),
        None,
    )

    assert analysis.usage is not None
    assert analysis.usage.total_tokens == 21
    assert analysis.auxiliary_usage.detected
    assert analysis.auxiliary_usage.included
    assert analysis.auxiliary_usage.separable
    assert analysis.auxiliary_usage.usage.total_tokens == 11
    assert not analysis.auxiliary_usage.full_accounting_established
    assert any("auxiliary accounting" in warning.lower() for warning in analysis.warnings)


def test_claude_includes_discovered_sidechain_usage(tmp_path: Path) -> None:
    parent = tmp_path / "parent.jsonl"
    sidechain = tmp_path / "agent-child.jsonl"
    parent.write_text(
        json.dumps(
            {
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:01Z",
                "isSidechain": False,
                "message": {
                    "id": "parent-message",
                    "role": "assistant",
                    "model": "claude-sonnet-5",
                    "content": [],
                    "usage": {"input_tokens": 6, "output_tokens": 4},
                },
            }
        ),
        encoding="utf-8",
    )
    sidechain.write_text(
        json.dumps(
            {
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:02Z",
                "isSidechain": True,
                "agentId": "child",
                "message": {
                    "id": "child-message",
                    "role": "assistant",
                    "model": "claude-haiku-4-5",
                    "content": [],
                    "usage": {"input_tokens": 5, "output_tokens": 2},
                },
            }
        ),
        encoding="utf-8",
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.CLAUDE,
        [parent, sidechain],
        SessionWindow(start, start, datetime(2026, 1, 1, 0, 0, 3, tzinfo=UTC)),
        None,
    )

    assert analysis.actual_metadata.model == "claude-sonnet-5"
    assert analysis.usage is None
    assert not analysis.auxiliary_usage.detected
    assert not analysis.auxiliary_usage.included
    assert analysis.auxiliary_usage.usage.total_tokens is None
    assert analysis.auxiliary_usage.categories == []
    assert not analysis.auxiliary_usage.full_accounting_established
    assert any("usage is unavailable" in warning for warning in analysis.warnings)


def test_codex_includes_each_subagent_final_cumulative_snapshot_once(tmp_path: Path) -> None:
    main = tmp_path / "rollout-main.jsonl"
    child = tmp_path / "rollout-child.jsonl"
    main_records = [
        {
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": "main",
                "cwd": str(tmp_path),
                "model_provider": "openai",
                "source": "cli",
            },
        },
        {
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.6-terra", "reasoning_effort": "medium"},
        },
        {
            "timestamp": "2026-01-01T00:00:01Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 70,
                        "output_tokens": 30,
                        "total_tokens": 100,
                    }
                },
            },
        },
        {
            "timestamp": "2026-01-01T00:00:03Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 140,
                        "output_tokens": 60,
                        "total_tokens": 200,
                    }
                },
            },
        },
    ]
    child_records = [
        {
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": "child",
                "cwd": str(tmp_path),
                "model_provider": "openai",
                "source": {"subagent": {"thread_spawn": {"parent": "main"}}},
                "parent_thread_id": "main",
            },
        },
        {
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.1-codex-mini", "reasoning_effort": "low"},
        },
        {
            "timestamp": "2026-01-01T00:00:01Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 35,
                        "output_tokens": 15,
                        "total_tokens": 50,
                    },
                    "last_token_usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0,
                    },
                },
            },
        },
        {
            "timestamp": "2026-01-01T00:00:04Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 60,
                        "output_tokens": 30,
                        "total_tokens": 90,
                    },
                    "last_token_usage": {
                        "input_tokens": 20,
                        "output_tokens": 10,
                        "total_tokens": 30,
                    },
                },
            },
        },
    ]
    main.write_text("\n".join(json.dumps(record) for record in main_records), encoding="utf-8")
    child.write_text("\n".join(json.dumps(record) for record in child_records), encoding="utf-8")
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.CODEX,
        [main, child],
        SessionWindow(
            start,
            datetime(2026, 1, 1, 0, 0, 2, tzinfo=UTC),
            datetime(2026, 1, 1, 0, 0, 5, tzinfo=UTC),
        ),
        None,
    )

    assert analysis.actual_metadata.model == "gpt-5.6-terra"
    assert analysis.actual_metadata.reasoning_level == "medium"
    assert analysis.usage is not None
    assert analysis.stages[0].usage is not None
    assert analysis.stages[1].usage is not None
    assert analysis.usage.total_tokens == 230
    assert analysis.stages[0].usage.total_tokens == 100
    assert analysis.stages[1].usage.total_tokens == 130
    assert analysis.auxiliary_usage.detected
    assert analysis.auxiliary_usage.included
    assert analysis.auxiliary_usage.separable
    assert analysis.auxiliary_usage.usage.total_tokens == 30
    assert analysis.auxiliary_usage.categories == ["subagent"]
    assert not analysis.auxiliary_usage.full_accounting_established


def test_ambiguity_choice_without_question_fails_planning_quality(tmp_path: Path) -> None:
    path = tmp_path / "pi.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "message",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "id": "choice",
                    "role": "assistant",
                    "content": "I will apply limit after filtering and ordering.",
                    "usage": {"input": 1, "output": 1, "totalTokens": 2},
                },
            }
        ),
        encoding="utf-8",
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [path],
        SessionWindow(
            start,
            datetime(2026, 1, 1, 0, 0, 2, tzinfo=UTC),
            datetime(2026, 1, 1, 0, 0, 3, tzinfo=UTC),
        ),
        AMBIGUITY_CLARIFICATION,
    )

    assert analysis.planning_quality.asked_before_choosing is False
    assert analysis.planning_quality.evidence is not None


def test_metadata_only_session_keeps_usage_unavailable(tmp_path: Path) -> None:
    path = tmp_path / "pi.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "session",
                "provider": "anthropic",
                "model": "claude-sonnet-5",
                "thinkingLevel": "medium",
            }
        ),
        encoding="utf-8",
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [path],
        SessionWindow(start, start, start),
        None,
    )

    assert analysis.usage is None
    assert analysis.stages[0].usage is None
    assert analysis.cache_hit_ratio is None
    assert any(
        "usage" in warning.lower() and "unavailable" in warning.lower()
        for warning in analysis.warnings
    )


def test_invalid_usage_categories_remain_nullable(tmp_path: Path) -> None:
    path = tmp_path / "pi.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "message",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {
                    "id": "one",
                    "role": "assistant",
                    "content": [],
                    "usage": {"input": "invalid", "output": 2, "totalTokens": 3},
                },
            }
        ),
        encoding="utf-8",
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [path],
        SessionWindow(start, start, start),
        None,
    )

    assert analysis.usage is not None
    assert analysis.usage.input_tokens is None
    assert analysis.usage.output_tokens == 2
    assert analysis.usage.total_tokens == 3


def test_codex_without_token_snapshots_is_unavailable_and_unsplit(tmp_path: Path) -> None:
    path = tmp_path / "codex.json"
    path.write_text(
        json.dumps([{"type": "event_msg", "payload": {"type": "other"}}]), encoding="utf-8"
    )
    start = datetime(2026, 1, 1, tzinfo=UTC)

    total, stages, warnings = stage_usage(
        Harness.CODEX,
        [path],
        started_at=start,
        transition_at=None,
        stopped_at=start,
    )

    assert total is None
    assert stages[0].usage is None
    assert stages[0].source_events == 0
    assert warnings
