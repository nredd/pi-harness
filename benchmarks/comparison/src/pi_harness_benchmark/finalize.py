"""Finalize stopped runs without allowing post-agent repairs.

References:
- https://docs.pytest.org/en/stable/how-to/usage.html
- https://docs.astral.sh/uv/reference/cli/#uv-run
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pi_harness_benchmark.artifacts import discover_session_logs, snapshot_git
from pi_harness_benchmark.matrix import generate_matrix
from pi_harness_benchmark.models import (
    BenchmarkResult,
    DocumentationStatus,
    GateResult,
    GateSuite,
    GitSnapshot,
    Harness,
    PlanArtifact,
    RunManifest,
    RunStatus,
    SeedVerification,
    SessionArtifact,
)
from pi_harness_benchmark.prepare import (
    create_sandbox_profile,
    load_manifest,
    save_manifest,
    verify_pi_plan_configuration,
)
from pi_harness_benchmark.process import executable
from pi_harness_benchmark.usage import SessionWindow, analyze_session

_MISSING_REASONING_WARNING = "Native session does not establish actual reasoning_level"


@dataclass(frozen=True)
class AcceptanceEvidence:
    """Non-gate evidence required for benchmark acceptance."""

    planning_required: bool
    asked_before_choosing: bool | None
    plan_captured: bool
    documentation_required: bool
    documentation_status: DocumentationStatus


CONTAMINATION_NAMES = frozenset(
    {
        "accepted-plan.md",
        "agent.diff",
        "clarification.txt",
        "hidden-gate.log",
        "manifest.json",
        "native-sessions",
        "prompt.txt",
        "result.json",
        "session-logs",
        "terminal.log",
        "visible-gates",
    }
)


class RunStateError(RuntimeError):
    """An operator action conflicts with the run lifecycle."""


def _contamination_paths(worktree: Path) -> list[str]:
    """Find benchmark-owned artifact names inside a fixture clone.

    Parameters:
        worktree (Path): Disposable fixture clone.

    Returns:
        list[str]: Sorted relative contamination paths.
    """
    return sorted(
        str(path.relative_to(worktree))
        for path in worktree.rglob("*")
        if ".git" not in path.relative_to(worktree).parts
        and any(part in CONTAMINATION_NAMES for part in path.relative_to(worktree).parts)
    )


def _verify_pristine_start(manifest: RunManifest, timestamp: datetime) -> None:
    """Reject a changed HEAD, dirty tree, or benchmark artifacts before timing.

    Parameters:
        manifest (RunManifest): Prepared run manifest.
        timestamp (datetime): Start boundary to retain on success.

    Raises:
        RunStateError: If the clone is not pristine and uncontaminated.
    """
    git = executable("git")
    head = subprocess.check_output(
        [str(git), "rev-parse", "HEAD"],
        cwd=manifest.worktree,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()
    if head != manifest.seed_commit:
        msg = f"Pre-run HEAD mismatch: expected '{manifest.seed_commit}', found '{head}'"
        raise RunStateError(msg)
    contamination = _contamination_paths(manifest.worktree)
    if contamination:
        msg = f"Pre-run benchmark contamination found: {contamination}"
        raise RunStateError(msg)
    status = subprocess.check_output(
        [str(git), "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=manifest.worktree,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()
    if status:
        msg = f"Pre-run worktree is not pristine: '{status}'"
        raise RunStateError(msg)
    manifest.agent_started_at = timestamp
    manifest.start_seed_verified_at = timestamp


def _verify_matrix_predecessors(manifest: RunManifest) -> None:
    """Require every earlier fixed-matrix run to be finalized.

    Parameters:
        manifest (RunManifest): Run about to start.

    Raises:
        RunStateError: If any matrix predecessor is absent or unfinished.
    """
    predecessors = [
        spec for spec in generate_matrix() if spec.matrix_position < manifest.spec.matrix_position
    ]
    unfinished: list[str] = []
    for spec in predecessors:
        predecessor_path = manifest.benchmark_root / "artifacts" / "runs" / spec.run_id
        try:
            predecessor = load_manifest(predecessor_path)
        except FileNotFoundError:
            unfinished.append(spec.run_id)
            continue
        if predecessor.status is not RunStatus.FINALIZED:
            unfinished.append(spec.run_id)
    if unfinished:
        msg = f"Matrix predecessor runs are not finalized: {unfinished}"
        raise RunStateError(msg)


def _mark_start(manifest: RunManifest, timestamp: datetime) -> None:
    """Apply a start boundary.

    Parameters:
        manifest (RunManifest): Mutable validated manifest.
        timestamp (datetime): UTC event time.

    Raises:
        RunStateError: If start was already recorded.
    """
    if manifest.agent_started_at is not None:
        msg = "Run already has an `agent_started_at` boundary"
        raise RunStateError(msg)
    _verify_pristine_start(manifest, timestamp)
    create_sandbox_profile(manifest)
    if manifest.spec.harness.value.startswith("pi-"):
        manifest.pi_plan_configuration_at_start = verify_pi_plan_configuration(when=timestamp)


def _mark_implementation(manifest: RunManifest, timestamp: datetime) -> None:
    """Apply a plan-to-implementation boundary.

    Parameters:
        manifest (RunManifest): Mutable validated manifest.
        timestamp (datetime): UTC event time.

    Raises:
        RunStateError: If the boundary is missing, duplicated, or out of order.
    """
    if manifest.agent_started_at is None:
        msg = "Record `start` before `implementation`"
        raise RunStateError(msg)
    if manifest.implementation_started_at is not None:
        msg = "Run already has an `implementation_started_at` boundary"
        raise RunStateError(msg)
    if timestamp < manifest.agent_started_at:
        msg = "Implementation boundary cannot precede agent start"
        raise RunStateError(msg)
    if (
        not manifest.accepted_plan_path.is_file()
        or not manifest.accepted_plan_path.read_bytes().strip()
    ):
        msg = f"Accepted plan artifact is missing or empty: '{manifest.accepted_plan_path}'"
        raise RunStateError(msg)
    manifest.implementation_started_at = timestamp


def _mark_stop(manifest: RunManifest, timestamp: datetime) -> None:
    """Apply an agent-stop boundary.

    Parameters:
        manifest (RunManifest): Mutable validated manifest.
        timestamp (datetime): UTC event time.

    Raises:
        RunStateError: If the boundary is missing, duplicated, or out of order.
    """
    if manifest.agent_started_at is None:
        msg = "Record `start` before `stop`"
        raise RunStateError(msg)
    if manifest.stopped_at is not None:
        msg = "Run already has a `stopped_at` boundary"
        raise RunStateError(msg)
    if timestamp < (manifest.implementation_started_at or manifest.agent_started_at):
        msg = "Stop boundary cannot precede the active stage"
        raise RunStateError(msg)
    manifest.stopped_at = timestamp


def mark_run(
    run_dir: Path,
    event: str,
    *,
    when: datetime | None = None,
    allow_out_of_order: bool = False,
) -> RunManifest:
    """Record an operator-controlled timing boundary.

    Parameters:
        run_dir (Path): Prepared run directory.
        event (str): One of `start`, `implementation`, or `stop`.
        when (datetime | None): Explicit UTC-aware timestamp for tests.
        allow_out_of_order (bool): Explicit development-only matrix-order override.

    Returns:
        RunManifest: Updated validated manifest.

    Raises:
        ValueError: If the event or timestamp is invalid.
        RunStateError: If events are missing, duplicated, or out of order.
    """
    manifest = load_manifest(run_dir)
    timestamp = when or datetime.now(UTC)
    if timestamp.tzinfo is None:
        msg = "Timing boundary must include a timezone"
        raise ValueError(msg)
    markers = {
        "start": _mark_start,
        "implementation": _mark_implementation,
        "stop": _mark_stop,
    }
    if event == "start" and not allow_out_of_order:
        _verify_matrix_predecessors(manifest)
    marker = markers.get(event)
    if marker is None:
        msg = f"Unknown timing event: '{event}'"
        raise ValueError(msg)
    marker(manifest, timestamp.astimezone(UTC))
    save_manifest(manifest)
    return manifest


def _run_gate(
    name: str,
    command: list[str],
    cwd: Path,
    output_path: Path,
    env: dict[str, str],
) -> GateResult:
    """Run one independent gate and capture combined output.

    Parameters:
        name (str): Gate label.
        command (list[str]): Absolute-binary argument vector.
        cwd (Path): Fixture worktree.
        output_path (Path): Combined output destination.
        env (dict[str, str]): Deliberately isolated subprocess environment.

    Returns:
        GateResult: Validated gate outcome.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            env=env,
        )
        exit_code = completed.returncode
        gate_output = completed.stdout
    except OSError as error:
        exit_code = 127
        gate_output = f"Could not execute gate: {error}\n"
    duration = time.monotonic() - started
    output_path.write_text(gate_output, encoding="utf-8")
    return GateResult(
        name=name,
        command=command,
        exit_code=exit_code,
        passed=exit_code == 0,
        duration_seconds=duration,
        output_path=output_path,
    )


def _gate_environment(manifest: RunManifest, name: str) -> tuple[Path, dict[str, str]]:
    """Build a clean uv environment outside the fixture clone.

    Parameters:
        manifest (RunManifest): Prepared run manifest.
        name (str): Independent gate environment name.

    Returns:
        tuple[Path, dict[str, str]]: Environment path and fixed subprocess variables.
    """
    environment_path = manifest.run_dir / f"{name}-gate-environment"
    home = manifest.run_dir / f"{name}-gate-home"
    cache = manifest.run_dir / f"{name}-uv-cache"
    temporary = manifest.run_dir / f"{name}-gate-tmp"
    home.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    temporary.mkdir(parents=True, exist_ok=True)
    return environment_path, {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": str(temporary),
        "UV_CACHE_DIR": str(cache),
        "UV_NO_CONFIG": "1",
        "UV_PROJECT_ENVIRONMENT": str(environment_path),
        "UV_PYTHON": sys.executable,
        "UV_PYTHON_PREFERENCE": "system",
    }


def _gate_sandbox_profile(
    manifest: RunManifest,
    name: str,
    *,
    read_write_paths: list[Path],
    read_only_paths: list[Path] | None = None,
) -> Path:
    """Write a Seatbelt profile isolating one gate from every other benchmark path.

    Parameters:
        manifest (RunManifest): Stopped run manifest.
        name (str): Gate profile name.
        read_write_paths (list[Path]): Exact gate-owned writable subtrees.
        read_only_paths (list[Path] | None): Additional harness-owned readable paths.

    Returns:
        Path: Harness-owned SBPL profile.
    """

    def quote(path: Path) -> str:
        return json.dumps(str(Path(str(path)).resolve()))

    benchmark_root = manifest.benchmark_root.resolve()
    root = quote(benchmark_root)
    allowed_paths = [*read_write_paths, *(read_only_paths or [])]
    ancestors = sorted(
        {
            parent
            for path in allowed_paths
            for parent in Path(str(path)).resolve().parents
            if parent != benchmark_root and parent.is_relative_to(benchmark_root)
        },
        key=lambda path: len(path.parts),
    )
    lines = [
        "(version 1)",
        "(allow default)",
        f"(deny file-read* (subpath {root}))",
        f"(deny file-write* (subpath {root}))",
        f"(allow file-read* (literal {root}))",
        *(f"(allow file-read* (literal {quote(path)}))" for path in ancestors),
    ]
    for path in read_write_paths:
        quoted = quote(path)
        lines.extend(
            [
                f"(allow file-read* (literal {quoted}))",
                f"(allow file-read* (subpath {quoted}))",
                f"(allow file-write* (literal {quoted}))",
                f"(allow file-write* (subpath {quoted}))",
            ]
        )
    for path in read_only_paths or []:
        quoted = quote(path)
        lines.extend(
            [
                f"(allow file-read* (literal {quoted}))",
                f"(allow file-read* (subpath {quoted}))",
            ]
        )
    profile = manifest.run_dir / f"{name}-gate.sb"
    profile.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return profile


def _sandbox_gate_command(profile: Path, command: list[str]) -> list[str]:
    """Wrap one gate command in the generated Seatbelt profile.

    Parameters:
        profile (Path): Harness-owned SBPL profile.
        command (list[str]): Native gate command.

    Returns:
        list[str]: Sandboxed command vector.
    """
    return ["/usr/bin/sandbox-exec", "-f", str(profile), "--", *command]


def _materialize_gate_snapshot(
    manifest: RunManifest,
    snapshot: GitSnapshot,
    name: str,
) -> Path:
    """Apply the exact seed-based agent patch to one independent clone.

    Parameters:
        manifest (RunManifest): Stopped run manifest.
        snapshot (GitSnapshot): Immutable seed-based agent patch.
        name (str): Snapshot name.

    Returns:
        Path: Independent gate worktree.
    """
    destination = manifest.run_dir / "gate-snapshots" / name
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    seed = manifest.benchmark_root / "workspace" / "seeds" / manifest.spec.fixture.value
    git = executable("git")
    subprocess.check_output(
        [str(git), "clone", "--quiet", "--no-hardlinks", str(seed), str(destination)],
        text=True,
        stderr=subprocess.STDOUT,
    )
    subprocess.check_output(
        [str(git), "checkout", "--quiet", "--detach", manifest.seed_commit],
        cwd=destination,
        text=True,
        stderr=subprocess.STDOUT,
    )
    if snapshot.patch_bytes:
        subprocess.check_output(
            [str(git), "apply", "--binary", "--whitespace=nowarn", str(snapshot.diff_path)],
            cwd=destination,
            text=True,
            stderr=subprocess.STDOUT,
        )
    return destination


def _visible_gate_suite(manifest: RunManifest, cwd: Path) -> GateSuite:
    """Run isolated sync, format, lint, type, and visible pytest subgates.

    Parameters:
        manifest (RunManifest): Stopped run manifest.
        cwd (Path): Independent visible snapshot.

    Returns:
        GateSuite: Retained suite and isolated environment.
    """
    uv = executable("uv")
    environment_path, env = _gate_environment(manifest, "visible")
    gate_root = manifest.run_dir / "visible-gates"
    profile = _gate_sandbox_profile(
        manifest,
        "visible",
        read_write_paths=[
            cwd,
            environment_path,
            Path(env["HOME"]),
            Path(env["TMPDIR"]),
            Path(env["UV_CACHE_DIR"]),
        ],
        read_only_paths=[uv, Path(sys.prefix)],
    )
    commands = [
        ("uv-sync", [str(uv), "sync", "--frozen", "--all-groups"]),
        (
            "ruff-format",
            [str(uv), "run", "--frozen", "--no-sync", "ruff", "format", "--check", "."],
        ),
        (
            "ruff-lint",
            [str(uv), "run", "--frozen", "--no-sync", "ruff", "check", "--ignore-noqa", "."],
        ),
        ("ty", [str(uv), "run", "--frozen", "--no-sync", "ty", "check"]),
        ("pytest", [str(uv), "run", "--frozen", "--no-sync", "pytest", "-q"]),
    ]
    subgates = [
        _run_gate(
            name,
            _sandbox_gate_command(profile, command),
            cwd,
            gate_root / f"{name}.log",
            env,
        )
        for name, command in commands
    ]
    return GateSuite(
        name="visible",
        subgates=subgates,
        passed=all(gate.passed for gate in subgates),
        environment_path=environment_path,
    )


def _hidden_gate_suite(manifest: RunManifest, cwd: Path, hidden_path: Path) -> GateSuite:
    """Run hidden acceptance with a harness-owned config and isolated plugins.

    Parameters:
        manifest (RunManifest): Stopped run manifest.
        cwd (Path): Independent hidden snapshot.
        hidden_path (Path): Harness-owned hidden test directory.

    Returns:
        GateSuite: Hidden environment and acceptance outcomes.
    """
    uv = executable("uv")
    environment_path, env = _gate_environment(manifest, "hidden")
    env |= {
        "PYTEST_ADDOPTS": "",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    suite_path = manifest.run_dir / "hidden-suite"
    if suite_path.exists():
        shutil.rmtree(suite_path)
    shutil.copytree(hidden_path, suite_path)
    cfg = suite_path / "pytest.ini"
    cfg.write_text(
        f"[pytest]\naddopts = --strict-config --strict-markers\npythonpath = {cwd / 'src'}\n",
        encoding="utf-8",
    )
    sync = _run_gate(
        "uv-sync",
        [
            str(uv),
            "sync",
            "--project",
            str(manifest.benchmark_root),
            "--frozen",
            "--all-groups",
            "--no-install-project",
        ],
        manifest.benchmark_root,
        manifest.run_dir / "hidden-gates" / "uv-sync.log",
        env,
    )
    profile = _gate_sandbox_profile(
        manifest,
        "hidden",
        read_write_paths=[
            cwd,
            environment_path,
            Path(env["HOME"]),
            Path(env["TMPDIR"]),
            Path(env["UV_CACHE_DIR"]),
        ],
        read_only_paths=[suite_path, cfg, Path(sys.prefix)],
    )
    pytest = _run_gate(
        "pytest",
        _sandbox_gate_command(
            profile,
            [
                str(environment_path / "bin" / "python"),
                "-m",
                "pytest",
                "-p",
                "no:cacheprovider",
                "-c",
                str(cfg),
                "--rootdir",
                str(suite_path),
                "-q",
                str(suite_path),
            ],
        ),
        suite_path,
        manifest.run_dir / "hidden-gates" / "pytest.log",
        env,
    )
    subgates = [sync, pytest]
    return GateSuite(
        name="hidden",
        subgates=subgates,
        passed=all(gate.passed for gate in subgates),
        environment_path=environment_path,
    )


def _documentation_status(changed_paths: list[str]) -> DocumentationStatus:
    """Classify documentation treatment from changed paths.

    Parameters:
        changed_paths (list[str]): Final changed and untracked paths.

    Returns:
        DocumentationStatus: Updated, missing, or not applicable.
    """
    if not changed_paths:
        return DocumentationStatus.NOT_APPLICABLE
    if any(path == "README.md" or path.startswith("docs/") for path in changed_paths):
        return DocumentationStatus.UPDATED
    if any(path.endswith(".py") for path in changed_paths):
        return DocumentationStatus.MISSING
    return DocumentationStatus.NOT_APPLICABLE


def _failure_reason(
    visible: GateSuite,
    hidden: GateSuite,
    evidence: AcceptanceEvidence,
) -> str | None:
    """Return the primary concrete acceptance failure.

    Parameters:
        visible (GateSuite): Visible gate suite.
        hidden (GateSuite): Hidden gate suite.
        evidence (AcceptanceEvidence): Planning, plan-capture, and documentation evidence.

    Returns:
        str | None: Concrete reason or None for success.
    """
    if not evidence.plan_captured:
        return "Accepted plan text was not captured before implementation"
    if not visible.passed:
        failed = [gate.name for gate in visible.subgates if not gate.passed]
        return f"Visible subgates failed: {', '.join(failed)}"
    if not hidden.passed:
        failed = [gate.name for gate in hidden.subgates if not gate.passed]
        return f"Hidden acceptance subgates failed: {', '.join(failed)}"
    if evidence.planning_required and evidence.asked_before_choosing is not True:
        return "Required ambiguity clarification was not established before implementation"
    if (
        evidence.documentation_required
        and evidence.documentation_status is not DocumentationStatus.UPDATED
    ):
        return "Required README/docs update is missing"
    return None


def _accepted_plan(path: Path) -> tuple[PlanArtifact, list[str]]:
    """Capture accepted-plan artifact metadata without entering the clone.

    Parameters:
        path (Path): External accepted-plan destination.

    Returns:
        tuple[PlanArtifact, list[str]]: Artifact status and limitations.
    """
    content = path.read_bytes() if path.is_file() else b""
    captured = bool(content.strip())
    artifact = PlanArtifact(
        path=path,
        captured=captured,
        sha256=hashlib.sha256(content).hexdigest() if captured else None,
        byte_count=len(content),
    )
    warnings = [] if captured else ["Accepted plan text was not captured"]
    return artifact, warnings


def _verify_final_seed(manifest: RunManifest) -> SeedVerification:
    """Recheck generated seed identity, ancestry, and clone contamination.

    Parameters:
        manifest (RunManifest): Stopped run manifest.

    Returns:
        SeedVerification: Final validated seed evidence.

    Raises:
        RunStateError: If seed identity, ancestry, or contamination is invalid.
    """
    if manifest.start_seed_verified_at is None:
        msg = "Run lacks pre-start pristine seed verification"
        raise RunStateError(msg)
    git = executable("git")
    seed = manifest.benchmark_root / "workspace" / "seeds" / manifest.spec.fixture.value
    seed_head = subprocess.check_output(
        [str(git), "rev-parse", "HEAD"],
        cwd=seed,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()
    if seed_head != manifest.seed_commit:
        msg = f"Generated seed HEAD changed: expected '{manifest.seed_commit}', found '{seed_head}'"
        raise RunStateError(msg)
    contamination = _contamination_paths(manifest.worktree)
    if contamination:
        msg = f"Final benchmark contamination found in clone: {contamination}"
        raise RunStateError(msg)
    ancestry = (
        subprocess.run(
            [str(git), "merge-base", "--is-ancestor", manifest.seed_commit, "HEAD"],
            cwd=manifest.worktree,
            check=False,
        ).returncode
        == 0
    )
    if not ancestry:
        msg = f"Final worktree history does not descend from seed '{manifest.seed_commit}'"
        raise RunStateError(msg)
    return SeedVerification(
        expected_commit=manifest.seed_commit,
        clone_head_at_prepare=manifest.seed_commit,
        verified_at_start=manifest.start_seed_verified_at,
        generated_seed_head_at_finalize=seed_head,
        seed_is_final_ancestor=ancestry,
        contamination_paths=contamination,
    )


def _reasoning_from_terminal(
    harness: Harness,
    sessions: list[SessionArtifact],
) -> str | None:
    """Extract reasoning evidence rendered by a native TUI.

    Claude's JSONL records identify the exact provider model but omit the selected effort.
    Its startup banner and status line render that value, so the retained terminal transcript
    supplies the missing native-session evidence.

    Parameters:
        harness (Harness): Native CLI format.
        sessions (list[SessionArtifact]): Retained redacted session artifacts.

    Returns:
        str | None: Unambiguous native effort level, when rendered.
    """
    if harness is not Harness.CLAUDE:
        return None
    terminal = next((item for item in sessions if item.source_kind == "terminal"), None)
    if terminal is None:
        return None
    text = terminal.redacted_path.read_text(encoding="utf-8", errors="replace").lower()
    levels = [
        level
        for level in ("low", "medium", "high")
        if f"with {level} effort" in text or f"[{level}]" in text
    ]
    unique = list(dict.fromkeys(levels))
    return unique[0] if len(unique) == 1 else None


def finalize_run(run_dir: Path) -> BenchmarkResult:
    """Snapshot, independently test, parse, and persist one stopped run.

    Parameters:
        run_dir (Path): Prepared and stopped run directory.

    Returns:
        BenchmarkResult: Final validated benchmark record.

    Raises:
        RunStateError: If timing boundaries are missing or the run was finalized.
    """
    manifest = load_manifest(run_dir)
    if manifest.status is RunStatus.FINALIZED:
        msg = f"Run is already finalized: '{manifest.run_dir}'"
        raise RunStateError(msg)
    if manifest.agent_started_at is None or manifest.stopped_at is None:
        msg = "Record `start` and `stop` before finalizing"
        raise RunStateError(msg)

    seed_verification = _verify_final_seed(manifest)
    git_snapshot = snapshot_git(manifest.worktree, manifest.run_dir, manifest.seed_commit)
    accepted_plan, plan_warnings = _accepted_plan(manifest.accepted_plan_path)
    sessions, warnings = discover_session_logs(manifest)
    native_paths = [
        artifact.redacted_path for artifact in sessions if artifact.source_kind == "native-session"
    ]
    analysis = analyze_session(
        manifest.spec.harness,
        native_paths,
        SessionWindow(
            started_at=manifest.agent_started_at,
            transition_at=manifest.implementation_started_at,
            stopped_at=manifest.stopped_at,
        ),
        manifest.spec.clarification,
    )
    terminal_reasoning = _reasoning_from_terminal(manifest.spec.harness, sessions)
    if analysis.actual_metadata.reasoning_level is None and terminal_reasoning is not None:
        analysis = analysis.model_copy(
            update={
                "actual_metadata": analysis.actual_metadata.model_copy(
                    update={"reasoning_level": terminal_reasoning}
                ),
                "warnings": [
                    warning
                    for warning in analysis.warnings
                    if warning != _MISSING_REASONING_WARNING
                ],
            }
        )
    warnings.extend(plan_warnings)
    warnings.extend(analysis.warnings)

    hidden_path = manifest.benchmark_root / "workspace" / "hidden" / manifest.spec.fixture.value
    if not hidden_path.is_dir():
        msg = f"Hidden acceptance suite does not exist: '{hidden_path}'"
        raise FileNotFoundError(msg)
    visible_snapshot = _materialize_gate_snapshot(manifest, git_snapshot, "visible")
    hidden_snapshot = _materialize_gate_snapshot(manifest, git_snapshot, "hidden")
    visible = _visible_gate_suite(manifest, visible_snapshot)
    hidden = _hidden_gate_suite(manifest, hidden_snapshot, hidden_path)

    documentation_status = _documentation_status(git_snapshot.changed_paths)
    failure_reason = _failure_reason(
        visible,
        hidden,
        AcceptanceEvidence(
            planning_required=analysis.planning_quality.required,
            asked_before_choosing=analysis.planning_quality.asked_before_choosing,
            plan_captured=accepted_plan.captured,
            documentation_required=manifest.spec.documentation_required,
            documentation_status=documentation_status,
        ),
    )
    result_path = manifest.run_dir / "result.json"
    result = BenchmarkResult(
        schema_version="3.0",
        status=RunStatus.FINALIZED,
        spec=manifest.spec,
        seed_commit=manifest.seed_commit,
        prompt_path=manifest.prompt_path,
        prompt_sha256=hashlib.sha256(manifest.prompt_path.read_bytes()).hexdigest(),
        launch_argv=manifest.launch_argv,
        terminal_log_path=next(
            (artifact.redacted_path for artifact in sessions if artifact.source_kind == "terminal"),
            manifest.run_dir / "session-logs" / "terminal.log",
        ),
        accepted_plan=accepted_plan,
        seed_verification=seed_verification,
        prepared_at=manifest.prepared_at,
        agent_started_at=manifest.agent_started_at,
        implementation_started_at=manifest.implementation_started_at,
        stopped_at=manifest.stopped_at,
        finalized_at=datetime.now(UTC),
        wall_duration_seconds=(manifest.stopped_at - manifest.agent_started_at).total_seconds(),
        stages=analysis.stages,
        usage=analysis.usage,
        actual_metadata=analysis.actual_metadata,
        activity=analysis.activity,
        cache_hit_ratio=analysis.cache_hit_ratio,
        planning_quality=analysis.planning_quality,
        auxiliary_usage=analysis.auxiliary_usage,
        visible_gate=visible,
        hidden_gate=hidden,
        success=failure_reason is None,
        failure_reason=failure_reason,
        documentation_status=documentation_status,
        git=git_snapshot,
        sessions=sessions,
        cli_version=manifest.cli_version,
        parser_warnings=warnings,
        result_path=result_path,
    )
    temporary = result_path.with_suffix(".json.tmp")
    temporary.write_text(result.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(result_path)
    manifest.status = RunStatus.FINALIZED
    save_manifest(manifest)
    return result
