"""Validated benchmark manifests and result records.

References:
- https://docs.pydantic.dev/latest/concepts/models/
- https://json-schema.org/draft/2020-12
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Harness(StrEnum):
    """Supported native coding-agent entry points."""

    PI_ANTHROPIC = "pi-anthropic"
    CLAUDE = "claude"
    PI_OPENAI = "pi-openai"
    CODEX = "codex"


class Provider(StrEnum):
    """Provider pairs that may be compared."""

    ANTHROPIC = "anthropic"
    OPENAI = "openai"


class Fixture(StrEnum):
    """Benchmark fixture identifiers."""

    LOCALIZED_BUG = "localized-bug"
    CROSS_FILE_FEATURE = "cross-file-feature"
    AMBIGUITY_HEAVY_CHANGE = "ambiguity-heavy-change"


class DocumentationStatus(StrEnum):
    """Documentation treatment inferred from the final patch."""

    UPDATED = "updated"
    MISSING = "missing"
    NOT_APPLICABLE = "not-applicable"


class RunStatus(StrEnum):
    """Lifecycle state of one benchmark run."""

    PREPARED = "prepared"
    FINALIZED = "finalized"


class StageName(StrEnum):
    """Interactive benchmark stages."""

    PLAN = "plan"
    IMPLEMENTATION = "implementation"
    UNSPLIT = "unsplit"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Clarification(StrictModel):
    question: str = Field(description="Exact unresolved product question.", min_length=1)
    answer: str = Field(
        description="Fixed operator answer kept outside the fixture clone.", min_length=1
    )


class RunSpec(StrictModel):
    run_id: str = Field(description="Stable run identifier.", min_length=1)
    pair: Provider = Field(description="Provider pair used for analysis.")
    harness: Harness = Field(description="Native CLI under test.")
    fixture: Fixture = Field(description="Seed task under test.")
    repetition: int = Field(description="One-based repetition number.", ge=1)
    pair_order: int = Field(description="One-based position within the provider pair.", ge=1, le=2)
    matrix_position: int = Field(description="One-based global execution position.", ge=1)
    reasoning_level: str = Field(
        description="Requested native reasoning level.", pattern="^medium$"
    )
    model: str = Field(description="Native model selector supplied by the operator.", min_length=1)
    documentation_required: bool = Field(
        description="Whether acceptance requires an updated README or docs path."
    )
    clarification: Clarification | None = Field(
        default=None,
        description="Predetermined operator clarification for an intentionally ambiguous fixture.",
    )

    @model_validator(mode="after")
    def validate_pair(self) -> RunSpec:
        """Reject harnesses assigned to the wrong provider pair.

        Returns:
            RunSpec: Validated run specification.

        Raises:
            ValueError: If the harness does not belong to its provider pair.
        """
        expected = {
            Provider.ANTHROPIC: {Harness.PI_ANTHROPIC, Harness.CLAUDE},
            Provider.OPENAI: {Harness.PI_OPENAI, Harness.CODEX},
        }
        if self.harness not in expected[self.pair]:
            msg = f"Harness '{self.harness}' does not belong to pair '{self.pair}'"
            raise ValueError(msg)
        return self


class PiPlanConfiguration(StrictModel):
    extension_version: str = Field(description="Exact installed pi-plan-mode semantic version.")
    implementation_plan_retention: str = Field(
        description="Verified plan retention behavior.", pattern="^clear-after-first-run$"
    )
    thinking_level: str = Field(description="Verified plan thinking behavior.", pattern="^inherit$")
    snapshot_sha256: str = Field(
        description="SHA-256 of the non-secret relevant configuration snapshot.",
        pattern=r"^[0-9a-f]{64}$",
    )
    verified_at: datetime = Field(description="UTC configuration verification timestamp.")


class RunManifest(StrictModel):
    schema_version: str = Field(description="Manifest schema version.", pattern=r"^2\.0$")
    status: RunStatus = Field(description="Current run lifecycle state.")
    spec: RunSpec = Field(description="Matrix specification for this run.")
    benchmark_root: Path = Field(description="Absolute benchmark project path.")
    run_dir: Path = Field(description="Absolute run artifact directory.")
    worktree: Path = Field(description="Absolute disposable clone path.")
    seed_commit: str = Field(description="Pristine seed commit SHA.", min_length=40, max_length=40)
    prepared_at: datetime = Field(description="UTC preparation timestamp.")
    agent_started_at: datetime | None = Field(
        default=None,
        description="UTC timestamp recorded after setup and immediately before launch.",
    )
    implementation_started_at: datetime | None = Field(
        default=None,
        description="UTC plan-to-implementation transition recorded by the operator.",
    )
    start_seed_verified_at: datetime | None = Field(
        default=None,
        description="UTC pristine-seed verification timestamp before native interaction.",
    )
    stopped_at: datetime | None = Field(
        default=None,
        description="UTC timestamp recorded after the native agent stops.",
    )
    prompt_path: Path = Field(description="Exact prompt passed to the native CLI.")
    accepted_plan_path: Path = Field(description="External accepted-plan artifact destination.")
    clarification_path: Path | None = Field(
        default=None,
        description="Fixed clarification answer artifact outside the clone, when required.",
    )
    terminal_log_path: Path = Field(description="Terminal transcript destination.")
    native_session_roots: list[Path] = Field(
        description="Session roots eligible for timestamp-bounded discovery."
    )
    launch_argv: list[str] = Field(description="Native launch argument vector.", min_length=1)
    launch_command: str = Field(
        description="Shell-quoted sandboxed interactive launch command.", min_length=1
    )
    sandbox_profile_path: Path = Field(
        description="Harness-owned Seatbelt profile outside the fixture clone."
    )
    pi_plan_configuration: PiPlanConfiguration | None = Field(
        default=None,
        description="Verified Pi plan extension snapshot for Pi harnesses.",
    )
    pi_plan_configuration_at_start: PiPlanConfiguration | None = Field(
        default=None,
        description="Reverified Pi plan extension snapshot at the start boundary.",
    )
    cli_version: str | None = Field(default=None, description="Native CLI version, if available.")


class TokenUsage(StrictModel):
    input_tokens: int | None = Field(default=None, description="Uncached input tokens.", ge=0)
    output_tokens: int | None = Field(default=None, description="Output tokens.", ge=0)
    cache_read_tokens: int | None = Field(
        default=None, description="Cache-read input tokens.", ge=0
    )
    cache_write_tokens: int | None = Field(
        default=None, description="Cache-creation input tokens.", ge=0
    )
    reasoning_tokens: int | None = Field(
        default=None, description="Reported reasoning output tokens.", ge=0
    )
    total_tokens: int | None = Field(
        default=None, description="Provider-reported or derived token total.", ge=0
    )
    cost_usd: float | None = Field(default=None, description="Reported cost in USD.", ge=0)

    @model_validator(mode="after")
    def derive_total(self) -> TokenUsage:
        """Fill a missing total without counting cache tokens twice.

        Returns:
            TokenUsage: Usage with a derived total when no total was reported.
        """
        components = (
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
        )
        if self.total_tokens is None and all(value is not None for value in components):
            self.total_tokens = sum(value for value in components if value is not None)
        return self

    def __add__(self, other: TokenUsage) -> TokenUsage:
        """Add disjoint usage records.

        Parameters:
            other (TokenUsage): Usage from another unique response.

        Returns:
            TokenUsage: Field-wise sum.
        """

        def add_optional(left: int | None, right: int | None) -> int | None:
            return left + right if left is not None and right is not None else None

        cost = (
            self.cost_usd + other.cost_usd
            if self.cost_usd is not None and other.cost_usd is not None
            else None
        )
        return TokenUsage(
            input_tokens=add_optional(self.input_tokens, other.input_tokens),
            output_tokens=add_optional(self.output_tokens, other.output_tokens),
            cache_read_tokens=add_optional(self.cache_read_tokens, other.cache_read_tokens),
            cache_write_tokens=add_optional(self.cache_write_tokens, other.cache_write_tokens),
            reasoning_tokens=add_optional(self.reasoning_tokens, other.reasoning_tokens),
            total_tokens=add_optional(self.total_tokens, other.total_tokens),
            cost_usd=cost,
        )


class ActualExecutionMetadata(StrictModel):
    provider: str | None = Field(description="Provider extracted from native session records.")
    model: str | None = Field(description="Exact model extracted from native session records.")
    reasoning_level: str | None = Field(
        description="Reasoning level extracted from native session records when available."
    )


class InteractionCounts(StrictModel):
    turns: int | None = Field(description="Finalized assistant turns.", ge=0)
    tool_calls: int | None = Field(description="Native tool calls.", ge=0)
    blocked_calls: int | None = Field(description="Calls blocked by approval or policy.", ge=0)
    tool_calls_by_name: dict[str, int] | None = Field(
        description="Raw tool-call counts by native tool name."
    )
    blocked_calls_by_name: dict[str, int] | None = Field(
        description="Raw blocked-call counts by native tool name."
    )


class ActivityBreakdown(StrictModel):
    plan: InteractionCounts = Field(description="Plan-stage interaction counts.")
    implementation: InteractionCounts = Field(
        description="Implementation-stage interaction counts."
    )
    combined: InteractionCounts = Field(description="Combined interaction counts.")


class PlanningQuality(StrictModel):
    required: bool = Field(description="Whether the fixture requires an explicit clarification.")
    asked_before_choosing: bool | None = Field(
        description="Whether the assistant asked the unresolved question before implementation."
    )
    evidence: str | None = Field(description="Concise parser evidence for the planning judgment.")


class StageMetrics(StrictModel):
    stage: StageName = Field(description="Measured interaction stage.")
    started_at: datetime | None = Field(description="Best available stage start timestamp.")
    ended_at: datetime | None = Field(description="Best available stage end timestamp.")
    duration_seconds: float | None = Field(description="Wall-clock stage duration.", ge=0)
    usage: TokenUsage | None = Field(
        description="Deduplicated token use, or null when native usage is unavailable."
    )
    source_events: int = Field(description="Unique usage events used.", ge=0)


class AuxiliaryUsageAccounting(StrictModel):
    detected: bool = Field(description="Whether auxiliary classifier or subagent usage was found.")
    included: bool = Field(description="Whether detected auxiliary usage is included in totals.")
    separable: bool = Field(
        description="Whether native records identify auxiliary usage separately."
    )
    usage: TokenUsage = Field(description="Detected auxiliary usage included in combined totals.")
    categories: list[str] = Field(description="Detected native auxiliary usage categories.")
    full_accounting_established: bool = Field(
        description="Whether the native evidence guarantees complete auxiliary accounting."
    )
    limitation: str | None = Field(description="Explicit auxiliary accounting limitation.")


class NativeSessionAnalysis(StrictModel):
    actual_metadata: ActualExecutionMetadata = Field(description="Native execution identity.")
    usage: TokenUsage | None = Field(
        description="Deduplicated combined token usage, or null when unavailable."
    )
    stages: list[StageMetrics] = Field(description="Token and timing stage breakdown.")
    activity: ActivityBreakdown = Field(description="Turn and call counts by stage.")
    cache_hit_ratio: float | None = Field(
        description="Cache reads divided by uncached plus cache-read input.", ge=0, le=1
    )
    planning_quality: PlanningQuality = Field(description="Ambiguity-question quality result.")
    auxiliary_usage: AuxiliaryUsageAccounting = Field(
        description="Classifier and subagent usage accounting evidence."
    )
    warnings: list[str] = Field(description="Explicit parser limitations.")


class GateResult(StrictModel):
    name: str = Field(description="Gate name.", min_length=1)
    command: list[str] = Field(description="Exact independent command.", min_length=1)
    exit_code: int = Field(description="Process exit status.")
    passed: bool = Field(description="Whether the gate passed.")
    duration_seconds: float = Field(description="Gate wall-clock duration.", ge=0)
    output_path: Path = Field(description="Captured combined output.")


class GateSuite(StrictModel):
    name: str = Field(description="Gate suite name.", min_length=1)
    subgates: list[GateResult] = Field(description="Independently retained subgate results.")
    passed: bool = Field(description="Whether every subgate passed.")
    environment_path: Path = Field(description="Clean uv environment outside the clone.")


class PlanArtifact(StrictModel):
    path: Path = Field(description="Accepted plan path outside the clone.")
    captured: bool = Field(description="Whether nonempty accepted plan text was captured.")
    sha256: str | None = Field(
        description="SHA-256 of accepted plan bytes when captured.", pattern=r"^[0-9a-f]{64}$"
    )
    byte_count: int = Field(description="Accepted plan byte size.", ge=0)


class SeedVerification(StrictModel):
    expected_commit: str = Field(description="Expected pristine seed commit.", min_length=40)
    clone_head_at_prepare: str = Field(
        description="Clone HEAD verified during preparation.", min_length=40
    )
    verified_at_start: datetime = Field(description="Pre-run pristine verification timestamp.")
    generated_seed_head_at_finalize: str = Field(
        description="Generated seed HEAD rechecked during finalization.", min_length=40
    )
    seed_is_final_ancestor: bool = Field(
        description="Whether final worktree history descends from the pristine seed."
    )
    contamination_paths: list[str] = Field(description="Benchmark artifact paths found in clone.")


class GitSnapshot(StrictModel):
    head: str = Field(description="Worktree HEAD SHA.", min_length=40, max_length=40)
    diff_path: Path = Field(description="Path to full binary-safe git diff.")
    diff_stat_path: Path = Field(description="Path to git diff stat.")
    changed_paths: list[str] = Field(description="Sorted changed and untracked paths.")
    dirty: bool = Field(description="Whether the agent changed the pristine clone.")
    patch_bytes: int = Field(description="UTF-8 byte size of the captured patch.", ge=0)
    patch_lines: int = Field(description="Total lines in the captured patch.", ge=0)
    added_lines: int = Field(description="Added patch content lines.", ge=0)
    deleted_lines: int = Field(description="Deleted patch content lines.", ge=0)


class SessionArtifact(StrictModel):
    source_kind: str = Field(description="Terminal or native-session source kind.", min_length=1)
    source_path: Path = Field(description="Retained redacted source path; never a raw log path.")
    redacted_path: Path = Field(description="Copied and redacted artifact path.")
    sha256: str = Field(description="SHA-256 of redacted bytes.", pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(description="Redacted artifact size.", ge=0)


class BenchmarkResult(StrictModel):
    schema_version: str = Field(description="Result schema version.", pattern=r"^3\.0$")
    status: RunStatus = Field(description="Final lifecycle state.")
    spec: RunSpec = Field(description="Matrix specification.")
    seed_commit: str = Field(description="Pristine fixture revision.", min_length=40, max_length=40)
    prompt_path: Path = Field(description="Exact external task prompt path.")
    prompt_sha256: str = Field(
        description="SHA-256 of the exact prompt.", pattern=r"^[0-9a-f]{64}$"
    )
    launch_argv: list[str] = Field(description="Exact native interactive argument vector.")
    terminal_log_path: Path = Field(description="Retained redacted terminal transcript path.")
    accepted_plan: PlanArtifact = Field(description="Accepted plan artifact capture status.")
    seed_verification: SeedVerification = Field(description="Pristine seed identity verification.")
    prepared_at: datetime = Field(description="UTC preparation timestamp.")
    agent_started_at: datetime = Field(description="Post-setup native agent start timestamp.")
    implementation_started_at: datetime | None = Field(description="Recorded stage transition.")
    stopped_at: datetime = Field(description="Timestamp captured before independent gates.")
    finalized_at: datetime = Field(description="UTC finalization timestamp.")
    wall_duration_seconds: float = Field(description="Agent start-to-stop wall duration.", ge=0)
    stages: list[StageMetrics] = Field(description="Plan and implementation or unsplit metrics.")
    usage: TokenUsage | None = Field(
        description="Deduplicated total token usage, or null when unavailable."
    )
    actual_metadata: ActualExecutionMetadata = Field(
        description="Actual native execution identity."
    )
    activity: ActivityBreakdown = Field(description="Plan, implementation, and combined counts.")
    cache_hit_ratio: float | None = Field(
        description="Cache-read share of cacheable input when measurable.", ge=0, le=1
    )
    planning_quality: PlanningQuality = Field(description="Ambiguity-question quality result.")
    auxiliary_usage: AuxiliaryUsageAccounting = Field(
        description="Classifier and subagent usage accounting evidence."
    )
    visible_gate: GateSuite = Field(description="Independent visible quality and test subgates.")
    hidden_gate: GateSuite = Field(description="Independent hidden acceptance subgates.")
    success: bool = Field(description="Whether every required acceptance condition passed.")
    failure_reason: str | None = Field(description="Concrete primary failure reason.")
    protocol_valid: bool = Field(
        default=True,
        description="Whether operator interaction followed the approved benchmark protocol.",
    )
    protocol_violations: list[str] = Field(
        default_factory=list,
        description="Observed deviations that invalidate this run for comparative claims.",
    )
    documentation_status: DocumentationStatus = Field(
        description="Whether a code change included documentation changes."
    )
    git: GitSnapshot = Field(description="Post-agent repository snapshot.")
    sessions: list[SessionArtifact] = Field(description="Redacted terminal and native logs.")
    cli_version: str | None = Field(description="Captured native CLI version.")
    parser_warnings: list[str] = Field(description="Non-fatal usage parsing limitations.")
    result_path: Path = Field(description="Absolute JSON result path.")
