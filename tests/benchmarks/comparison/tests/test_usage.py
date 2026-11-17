from __future__ import annotations

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

START = datetime(2026, 1, 1, tzinfo=UTC)
TRANSITION = datetime(2026, 1, 1, 0, 0, 10, tzinfo=UTC)
STOP = datetime(2026, 1, 1, 0, 0, 20, tzinfo=UTC)


def test_pi_sums_finalized_assistant_messages(sample_dir: Path) -> None:
    events = parse_pi_events([sample_dir / "pi-session.jsonl"])

    total, stages, warnings = stage_usage(
        Harness.PI_ANTHROPIC,
        [sample_dir / "pi-session.jsonl"],
        started_at=START,
        transition_at=TRANSITION,
        stopped_at=STOP,
    )

    assert len(events) == 2
    assert total is not None
    assert stages[0].usage is not None
    assert stages[1].usage is not None
    assert total.model_dump() == {
        "input_tokens": 130,
        "output_tokens": 28,
        "cache_read_tokens": 170,
        "cache_write_tokens": 10,
        "reasoning_tokens": 10,
        "total_tokens": 338,
        "cost_usd": 0.03,
    }
    assert [stage.stage for stage in stages] == [StageName.PLAN, StageName.IMPLEMENTATION]
    assert stages[0].usage.total_tokens == 180
    assert stages[1].usage.total_tokens == 158
    assert not warnings


def test_claude_deduplicates_content_chunks_and_keeps_reasoning(sample_dir: Path) -> None:
    events = parse_claude_events([sample_dir / "claude-session.jsonl"])

    total, stages, warnings = stage_usage(
        Harness.CLAUDE,
        [sample_dir / "claude-session.jsonl"],
        started_at=START,
        transition_at=TRANSITION,
        stopped_at=STOP,
    )

    assert len(events) == 2
    assert total is not None
    assert stages[0].usage is not None
    assert stages[1].usage is not None
    assert total.input_tokens == 17
    assert total.output_tokens == 29
    assert total.cache_read_tokens == 140
    assert total.cache_write_tokens == 30
    assert total.reasoning_tokens == 13
    assert total.total_tokens == 216
    assert stages[0].usage.total_tokens == 100
    assert stages[1].usage.total_tokens == 116
    assert not warnings


def test_codex_uses_final_cumulative_snapshots_at_boundary(sample_dir: Path) -> None:
    events = parse_codex_events([sample_dir / "codex-session.jsonl"])

    total, stages, warnings = stage_usage(
        Harness.CODEX,
        [sample_dir / "codex-session.jsonl"],
        started_at=START,
        transition_at=TRANSITION,
        stopped_at=STOP,
    )

    assert len(events) == 3
    assert total is not None
    assert stages[0].usage is not None
    assert stages[1].usage is not None
    assert total.input_tokens == 150
    assert total.cache_read_tokens == 250
    assert total.output_tokens == 90
    assert total.reasoning_tokens == 40
    assert total.total_tokens == 490
    assert stages[0].usage.total_tokens == 215
    assert stages[1].usage.total_tokens == 275
    assert stages[1].usage.input_tokens == 70
    assert stages[1].usage.cache_read_tokens == 150
    assert not warnings


def test_pi_analysis_extracts_counts_actual_metadata_and_question(sample_dir: Path) -> None:
    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [sample_dir / "pi-session.jsonl"],
        SessionWindow(START, TRANSITION, STOP),
        AMBIGUITY_CLARIFICATION,
    )

    assert analysis.actual_metadata.model == "claude-sonnet-5"
    assert analysis.actual_metadata.provider == "anthropic"
    assert analysis.actual_metadata.reasoning_level == "medium"
    assert analysis.activity.plan.turns == 1
    assert analysis.activity.plan.tool_calls == 1
    assert analysis.activity.implementation.turns == 1
    assert analysis.activity.implementation.blocked_calls == 1
    assert analysis.activity.combined.turns == 2
    assert analysis.activity.combined.tool_calls_by_name == {"edit": 1, "read": 1}
    assert analysis.cache_hit_ratio == 170 / 300
    assert analysis.planning_quality.asked_before_choosing is True
    assert not analysis.auxiliary_usage.detected
    assert not analysis.auxiliary_usage.full_accounting_established
    assert any("auxiliary accounting" in warning.lower() for warning in analysis.warnings)


def test_pi_metadata_reads_native_thinking_level_change(tmp_path: Path) -> None:
    session = tmp_path / "pi-native.jsonl"
    session.write_text(
        '{"type":"session","timestamp":"2026-01-01T00:00:00Z"}\n'
        '{"type":"model_change","timestamp":"2026-01-01T00:00:01Z",'
        '"provider":"anthropic","modelId":"claude-sonnet-5"}\n'
        '{"type":"thinking_level_change","timestamp":"2026-01-01T00:00:02Z",'
        '"thinkingLevel":"medium"}\n',
        encoding="utf-8",
    )

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [session],
        SessionWindow(START, TRANSITION, STOP),
        None,
    )

    assert analysis.actual_metadata.provider == "anthropic"
    assert analysis.actual_metadata.model == "claude-sonnet-5"
    assert analysis.actual_metadata.reasoning_level == "medium"


def test_claude_analysis_uses_message_model_and_warns_for_missing_reasoning(
    sample_dir: Path,
) -> None:
    analysis = analyze_session(
        Harness.CLAUDE,
        [sample_dir / "claude-session.jsonl"],
        SessionWindow(START, TRANSITION, STOP),
        AMBIGUITY_CLARIFICATION,
    )

    assert analysis.actual_metadata.model == "claude-sonnet-5"
    assert analysis.actual_metadata.provider == "anthropic"
    assert analysis.actual_metadata.reasoning_level is None
    assert analysis.activity.combined.turns == 2
    assert analysis.activity.combined.tool_calls == 2
    assert analysis.activity.combined.blocked_calls == 1
    assert analysis.planning_quality.asked_before_choosing is True
    assert any("reasoning" in warning.lower() for warning in analysis.warnings)


def test_codex_analysis_uses_session_metadata_and_cumulative_boundaries(
    sample_dir: Path,
) -> None:
    analysis = analyze_session(
        Harness.CODEX,
        [sample_dir / "codex-session.jsonl"],
        SessionWindow(START, TRANSITION, STOP),
        AMBIGUITY_CLARIFICATION,
    )

    assert analysis.actual_metadata.provider == "openai"
    assert analysis.actual_metadata.model == "gpt-5.6-terra"
    assert analysis.actual_metadata.reasoning_level == "medium"
    assert analysis.activity.plan.turns == 1
    assert analysis.activity.implementation.turns == 1
    assert analysis.activity.combined.tool_calls == 2
    assert analysis.activity.combined.blocked_calls == 1
    assert analysis.planning_quality.asked_before_choosing is True
    assert analysis.usage is not None
    assert analysis.stages[0].usage is not None
    assert analysis.usage.total_tokens == 490
    assert analysis.stages[0].usage.total_tokens == 215


def test_missing_transition_produces_unsplit_warning(sample_dir: Path) -> None:
    total, stages, warnings = stage_usage(
        Harness.CODEX,
        [sample_dir / "codex-session.jsonl"],
        started_at=START,
        transition_at=None,
        stopped_at=STOP,
    )

    assert total is not None
    assert total.total_tokens == 490
    assert len(stages) == 1
    assert stages[0].stage is StageName.UNSPLIT
    assert warnings == ["No plan transition timestamp; Codex usage is unsplit"]
