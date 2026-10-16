from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from pi_harness_benchmark.models import (
    ActivityBreakdown,
    ActualExecutionMetadata,
    AuxiliaryUsageAccounting,
    BenchmarkResult,
    DocumentationStatus,
    Fixture,
    GateResult,
    GateSuite,
    GitSnapshot,
    Harness,
    InteractionCounts,
    PlanArtifact,
    PlanningQuality,
    Provider,
    RunSpec,
    RunStatus,
    SeedVerification,
    StageMetrics,
    StageName,
    TokenUsage,
)
from pi_harness_benchmark.report import build_report, load_results, write_report

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def _result(
    root: Path,
    *,
    harness: Harness,
    provider: Provider,
    repetition: int,
    wall: float,
    fixture: Fixture = Fixture.LOCALIZED_BUG,
    tokens: int,
    passed: bool,
) -> BenchmarkResult:
    run_id = f"{provider}-{fixture}-{harness}-{repetition}"
    result_path = root / run_id / "result.json"
    gate = GateResult(
        name="test",
        command=["/usr/bin/true"],
        exit_code=0 if passed else 1,
        passed=passed,
        duration_seconds=1,
        output_path=root / "gate.log",
    )
    counts = InteractionCounts(
        turns=2,
        tool_calls=3,
        blocked_calls=1,
        tool_calls_by_name={"read": 1, "write": 2},
        blocked_calls_by_name={"write": 1},
    )
    return BenchmarkResult(
        schema_version="3.0",
        status=RunStatus.FINALIZED,
        spec=RunSpec(
            run_id=run_id,
            pair=provider,
            harness=harness,
            fixture=fixture,
            repetition=repetition,
            pair_order=1 if harness.value.startswith("pi-") else 2,
            matrix_position=repetition,
            reasoning_level="medium",
            model="model",
            documentation_required=fixture is Fixture.CROSS_FILE_FEATURE,
        ),
        seed_commit="a" * 40,
        prompt_path=root / "prompt.txt",
        prompt_sha256="b" * 64,
        launch_argv=["/usr/bin/true"],
        terminal_log_path=root / "terminal.log",
        accepted_plan=PlanArtifact(
            path=root / "accepted-plan.md",
            captured=True,
            sha256="c" * 64,
            byte_count=20,
        ),
        seed_verification=SeedVerification(
            expected_commit="a" * 40,
            clone_head_at_prepare="a" * 40,
            verified_at_start=NOW,
            generated_seed_head_at_finalize="a" * 40,
            seed_is_final_ancestor=True,
            contamination_paths=[],
        ),
        prepared_at=NOW,
        agent_started_at=NOW,
        implementation_started_at=NOW + timedelta(seconds=2),
        stopped_at=NOW + timedelta(seconds=wall),
        finalized_at=NOW + timedelta(seconds=wall + 1),
        wall_duration_seconds=wall,
        stages=[
            StageMetrics(
                stage=StageName.PLAN,
                started_at=NOW,
                ended_at=NOW + timedelta(seconds=2),
                duration_seconds=2,
                usage=TokenUsage(total_tokens=10),
                source_events=1,
            ),
            StageMetrics(
                stage=StageName.IMPLEMENTATION,
                started_at=NOW + timedelta(seconds=2),
                ended_at=NOW + timedelta(seconds=wall),
                duration_seconds=wall - 2,
                usage=TokenUsage(total_tokens=tokens - 10),
                source_events=1,
            ),
        ],
        usage=TokenUsage(input_tokens=tokens - 10, output_tokens=10, total_tokens=tokens),
        actual_metadata=ActualExecutionMetadata(
            provider=provider.value,
            model="claude-sonnet-5" if provider is Provider.ANTHROPIC else "gpt-5.6-terra",
            reasoning_level="medium",
        ),
        activity=ActivityBreakdown(plan=counts, implementation=counts, combined=counts),
        cache_hit_ratio=0.25,
        planning_quality=PlanningQuality(
            required=False,
            asked_before_choosing=None,
            evidence=None,
        ),
        auxiliary_usage=AuxiliaryUsageAccounting(
            detected=False,
            included=False,
            separable=False,
            usage=TokenUsage(),
            categories=[],
            full_accounting_established=False,
            limitation="Equivalent complete auxiliary accounting is unavailable",
        ),
        visible_gate=GateSuite(
            name="visible",
            subgates=[gate],
            passed=passed,
            environment_path=root / "gate-environment",
        ),
        hidden_gate=GateSuite(
            name="hidden",
            subgates=[gate],
            passed=passed,
            environment_path=root / "hidden-gate-environment",
        ),
        success=passed,
        failure_reason=None if passed else "test failure",
        documentation_status=DocumentationStatus.UPDATED,
        git=GitSnapshot(
            head="a" * 40,
            diff_path=root / "agent.diff",
            diff_stat_path=root / "agent.diffstat",
            changed_paths=["src/module.py"],
            dirty=True,
            patch_bytes=100,
            patch_lines=10,
            added_lines=6,
            deleted_lines=2,
        ),
        sessions=[],
        cli_version="1.0",
        parser_warnings=[],
        result_path=result_path,
    )


def test_report_calculates_medians_and_pass_rates_only_within_pair(tmp_path: Path) -> None:
    results = [
        _result(
            tmp_path,
            harness=Harness.PI_ANTHROPIC,
            provider=Provider.ANTHROPIC,
            repetition=1,
            wall=10,
            tokens=100,
            passed=True,
        ),
        _result(
            tmp_path,
            harness=Harness.CLAUDE,
            provider=Provider.ANTHROPIC,
            repetition=1,
            wall=14,
            tokens=80,
            passed=False,
        ),
        _result(
            tmp_path,
            harness=Harness.PI_OPENAI,
            provider=Provider.OPENAI,
            repetition=1,
            wall=20,
            tokens=200,
            passed=True,
        ),
        _result(
            tmp_path,
            harness=Harness.CODEX,
            provider=Provider.OPENAI,
            repetition=1,
            wall=16,
            tokens=240,
            passed=True,
        ),
    ]

    report = build_report(results)

    assert report["aggregation"] == "within-provider pairs only"
    assert len(report["pairs"]) == 2
    anthropic = next(pair for pair in report["pairs"] if pair["provider_pair"] == "anthropic")
    pi_summary = anthropic["harnesses"]["pi-anthropic"]
    claude_summary = anthropic["harnesses"]["claude"]
    assert pi_summary["successful_only"]["combined_tokens"] == {
        "n": 1,
        "expected_n": 1,
        "partial": False,
        "available": True,
        "median": 100.0,
        "min": 100.0,
        "max": 100.0,
    }
    assert claude_summary["successful_runs"] == 0
    assert not claude_summary["successful_only"]["combined_tokens"]["available"]
    assert claude_summary["success_rate"] == {"value": 0.0, "n": 1}
    assert anthropic["winner_claim"] is None
    assert not report["global_decision"]["pi_claimed"]


def test_report_suppresses_partial_usage_samples_and_reports_n(tmp_path: Path) -> None:
    available = _result(
        tmp_path,
        harness=Harness.PI_OPENAI,
        provider=Provider.OPENAI,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    unavailable = _result(
        tmp_path,
        harness=Harness.PI_OPENAI,
        provider=Provider.OPENAI,
        repetition=2,
        wall=11,
        tokens=20,
        passed=True,
    )
    unavailable.usage = None

    summary = build_report([available, unavailable])["pairs"][0]["harnesses"]["pi-openai"]
    tokens = summary["successful_only"]["combined_tokens"]

    assert tokens["n"] == 1
    assert tokens["expected_n"] == 2
    assert tokens["partial"] is True
    assert tokens["median"] is None
    assert any("partial" in limitation.lower() for limitation in summary["limitations"])
    for metric in summary["successful_only"].values():
        assert "n" in metric


def test_report_excludes_equal_but_unapproved_actual_model(tmp_path: Path) -> None:
    pi_result = _result(
        tmp_path,
        harness=Harness.PI_ANTHROPIC,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    claude_result = _result(
        tmp_path,
        harness=Harness.CLAUDE,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    pi_result.actual_metadata.model = "claude-opus-5"
    claude_result.actual_metadata.model = "claude-opus-5"

    pair = build_report([pi_result, claude_result])["pairs"][0]

    assert not pair["parity_eligible"]
    assert any("expected" in limitation.lower() for limitation in pair["limitations"])


def test_report_excludes_equal_but_wrong_reasoning_level(tmp_path: Path) -> None:
    pi_result = _result(
        tmp_path,
        harness=Harness.PI_OPENAI,
        provider=Provider.OPENAI,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    codex_result = _result(
        tmp_path,
        harness=Harness.CODEX,
        provider=Provider.OPENAI,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    pi_result.actual_metadata.reasoning_level = "high"
    codex_result.actual_metadata.reasoning_level = "high"

    pair = build_report([pi_result, codex_result])["pairs"][0]

    assert not pair["parity_eligible"]
    assert any("medium" in limitation.lower() for limitation in pair["limitations"])


def test_report_rejects_nonchronological_matrix_starts(tmp_path: Path) -> None:
    first = _result(
        tmp_path,
        harness=Harness.PI_ANTHROPIC,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    second = _result(
        tmp_path,
        harness=Harness.CLAUDE,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    first.spec.matrix_position = 1
    second.spec.matrix_position = 2
    first.agent_started_at = NOW + timedelta(seconds=2)
    second.agent_started_at = NOW + timedelta(seconds=1)

    with pytest.raises(ValueError, match="chronological"):
        build_report([first, second])


def test_report_excludes_actual_model_mismatch_from_winner_claim(tmp_path: Path) -> None:
    pi_result = _result(
        tmp_path,
        harness=Harness.PI_ANTHROPIC,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    claude_result = _result(
        tmp_path,
        harness=Harness.CLAUDE,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    claude_result.actual_metadata.model = "claude-opus-5"

    report = build_report([pi_result, claude_result])
    pair = report["pairs"][0]

    assert not pair["parity_eligible"]
    assert pair["winner_claim"] is None
    assert any("model mismatch" in limitation.lower() for limitation in pair["limitations"])


def test_report_excludes_protocol_invalid_run_from_winner_claim(tmp_path: Path) -> None:
    pi_result = _result(
        tmp_path,
        harness=Harness.PI_ANTHROPIC,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    claude_result = _result(
        tmp_path,
        harness=Harness.CLAUDE,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    claude_result.protocol_valid = False
    claude_result.protocol_violations = ["Operator supplied an unapproved product answer."]

    report = build_report([pi_result, claude_result])
    pair = report["pairs"][0]

    assert not pair["parity_eligible"]
    assert pair["winner_claim"] is None
    assert any("protocol-invalid" in limitation.lower() for limitation in pair["limitations"])


def test_report_excludes_missing_actual_identity(tmp_path: Path) -> None:
    pi_result = _result(
        tmp_path,
        harness=Harness.PI_OPENAI,
        provider=Provider.OPENAI,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )
    codex_result = _result(
        tmp_path,
        harness=Harness.CODEX,
        provider=Provider.OPENAI,
        repetition=1,
        wall=9,
        tokens=90,
        passed=True,
    )
    codex_result.actual_metadata.model = None

    pair = build_report([pi_result, codex_result])["pairs"][0]

    assert not pair["parity_eligible"]
    assert pair["winner_claim"] is None
    assert any("identity absent" in limitation.lower() for limitation in pair["limitations"])


def test_report_requires_exact_fixture_repetition_cells_for_completeness(
    tmp_path: Path,
) -> None:
    results: list[BenchmarkResult] = []
    position = 0
    for repetition in range(1, 10):
        for harness in (Harness.PI_ANTHROPIC, Harness.CLAUDE):
            position += 1
            result = _result(
                tmp_path,
                harness=harness,
                provider=Provider.ANTHROPIC,
                repetition=repetition,
                wall=10,
                tokens=100,
                passed=True,
            )
            result.spec.matrix_position = position
            results.append(result)

    pair = build_report(results)["pairs"][0]

    assert pair["matched_runs"] == 9
    assert not pair["complete"]
    assert pair["winner_claim"] is None
    assert any("unexpected" in limitation.lower() for limitation in pair["limitations"])


def test_global_efficiency_claim_follows_pairwise_rule_with_auxiliary_limitation(
    tmp_path: Path,
) -> None:
    results: list[BenchmarkResult] = []
    position = 0
    for provider, harnesses in {
        Provider.ANTHROPIC: (Harness.PI_ANTHROPIC, Harness.CLAUDE),
        Provider.OPENAI: (Harness.PI_OPENAI, Harness.CODEX),
    }.items():
        for fixture in Fixture:
            for repetition in range(1, 4):
                for harness in harnesses:
                    position += 1
                    result = _result(
                        tmp_path,
                        harness=harness,
                        provider=provider,
                        fixture=fixture,
                        repetition=repetition,
                        wall=10 if harness.value.startswith("pi-") else 12,
                        tokens=100 if harness.value.startswith("pi-") else 120,
                        passed=True,
                    )
                    result.spec.matrix_position = position
                    results.append(result)

    report = build_report(results)

    assert all(pair["complete"] for pair in report["pairs"])
    assert all(pair["parity_eligible"] for pair in report["pairs"])
    assert all(pair["winner_claim"].startswith("pi-") for pair in report["pairs"])
    assert all(
        any("auxiliary accounting" in limitation.lower() for limitation in pair["limitations"])
        for pair in report["pairs"]
    )
    assert report["global_decision"]["pi_observed_rule_met"]
    assert report["global_decision"]["pi_claimed"]
    assert not report["auxiliary_accounting"]["equivalent_full_accounting_established"]
    assert "auxiliary" in report["auxiliary_accounting"]["limitation"].lower()
    assert "both complete eligible provider pairs" in report["decision_rule"]


def test_report_rejects_duplicate_run_ids(tmp_path: Path) -> None:
    result = _result(
        tmp_path,
        harness=Harness.PI_ANTHROPIC,
        provider=Provider.ANTHROPIC,
        repetition=1,
        wall=10,
        tokens=100,
        passed=True,
    )

    with pytest.raises(ValueError, match="Duplicate `run_id`"):
        build_report([result, result])


def test_write_and_load_results(tmp_path: Path) -> None:
    result = _result(
        tmp_path,
        harness=Harness.PI_OPENAI,
        provider=Provider.OPENAI,
        repetition=1,
        wall=8,
        tokens=50,
        passed=True,
    )
    result.result_path.parent.mkdir(parents=True)
    result.result_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    report_path = tmp_path / "report.json"

    loaded = load_results(tmp_path)
    report = write_report(tmp_path, report_path)

    assert [item.spec.run_id for item in loaded] == [result.spec.run_id]
    assert report["result_count"] == 1
    assert report_path.is_file()
    markdown_path = report_path.with_suffix(".md")
    assert markdown_path.is_file()
    markdown = markdown_path.read_text(encoding="utf-8")
    assert "Provider pair" in markdown
    assert "Matched native - Pi median deltas" in markdown
    assert "Auxiliary accounting limitation" in markdown
    assert report["decision_rule"] in markdown
