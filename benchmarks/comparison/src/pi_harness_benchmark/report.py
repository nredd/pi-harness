"""Produce actual-identity provider-paired reports without cross-provider aggregation.

References:
- https://docs.python.org/3/library/statistics.html
"""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pi_harness_benchmark.matrix import PAIR_MEMBERS, REPETITIONS
from pi_harness_benchmark.models import BenchmarkResult, Fixture, Harness, Provider, StageName

if TYPE_CHECKING:
    from collections.abc import Callable

AUXILIARY_ACCOUNTING_LIMITATION = (
    "Native Pi tool-result, Claude sidechain, and Codex rollout schemas do not guarantee "
    "equivalent complete classifier/subagent discovery; token medians include detected auxiliary "
    "usage but are not complete cross-harness efficiency measurements."
)
GLOBAL_DECISION_RULE = (
    "Say Pi is more token-efficient only if both complete eligible provider pairs have Pi pass "
    "rate greater than or equal to native pass rate and Pi successful-run median combined tokens "
    "lower than native successful-run median combined tokens."
)
EXPECTED_RUNS_PER_HARNESS = len(Fixture) * REPETITIONS
EXPECTED_MODEL_BY_PROVIDER = {
    Provider.ANTHROPIC: "claude-sonnet-5",
    Provider.OPENAI: "gpt-5.6-terra",
}
EXPECTED_REASONING_LEVEL = "medium"


def load_results(root: Path) -> list[BenchmarkResult]:
    """Discover and validate finalized result records.

    Parameters:
        root (Path): Benchmark project root or result tree.

    Returns:
        list[BenchmarkResult]: Validated results sorted by matrix position.
    """
    root = Path(str(root)).resolve()
    results = [
        BenchmarkResult.model_validate_json(path.read_text(encoding="utf-8"))
        for path in root.rglob("result.json")
    ]
    return sorted(results, key=lambda result: result.spec.matrix_position)


def _metric(values: list[int | float], expected_n: int) -> dict[str, int | float | bool | None]:
    """Return median and range for a nonempty metric sample.

    Parameters:
        values (list[int | float]): Numeric observations.

    Returns:
        dict[str, int | float | bool | None]: Availability, sample size, median, and range.
    """
    complete = bool(values) and len(values) == expected_n
    return {
        "n": len(values),
        "expected_n": expected_n,
        "partial": 0 < len(values) < expected_n,
        "available": complete,
        "median": float(statistics.median(values)) if complete else None,
        "min": float(min(values)) if complete else None,
        "max": float(max(values)) if complete else None,
    }


def _plan_token_share(result: BenchmarkResult) -> float | None:
    """Return plan tokens divided by combined tokens.

    Parameters:
        result (BenchmarkResult): Successful finalized result.

    Returns:
        float | None: Plan share when split token data exists.
    """
    if result.usage is None or not result.usage.total_tokens:
        return None
    plan = next((stage for stage in result.stages if stage.stage is StageName.PLAN), None)
    plan_tokens = plan.usage.total_tokens if plan and plan.usage is not None else None
    return plan_tokens / result.usage.total_tokens if plan_tokens is not None else None


def _optional_values(
    results: list[BenchmarkResult], getter: Callable[[BenchmarkResult], int | float | None]
) -> list[int | float]:
    """Collect measurable values without converting unknowns to zero.

    Parameters:
        results (list[BenchmarkResult]): Successful results.
        getter (Callable[[BenchmarkResult], int | float | None]): Metric accessor.

    Returns:
        list[int | float]: Available observations.
    """
    return [value for result in results if (value := getter(result)) is not None]


def _rate(passed: int, count: int) -> dict[str, int | float | None]:
    """Return a pass-rate metric with its explicit sample size.

    Parameters:
        passed (int): Passing observations.
        count (int): Total observations.

    Returns:
        dict[str, int | float | None]: Rate value and sample size.
    """
    return {"value": passed / count if count else None, "n": count}


def _harness_summary(results: list[BenchmarkResult]) -> dict[str, Any]:
    """Summarize one harness using successful runs only for performance metrics.

    Parameters:
        results (list[BenchmarkResult]): Same-provider harness results.

    Returns:
        dict[str, Any]: Pass rates, successful-only metrics, and limitations.
    """
    count = len(results)
    successful = [result for result in results if result.success]
    expected_n = len(successful)
    metrics = {
        "combined_tokens": _metric(
            _optional_values(
                successful,
                lambda result: result.usage.total_tokens if result.usage is not None else None,
            ),
            expected_n,
        ),
        "plan_token_share": _metric(_optional_values(successful, _plan_token_share), expected_n),
        "turns": _metric(
            _optional_values(successful, lambda result: result.activity.combined.turns),
            expected_n,
        ),
        "tool_calls": _metric(
            _optional_values(successful, lambda result: result.activity.combined.tool_calls),
            expected_n,
        ),
        "blocked_calls": _metric(
            _optional_values(successful, lambda result: result.activity.combined.blocked_calls),
            expected_n,
        ),
        "elapsed_seconds": _metric(
            [result.wall_duration_seconds for result in successful], expected_n
        ),
        "cache_hit_ratio": _metric(
            _optional_values(successful, lambda result: result.cache_hit_ratio), expected_n
        ),
    }
    limitations = [
        f"Successful-run metric '{name}' has a partial sample "
        f"({metric['n']}/{metric['expected_n']}) and is suppressed"
        for name, metric in metrics.items()
        if expected_n and metric["n"] != expected_n
    ]
    return {
        "runs": count,
        "successful_runs": len(successful),
        "visible_pass_rate": _rate(sum(result.visible_gate.passed for result in results), count),
        "hidden_pass_rate": _rate(sum(result.hidden_gate.passed for result in results), count),
        "success_rate": _rate(sum(result.success for result in results), count),
        "successful_only": metrics,
        "auxiliary_usage": {
            "detected_runs": sum(result.auxiliary_usage.detected for result in results),
            "included_runs": sum(result.auxiliary_usage.included for result in results),
            "separable_runs": sum(result.auxiliary_usage.separable for result in results),
            "full_accounting_runs": sum(
                result.auxiliary_usage.full_accounting_established for result in results
            ),
        },
        "limitations": limitations,
    }


def _normalized_provider(provider: str | None) -> str | None:
    """Normalize native provider aliases only for pair identity checks.

    Parameters:
        provider (str | None): Raw native provider value.

    Returns:
        str | None: Provider-pair identity.
    """
    if provider == "openai-codex":
        return "openai"
    return provider


def _identity_limitations(
    result: BenchmarkResult,
    provider: Provider,
    identities: dict[str, dict[str, set[str]]],
) -> list[str]:
    """Retain raw identity and return per-run parity limitations.

    Parameters:
        result (BenchmarkResult): Finalized run.
        provider (Provider): Expected provider pair.
        identities (dict[str, dict[str, set[str]]]): Mutable raw identity index.

    Returns:
        list[str]: Identity absence or mismatch limitations.
    """
    metadata = result.actual_metadata
    identity = identities[result.spec.harness.value]
    if metadata.provider:
        identity["providers"].add(metadata.provider)
    if metadata.model:
        identity["models"].add(metadata.model)
    if metadata.reasoning_level:
        identity["reasoning_levels"].add(metadata.reasoning_level)
    limitations: list[str] = []
    if metadata.provider is None or metadata.model is None:
        limitations.append(f"Exact actual identity absent for run '{result.spec.run_id}'")
    if _normalized_provider(metadata.provider) != provider.value:
        limitations.append(
            f"Actual provider mismatch for run '{result.spec.run_id}': '{metadata.provider}'"
        )
    expected_model = EXPECTED_MODEL_BY_PROVIDER[provider]
    if metadata.model != expected_model:
        limitations.append(
            f"Actual model for run '{result.spec.run_id}' differs from expected "
            f"'{expected_model}': '{metadata.model}'"
        )
    if (
        metadata.reasoning_level is not None
        and metadata.reasoning_level != EXPECTED_REASONING_LEVEL
    ):
        limitations.append(
            f"Actual reasoning for run '{result.spec.run_id}' must be "
            f"'{EXPECTED_REASONING_LEVEL}', found '{metadata.reasoning_level}'"
        )
    return limitations


def _matched_identity_limitations(
    pi_result: BenchmarkResult,
    native_result: BenchmarkResult,
) -> tuple[list[str], list[str]]:
    """Return blocking and nonblocking limitations for one matched pair.

    Parameters:
        pi_result (BenchmarkResult): Pi run.
        native_result (BenchmarkResult): Native harness run.

    Returns:
        tuple[list[str], list[str]]: Blocking mismatches and warnings.
    """
    blocking: list[str] = []
    warnings: list[str] = []
    pi_metadata = pi_result.actual_metadata
    native_metadata = native_result.actual_metadata
    if pi_metadata.model and native_metadata.model and pi_metadata.model != native_metadata.model:
        blocking.append(
            f"Actual model mismatch for matched runs '{pi_result.spec.run_id}' and "
            f"'{native_result.spec.run_id}': '{pi_metadata.model}' != "
            f"'{native_metadata.model}'"
        )
    if (
        pi_metadata.reasoning_level
        and native_metadata.reasoning_level
        and pi_metadata.reasoning_level != native_metadata.reasoning_level
    ):
        blocking.append(
            f"Actual reasoning mismatch for matched runs '{pi_result.spec.run_id}' and "
            f"'{native_result.spec.run_id}'"
        )
    elif pi_metadata.reasoning_level is None or native_metadata.reasoning_level is None:
        warnings.append(
            f"Actual reasoning parity unavailable for matched runs '{pi_result.spec.run_id}' "
            f"and '{native_result.spec.run_id}'"
        )
    return blocking, warnings


def _parity(
    provider: Provider,
    matched: list[tuple[BenchmarkResult, BenchmarkResult]],
) -> tuple[bool, list[str], dict[str, Any]]:
    """Verify exact actual provider/model parity for every matched run.

    Parameters:
        provider (Provider): Expected provider pair.
        matched (list[tuple[BenchmarkResult, BenchmarkResult]]): Pi/native matched runs.

    Returns:
        tuple[bool, list[str], dict[str, Any]]: Eligibility, limitations, and raw identities.
    """
    limitations: list[str] = []
    identities: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: {"providers": set(), "models": set(), "reasoning_levels": set()}
    )
    eligible = bool(matched)
    for pi_result, native_result in matched:
        identity_issues = [
            issue
            for result in (pi_result, native_result)
            for issue in _identity_limitations(result, provider, identities)
        ]
        blocking, warnings = _matched_identity_limitations(pi_result, native_result)
        protocol_issues = [
            f"Protocol-invalid run '{result.spec.run_id}': "
            f"{'; '.join(result.protocol_violations) or 'unspecified protocol deviation'}"
            for result in (pi_result, native_result)
            if not result.protocol_valid
        ]
        if identity_issues or blocking or protocol_issues:
            eligible = False
        limitations.extend(identity_issues + blocking + protocol_issues + warnings)
    serialized = {
        harness: {name: sorted(values) for name, values in categories.items()}
        for harness, categories in identities.items()
    }
    return eligible, list(dict.fromkeys(limitations)), serialized


def _matched_deltas(
    matched: list[tuple[BenchmarkResult, BenchmarkResult]],
) -> tuple[int, dict[str, dict[str, int | float | bool | None]]]:
    """Calculate native-minus-Pi deltas only for jointly successful matched runs.

    Parameters:
        matched (list[tuple[BenchmarkResult, BenchmarkResult]]): Pi/native matched runs.

    Returns:
        tuple[int, dict[str, dict[str, int | float | bool | None]]]: Match count and deltas.
    """
    successful = [(pi, native) for pi, native in matched if pi.success and native.success]
    getters: dict[str, Callable[[BenchmarkResult], int | float | None]] = {
        "combined_tokens": lambda result: (
            result.usage.total_tokens if result.usage is not None else None
        ),
        "plan_token_share": _plan_token_share,
        "turns": lambda result: result.activity.combined.turns,
        "tool_calls": lambda result: result.activity.combined.tool_calls,
        "blocked_calls": lambda result: result.activity.combined.blocked_calls,
        "elapsed_seconds": lambda result: result.wall_duration_seconds,
        "cache_hit_ratio": lambda result: result.cache_hit_ratio,
    }
    deltas: dict[str, dict[str, int | float | bool | None]] = {}
    for name, getter in getters.items():
        values = [
            float(native_value) - float(pi_value)
            for pi_result, native_result in successful
            if (pi_value := getter(pi_result)) is not None
            and (native_value := getter(native_result)) is not None
        ]
        deltas[name] = _metric(values, len(successful))
    return len(successful), deltas


def _pair_winner(
    *,
    complete: bool,
    eligible: bool,
    members: tuple[Harness, Harness],
    summaries: dict[str, dict[str, Any]],
) -> str | None:
    """Apply the pair-level dominance rule without imputing missing data.

    Parameters:
        complete (bool): Whether all nine matched tasks are present.
        eligible (bool): Whether actual identities have exact parity.
        members (tuple[Harness, Harness]): Pi and native harnesses.
        summaries (dict[str, dict[str, Any]]): Harness summaries.

    Returns:
        str | None: Winning harness, no-dominant-winner, or None when excluded.
    """
    if not complete or not eligible:
        return None
    pi_summary = summaries[members[0].value]
    native_summary = summaries[members[1].value]
    pi_tokens = pi_summary["successful_only"]["combined_tokens"]
    native_tokens = native_summary["successful_only"]["combined_tokens"]
    if not pi_tokens["available"] or not native_tokens["available"]:
        return "no-dominant-winner"
    if (
        pi_summary["success_rate"]["value"] >= native_summary["success_rate"]["value"]
        and pi_tokens["median"] < native_tokens["median"]
    ):
        return members[0].value
    if (
        native_summary["success_rate"]["value"] >= pi_summary["success_rate"]["value"]
        and native_tokens["median"] < pi_tokens["median"]
    ):
        return members[1].value
    return "no-dominant-winner"


def build_report(results: list[BenchmarkResult]) -> dict[str, Any]:
    """Build complete provider-pair summaries from actual native identities.

    Parameters:
        results (list[BenchmarkResult]): Finalized benchmark records.

    Returns:
        dict[str, Any]: JSON-serializable pairwise report.

    Raises:
        ValueError: If duplicate run identities are present.
    """
    identities = [result.spec.run_id for result in results]
    if len(identities) != len(set(identities)):
        msg = "Duplicate `run_id` values cannot be reported"
        raise ValueError(msg)
    ordered = sorted(results, key=lambda result: result.spec.matrix_position)
    if any(
        earlier.agent_started_at > later.agent_started_at
        for index, earlier in enumerate(ordered)
        for later in ordered[index + 1 :]
        if earlier.spec.matrix_position < later.spec.matrix_position
    ):
        msg = "Run start timestamps are not chronological by matrix position"
        raise ValueError(msg)
    grouped: dict[Provider, list[BenchmarkResult]] = defaultdict(list)
    for result in results:
        grouped[result.spec.pair].append(result)

    pairs: list[dict[str, Any]] = []
    for provider, group in sorted(grouped.items(), key=lambda item: item[0].value):
        members = PAIR_MEMBERS[provider]
        by_harness = {
            harness: [result for result in group if result.spec.harness is harness]
            for harness in members
        }
        summaries = {harness.value: _harness_summary(by_harness[harness]) for harness in members}
        indexed = {
            (result.spec.fixture, result.spec.repetition, result.spec.harness): result
            for result in group
        }
        observed_task_keys = {(result.spec.fixture, result.spec.repetition) for result in group}
        expected_task_keys = {
            (fixture, repetition) for fixture in Fixture for repetition in range(1, REPETITIONS + 1)
        }
        task_keys = sorted(observed_task_keys, key=lambda item: (item[0].value, item[1]))
        matched = [
            (indexed[(*key, members[0])], indexed[(*key, members[1])])
            for key in task_keys
            if (*key, members[0]) in indexed and (*key, members[1]) in indexed
        ]
        complete = observed_task_keys == expected_task_keys and all(
            {(result.spec.fixture, result.spec.repetition) for result in by_harness[harness]}
            == expected_task_keys
            and len(by_harness[harness]) == EXPECTED_RUNS_PER_HARNESS
            for harness in members
        )
        parity_eligible, limitations, actual_identities = _parity(provider, matched)
        if not complete:
            missing = sorted(
                f"{fixture.value}:r{repetition}"
                for fixture, repetition in expected_task_keys - observed_task_keys
            )
            unexpected = sorted(
                f"{fixture.value}:r{repetition}"
                for fixture, repetition in observed_task_keys - expected_task_keys
            )
            limitations.append(
                f"Incomplete pair: expected {EXPECTED_RUNS_PER_HARNESS} exact fixture/repetition "
                f"cells, found {len(matched)} matched cells; missing={missing}; "
                f"unexpected={unexpected}"
            )
        for summary in summaries.values():
            limitations.extend(summary["limitations"])
        limitations.extend(
            limitation
            for result in group
            if (limitation := result.auxiliary_usage.limitation) is not None
        )
        successful_matches, deltas = _matched_deltas(matched)
        winner = _pair_winner(
            complete=complete,
            eligible=parity_eligible,
            members=members,
            summaries=summaries,
        )
        pairs.append(
            {
                "provider_pair": provider.value,
                "complete": complete,
                "parity_eligible": parity_eligible,
                "actual_identities": actual_identities,
                "harnesses": summaries,
                "matched_runs": len(matched),
                "matched_successful_runs": successful_matches,
                "matched_native_minus_pi_deltas": deltas,
                "winner_claim": winner,
                "limitations": list(dict.fromkeys(limitations)),
            }
        )

    expected_pi_winners = {
        Provider.ANTHROPIC: Harness.PI_ANTHROPIC,
        Provider.OPENAI: Harness.PI_OPENAI,
    }
    pair_by_provider = {Provider(pair["provider_pair"]): pair for pair in pairs}
    pi_observed_rule_met = set(pair_by_provider) == set(Provider) and all(
        pair_by_provider[provider]["complete"]
        and pair_by_provider[provider]["parity_eligible"]
        and pair_by_provider[provider]["winner_claim"] == expected_pi_winners[provider].value
        for provider in Provider
    )
    equivalent_auxiliary_accounting = False
    pi_claimed = pi_observed_rule_met
    return {
        "schema_version": "3.0",
        "result_count": len(results),
        "aggregation": "within-provider pairs only",
        "decision_rule": GLOBAL_DECISION_RULE,
        "auxiliary_accounting": {
            "equivalent_full_accounting_established": equivalent_auxiliary_accounting,
            "limitation": AUXILIARY_ACCOUNTING_LIMITATION,
        },
        "pairs": pairs,
        "global_decision": {
            "pi_observed_rule_met": pi_observed_rule_met,
            "pi_claimed": pi_claimed,
            "claim": (
                "Pi is more token-efficient in both matched pairs"
                if pi_claimed
                else "No global Pi efficiency claim"
            ),
        },
    }


def render_markdown(report: dict[str, Any]) -> str:
    """Render a concise human-readable report from machine-readable data.

    Parameters:
        report (dict[str, Any]): Report returned by `build_report`.

    Returns:
        str: Markdown report.
    """
    lines = [
        "# Benchmark report",
        "",
        f"Decision rule: {report['decision_rule']}",
        "",
        f"Global decision: **{report['global_decision']['claim']}**",
        "",
        f"**Auxiliary accounting limitation:** {report['auxiliary_accounting']['limitation']}",
        "",
        "| Provider pair | Eligible | Complete | Harness | Visible pass | Hidden pass | Success | "
        "Successful token median [range] (n) | Plan token share (n) | Turns (n) | "
        "Tool calls (n) | Blocked calls (n) | Elapsed s (n) | Cache ratio (n) |",
        "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for pair in report["pairs"]:
        for harness, summary in pair["harnesses"].items():
            metrics = summary["successful_only"]
            tokens = metrics["combined_tokens"]
            token_text = (
                f"{tokens['median']:.1f} [{tokens['min']:.1f}, {tokens['max']:.1f}] "
                f"(n={tokens['n']})"
                if tokens["available"]
                else f"n/a (n={tokens['n']}/{tokens['expected_n']})"
            )
            metric_text = {
                name: (
                    f"{metric['median']:.3f} (n={metric['n']})"
                    if metric["available"]
                    else f"n/a (n={metric['n']}/{metric['expected_n']})"
                )
                for name, metric in metrics.items()
            }
            rates = {
                name: (
                    f"{summary[name]['value']:.3f} (n={summary[name]['n']})"
                    if summary[name]["value"] is not None
                    else "n/a (n=0)"
                )
                for name in ("visible_pass_rate", "hidden_pass_rate", "success_rate")
            }
            lines.append(
                f"| {pair['provider_pair']} | {pair['parity_eligible']} | {pair['complete']} | "
                f"{harness} | {rates['visible_pass_rate']} | {rates['hidden_pass_rate']} | "
                f"{rates['success_rate']} | {token_text} | "
                f"{metric_text['plan_token_share']} | {metric_text['turns']} | "
                f"{metric_text['tool_calls']} | "
                f"{metric_text['blocked_calls']} | {metric_text['elapsed_seconds']} | "
                f"{metric_text['cache_hit_ratio']} |"
            )
    lines.extend(["", "Matched native - Pi median deltas:"])
    for pair in report["pairs"]:
        deltas = pair["matched_native_minus_pi_deltas"]
        rendered = ", ".join(
            (
                f"{name}={metric['median']:.3f} (n={metric['n']})"
                if metric["available"]
                else f"{name}=n/a (n={metric['n']}/{metric['expected_n']})"
            )
            for name, metric in deltas.items()
        )
        lines.append(f"- {pair['provider_pair']}: {rendered}")
    lines.extend(["", "Limitations:"])
    limitations = [
        f"- {pair['provider_pair']}: {limitation}"
        for pair in report["pairs"]
        for limitation in pair["limitations"]
    ]
    lines.extend(limitations or ["- None."])
    return "\n".join(lines) + "\n"


def write_report(results_root: Path, output_path: Path) -> dict[str, Any]:
    """Write machine-readable JSON and sibling Markdown reports.

    Parameters:
        results_root (Path): Tree containing final result files.
        output_path (Path): JSON report destination.

    Returns:
        dict[str, Any]: Written report.
    """
    report = build_report(load_results(results_root))
    output_path = Path(str(output_path)).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    output_path.with_suffix(".md").write_text(render_markdown(report), encoding="utf-8")
    return report
