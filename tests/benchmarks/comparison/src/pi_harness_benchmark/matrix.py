"""Construct the fixed provider-paired benchmark run matrix.

References:
- https://en.wikipedia.org/wiki/Crossover_study
"""

from __future__ import annotations

from pi_harness_benchmark.fixtures import DEFINITIONS
from pi_harness_benchmark.models import Fixture, Harness, Provider, RunSpec

REPETITIONS = 3
MODEL_BY_HARNESS = {
    Harness.PI_ANTHROPIC: "claude-sonnet-5",
    Harness.CLAUDE: "sonnet",
    Harness.PI_OPENAI: "gpt-5.6-terra",
    Harness.CODEX: "gpt-5.6-terra",
}
PAIR_MEMBERS = {
    Provider.ANTHROPIC: (Harness.PI_ANTHROPIC, Harness.CLAUDE),
    Provider.OPENAI: (Harness.PI_OPENAI, Harness.CODEX),
}


def generate_matrix() -> list[RunSpec]:
    """Generate 36 runs with alternating within-pair launch order.

    Returns:
        list[RunSpec]: Stable provider-paired execution matrix.
    """
    runs: list[RunSpec] = []
    position = 1
    pair_trials = dict.fromkeys(Provider, 0)
    for repetition in range(1, REPETITIONS + 1):
        for fixture in Fixture:
            for pair in Provider:
                members = PAIR_MEMBERS[pair]
                ordered = members if pair_trials[pair] % 2 == 0 else tuple(reversed(members))
                for pair_order, harness in enumerate(ordered, start=1):
                    run_id = (
                        f"{position:02d}-{pair.value}-{fixture.value}-r{repetition}-{harness.value}"
                    )
                    runs.append(
                        RunSpec(
                            run_id=run_id,
                            pair=pair,
                            harness=harness,
                            fixture=fixture,
                            repetition=repetition,
                            pair_order=pair_order,
                            matrix_position=position,
                            reasoning_level="medium",
                            model=MODEL_BY_HARNESS[harness],
                            documentation_required=DEFINITIONS[fixture].documentation_required,
                            clarification=DEFINITIONS[fixture].clarification,
                        )
                    )
                    position += 1
                pair_trials[pair] += 1
    return runs
