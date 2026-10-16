from __future__ import annotations

import json
from itertools import pairwise
from pathlib import Path

import pytest
from pydantic import ValidationError

from pi_harness_benchmark.matrix import MODEL_BY_HARNESS, generate_matrix
from pi_harness_benchmark.models import BenchmarkResult, Harness, Provider, RunSpec, TokenUsage
from pi_harness_benchmark.prepare import write_matrix


def test_matrix_has_36_unique_balanced_runs() -> None:
    runs = generate_matrix()

    assert len(runs) == 36
    assert len({run.run_id for run in runs}) == 36
    assert [run.matrix_position for run in runs] == list(range(1, 37))
    for harness in Harness:
        selected = [run for run in runs if run.harness is harness]
        assert len(selected) == 9
        assert {run.model for run in selected} == {MODEL_BY_HARNESS[harness]}
        assert {run.reasoning_level for run in selected} == {"medium"}


def test_fixed_clarification_is_identical_for_every_ambiguity_run() -> None:
    runs = generate_matrix()
    ambiguity_runs = [run for run in runs if run.fixture.value == "ambiguity-heavy-change"]
    other_runs = [run for run in runs if run.fixture.value != "ambiguity-heavy-change"]

    assert len(ambiguity_runs) == 12
    assert {
        run.clarification.answer for run in ambiguity_runs if run.clarification is not None
    } == {
        "`limit` counts emitted active records after filtering and deterministic ordering, not "
        "input rows."
    }
    assert all(run.clarification is not None for run in ambiguity_runs)
    assert all(run.clarification is None for run in other_runs)


def test_only_cross_file_feature_requires_documentation_update() -> None:
    runs = generate_matrix()

    assert all(
        run.documentation_required is (run.fixture.value == "cross-file-feature") for run in runs
    )


def test_pair_order_alternates_independently() -> None:
    runs = generate_matrix()

    for provider in Provider:
        first_members = [
            run.harness for run in runs if run.pair is provider and run.pair_order == 1
        ]
        assert all(left is not right for left, right in pairwise(first_members))


def test_run_spec_rejects_cross_provider_harness() -> None:
    with pytest.raises(ValidationError, match="does not belong"):
        RunSpec(
            run_id="bad",
            pair=Provider.ANTHROPIC,
            harness=Harness.CODEX,
            fixture="localized-bug",
            repetition=1,
            pair_order=1,
            matrix_position=1,
            reasoning_level="medium",
            model="gpt-5.6-terra",
            documentation_required=False,
        )


def test_models_forbid_unknown_fields() -> None:
    with pytest.raises(ValidationError, match="Extra inputs"):
        TokenUsage.model_validate({"input_tokens": 1, "invented": 2})


def test_token_total_includes_cache_but_not_reasoning_twice() -> None:
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        cache_read_tokens=20,
        cache_write_tokens=2,
        reasoning_tokens=4,
    )

    assert usage.total_tokens == 37


def test_wall_duration_schema_documents_start_to_stop() -> None:
    schema = BenchmarkResult.model_json_schema()

    description = schema["properties"]["wall_duration_seconds"]["description"]
    assert description == "Agent start-to-stop wall duration."


def test_write_matrix_emits_plain_valid_json(tmp_path: Path) -> None:
    destination = tmp_path / "nested" / "matrix.json"

    write_matrix(destination, generate_matrix())

    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert len(payload) == 36
    assert payload[0]["matrix_position"] == 1
