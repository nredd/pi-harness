from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from pi_harness_benchmark import finalize, prepare
from pi_harness_benchmark.artifacts import (
    _is_bounded_session_path,
    discover_session_logs,
    redact_text,
    snapshot_git,
)
from pi_harness_benchmark.finalize import (
    _MISSING_REASONING_WARNING,
    AcceptanceEvidence,
    RunStateError,
    _documentation_status,
    _failure_reason,
    _hidden_gate_suite,
    _materialize_gate_snapshot,
    _reasoning_from_terminal,
    _run_gate,
    _verify_final_seed,
    finalize_run,
    mark_run,
)
from pi_harness_benchmark.matrix import generate_matrix
from pi_harness_benchmark.models import (
    BenchmarkResult,
    DocumentationStatus,
    Fixture,
    GateResult,
    GateSuite,
    Harness,
    RunManifest,
    RunStatus,
)
from pi_harness_benchmark.prepare import (
    CLI_VERSIONS,
    PI_PLAN_EXTENSION_VERSION,
    PI_PLAN_RETENTION,
    PI_PLAN_THINKING_LEVEL,
    _instructions,
    create_sandbox_profile,
    load_manifest,
    prepare_run,
    save_manifest,
    verify_pi_plan_configuration,
)
from pi_harness_benchmark.process import executable


def _benchmark_root(tmp_path: Path, generated_workspace: Path) -> Path:
    root = tmp_path / "benchmark"
    shutil.copytree(generated_workspace, root / "workspace")
    project_root = Path(__file__).parent.parent
    for name in ("pyproject.toml", "uv.lock"):
        shutil.copy(project_root / name, root / name)
    return root


def test_prepare_keeps_every_artifact_outside_pristine_clone(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = generate_matrix()[0]

    manifest, instructions = prepare_run(root, spec)

    assert manifest.worktree == manifest.run_dir / "worktree"
    assert manifest.prompt_path.parent == manifest.run_dir
    assert manifest.accepted_plan_path == manifest.run_dir / "accepted-plan.md"
    assert not manifest.accepted_plan_path.is_relative_to(manifest.worktree)
    assert "Save the accepted plan text" in instructions
    assert manifest.clarification_path is None
    assert manifest.terminal_log_path.parent == manifest.run_dir
    assert not manifest.terminal_log_path.is_relative_to(manifest.worktree)
    assert "claude-sonnet-5" in manifest.launch_command
    assert "--thinking medium" in manifest.launch_command
    assert "`/plan start`" in instructions
    assert "/usr/bin/sandbox-exec" in manifest.launch_command
    assert manifest.sandbox_profile_path.is_file()
    assert "outside `worktree/`" in instructions
    assert manifest.cli_version == CLI_VERSIONS[spec.harness]
    git = executable("git")
    status = subprocess.check_output(
        [str(git), "status", "--porcelain"], cwd=manifest.worktree, text=True
    )
    assert status == ""


def test_prepare_stores_identical_clarification_outside_every_harness_clone(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    ambiguity_runs = [
        run for run in generate_matrix() if run.fixture.value == "ambiguity-heavy-change"
    ]
    first_by_harness = {run.harness: run for run in ambiguity_runs}
    expected = (
        "`limit` counts emitted active records after filtering and deterministic ordering, not "
        "input rows."
    )

    for spec in first_by_harness.values():
        manifest, instructions = prepare_run(root, spec)
        assert manifest.clarification_path is not None
        assert manifest.clarification_path.read_text(encoding="utf-8") == f"{expected}\n"
        assert manifest.clarification_path.parent == manifest.run_dir
        assert not manifest.clarification_path.is_relative_to(manifest.worktree)
        assert expected in instructions
        assert "Do not volunteer the answer" in instructions
        assert "must ask" in instructions


def test_claude_instructions_exclude_workspace_trust_from_timing(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    claude_spec = next(run for run in generate_matrix() if run.harness.value == "claude")

    manifest, instructions = prepare_run(root, claude_spec)

    assert "Accept Claude's workspace trust prompt" in instructions
    assert instructions.index("workspace trust prompt") < instructions.index("TIMED NATIVE SESSION")
    assert "--permission-mode plan" in manifest.launch_command
    assert "--effort medium" in manifest.launch_command


def test_claude_session_discovery_retains_linked_sidechain_logs(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = next(run for run in generate_matrix() if run.harness is Harness.CLAUDE)
    manifest, _ = prepare_run(root, spec)
    session_root = tmp_path / "claude-projects"
    main_path = session_root / "session-id.jsonl"
    child_path = session_root / "session-id" / "subagents" / "agent-child.jsonl"
    child_path.parent.mkdir(parents=True)
    main_path.write_text(
        json.dumps({"cwd": str(manifest.worktree), "sessionId": "session-id"}),
        encoding="utf-8",
    )
    child_path.write_text(
        json.dumps({"isSidechain": True, "agentId": "child", "sessionId": "session-id"}),
        encoding="utf-8",
    )
    now = datetime.now(UTC)
    manifest.agent_started_at = now - timedelta(seconds=1)
    manifest.stopped_at = now + timedelta(seconds=1)
    manifest.native_session_roots = [session_root]

    artifacts, warnings = discover_session_logs(manifest)

    native_artifacts = [
        artifact for artifact in artifacts if artifact.source_kind == "native-session"
    ]
    assert len(native_artifacts) == 2
    assert all(artifact.source_path == artifact.redacted_path for artifact in native_artifacts)
    assert main_path.is_file()
    assert child_path.is_file()
    assert not any("No matching native" in warning for warning in warnings)


def test_mark_start_rejects_benchmark_contamination(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    (manifest.worktree / "terminal.log").write_text("contamination\n", encoding="utf-8")

    with pytest.raises(RunStateError, match="contamination"):
        mark_run(manifest.run_dir, "start", when=datetime(2026, 1, 1, tzinfo=UTC))

    assert load_manifest(manifest.run_dir).agent_started_at is None


def test_mark_start_rejects_clean_wrong_head(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    git = executable("git")
    subprocess.check_call(
        [
            str(git),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Contaminate",
        ],
        cwd=manifest.worktree,
    )

    with pytest.raises(RunStateError, match="HEAD"):
        mark_run(manifest.run_dir, "start", when=datetime(2026, 1, 1, tzinfo=UTC))


def test_mark_enforces_order_and_persists_boundaries(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    started = datetime(2026, 1, 1, tzinfo=UTC)

    with pytest.raises(ValueError, match="timezone"):
        mark_run(manifest.run_dir, "start", when=started.replace(tzinfo=None))
    with pytest.raises(ValueError, match="Unknown timing event"):
        mark_run(manifest.run_dir, "invalid", when=started)
    with pytest.raises(RunStateError, match="Record `start`"):
        mark_run(manifest.run_dir, "stop", when=started)
    with pytest.raises(RunStateError, match="Record `start`"):
        mark_run(manifest.run_dir, "implementation", when=started)
    mark_run(manifest.run_dir, "start", when=started)
    started_manifest = load_manifest(manifest.run_dir)
    assert started_manifest.pi_plan_configuration_at_start is not None
    assert started_manifest.pi_plan_configuration_at_start.extension_version == "0.58.0"
    assert (
        started_manifest.pi_plan_configuration_at_start.implementation_plan_retention
        == "clear-after-first-run"
    )
    assert started_manifest.pi_plan_configuration_at_start.thinking_level == "inherit"
    with pytest.raises(RunStateError, match="already has an `agent_started_at`"):
        mark_run(manifest.run_dir, "start", when=started)
    with pytest.raises(RunStateError, match="cannot precede"):
        mark_run(manifest.run_dir, "implementation", when=started - timedelta(seconds=1))
    manifest.accepted_plan_path.write_text("Accepted plan\n", encoding="utf-8")
    mark_run(manifest.run_dir, "implementation", when=started + timedelta(seconds=10))
    with pytest.raises(RunStateError, match="implementation_started_at"):
        mark_run(manifest.run_dir, "implementation", when=started + timedelta(seconds=11))
    with pytest.raises(RunStateError, match="cannot precede"):
        mark_run(manifest.run_dir, "stop", when=started + timedelta(seconds=9))
    mark_run(manifest.run_dir, "stop", when=started + timedelta(seconds=20))

    reloaded = load_manifest(manifest.run_dir)
    assert reloaded.agent_started_at == started
    assert reloaded.implementation_started_at == started + timedelta(seconds=10)
    assert reloaded.stopped_at == started + timedelta(seconds=20)
    with pytest.raises(RunStateError, match="already has"):
        mark_run(manifest.run_dir, "stop", when=started + timedelta(seconds=30))


def test_finalize_rejects_changed_generated_seed_identity(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    started = datetime(2026, 1, 1, tzinfo=UTC)
    mark_run(manifest.run_dir, "start", when=started)
    seed = root / "workspace" / "seeds" / manifest.spec.fixture.value
    git = executable("git")
    subprocess.check_call(
        [
            str(git),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Change seed identity",
        ],
        cwd=seed,
    )
    mark_run(manifest.run_dir, "stop", when=started + timedelta(seconds=1))

    with pytest.raises(RunStateError, match="seed HEAD"):
        finalize_run(manifest.run_dir)


def _assert_isolated_hidden_gate(result: BenchmarkResult, manifest: RunManifest) -> None:
    assert result.visible_gate.environment_path.parent == manifest.run_dir
    assert result.hidden_gate.environment_path.parent == manifest.run_dir
    assert result.visible_gate.environment_path != result.hidden_gate.environment_path
    assert [gate.name for gate in result.hidden_gate.subgates] == ["uv-sync", "pytest"]
    hidden_pytest = result.hidden_gate.subgates[1]
    assert "-c" in hidden_pytest.command
    assert "--rootdir" in hidden_pytest.command
    assert hidden_pytest.command[0] == "/usr/bin/sandbox-exec"
    assert str(result.hidden_gate.environment_path / "bin" / "python") in hidden_pytest.command


def test_finalize_snapshots_before_independent_failing_gates_and_parses_pi(
    tmp_path: Path,
    generated_workspace: Path,
    sample_dir: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    now = datetime.now(UTC)
    mark_run(manifest.run_dir, "start", when=now - timedelta(minutes=1))
    manifest.accepted_plan_path.write_text(
        "# Accepted plan\n\nImplement the fix.\n", encoding="utf-8"
    )
    mark_run(manifest.run_dir, "implementation", when=now - timedelta(seconds=30))
    native_root = manifest.run_dir / "native-sessions" / "pi"
    native_root.mkdir(parents=True, exist_ok=True)
    session_path = native_root / "session.jsonl"
    shutil.copy(sample_dir / "pi-session.jsonl", session_path)
    session_path.touch()
    manifest.terminal_log_path.write_text("Authorization: Bearer top-secret\n", encoding="utf-8")
    mark_run(manifest.run_dir, "stop", when=now + timedelta(seconds=1))

    result = finalize_run(manifest.run_dir)

    assert not result.success
    assert not result.visible_gate.passed
    assert not result.hidden_gate.passed
    assert result.usage is not None
    assert result.usage.total_tokens == 338
    assert result.actual_metadata.model == "claude-sonnet-5"
    assert result.activity.combined.turns == 2
    assert result.activity.combined.tool_calls == 2
    assert result.activity.combined.blocked_calls == 1
    assert result.cache_hit_ratio == 170 / 300
    assert not result.auxiliary_usage.detected
    assert not result.auxiliary_usage.full_accounting_established
    assert result.auxiliary_usage.limitation is not None
    assert any("auxiliary accounting" in warning.lower() for warning in result.parser_warnings)
    assert result.git.changed_paths == []
    assert result.git.patch_bytes == 0
    assert result.git.patch_lines == 0
    assert result.documentation_status.value == "not-applicable"
    assert result.failure_reason is not None
    assert "visible" in result.failure_reason.lower()
    assert result.accepted_plan.captured
    assert result.accepted_plan.byte_count > 0
    assert result.accepted_plan.path == manifest.accepted_plan_path
    assert [gate.name for gate in result.visible_gate.subgates] == [
        "uv-sync",
        "ruff-format",
        "ruff-lint",
        "ty",
        "pytest",
    ]
    lint_gate = next(gate for gate in result.visible_gate.subgates if gate.name == "ruff-lint")
    assert "--fix" not in lint_gate.command
    _assert_isolated_hidden_gate(result, manifest)
    assert result.result_path.is_file()
    assert all(gate.output_path.is_file() for gate in result.visible_gate.subgates)
    terminal_copy = next(item for item in result.sessions if item.source_kind == "terminal")
    assert "top-secret" not in terminal_copy.redacted_path.read_text(encoding="utf-8")
    assert load_manifest(manifest.run_dir).status.value == "finalized"
    with pytest.raises(RunStateError, match="already finalized"):
        finalize_run(manifest.run_dir)


def _finalize_started_pi_fixture(
    manifest: RunManifest,
    sample_dir: Path,
) -> BenchmarkResult:
    """Finalize one started fixture with deterministic Pi evidence.

    Parameters:
        manifest (RunManifest): Prepared run manifest.
        sample_dir (Path): Native session sample directory.

    Returns:
        BenchmarkResult: Finalized benchmark result.
    """
    now = datetime.now(UTC)
    manifest.accepted_plan_path.write_text(
        "# Accepted plan\n\nImplement the fix.\n", encoding="utf-8"
    )
    mark_run(manifest.run_dir, "implementation", when=now - timedelta(seconds=30))
    native_root = manifest.run_dir / "native-sessions" / "pi"
    native_root.mkdir(parents=True, exist_ok=True)
    session_path = native_root / "session.jsonl"
    shutil.copy(sample_dir / "pi-session.jsonl", session_path)
    session_path.touch()
    mark_run(manifest.run_dir, "stop", when=now + timedelta(seconds=1))
    return finalize_run(manifest.run_dir)


def test_code_correct_cross_file_feature_without_docs_fails(
    tmp_path: Path,
    generated_workspace: Path,
    sample_dir: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = next(
        run
        for run in generate_matrix()
        if run.fixture is Fixture.CROSS_FILE_FEATURE and run.harness is Harness.PI_ANTHROPIC
    )
    manifest, _ = prepare_run(root, spec)
    mark_run(
        manifest.run_dir,
        "start",
        when=datetime.now(UTC) - timedelta(minutes=1),
        allow_out_of_order=True,
    )
    settings_path = manifest.worktree / "src/service_settings/settings.py"
    settings = settings_path.read_text(encoding="utf-8").replace(
        '        msg = f"Source merging is not implemented for {len(file_values) + len(environ)} values"\n'
        "        raise NotImplementedError(msg)\n",
        "        merged = dict(file_values)\n"
        '        if "APP_DEBUG" in environ:\n'
        '            raw_debug = environ["APP_DEBUG"]\n'
        '            if raw_debug not in {"true", "false"}:\n'
        '                msg = "`APP_DEBUG` must be `true` or `false`"\n'
        "                raise ValueError(msg)\n"
        '            merged["debug"] = raw_debug == "true"\n'
        '        if "APP_TIMEOUT" in environ:\n'
        "            try:\n"
        '                merged["timeout"] = int(environ["APP_TIMEOUT"])\n'
        "            except ValueError as error:\n"
        '                msg = "`APP_TIMEOUT` must be a positive integer"\n'
        "                raise ValueError(msg) from error\n"
        "        return cls.from_mapping(merged)\n",
    )
    settings_path.write_text(settings, encoding="utf-8")
    main_path = manifest.worktree / "src/service_settings/__main__.py"
    main = (
        main_path.read_text(encoding="utf-8")
        .replace(
            "import json\nimport sys\n",
            "import json\nimport os\nimport sys\n",
        )
        .replace("Settings.from_mapping({})", "Settings.from_sources({}, dict(os.environ))")
    )
    main_path.write_text(main, encoding="utf-8")

    result = _finalize_started_pi_fixture(manifest, sample_dir)

    assert result.visible_gate.passed
    assert result.hidden_gate.passed
    assert result.documentation_status.value == "missing"
    assert not result.success
    assert result.failure_reason == "Required README/docs update is missing"


def test_code_correct_localized_fixture_does_not_require_docs(
    tmp_path: Path,
    generated_workspace: Path,
    sample_dir: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = next(
        run
        for run in generate_matrix()
        if run.fixture is Fixture.LOCALIZED_BUG and run.harness is Harness.PI_ANTHROPIC
    )
    manifest, _ = prepare_run(root, spec)
    mark_run(manifest.run_dir, "start", when=datetime.now(UTC) - timedelta(minutes=1))
    source_path = manifest.worktree / "src/identifier_tools/normalize.py"
    source_path.write_text(
        '''"""Normalize human-readable labels for stable identifiers.

References:
- https://docs.python.org/3/library/stdtypes.html
"""

from __future__ import annotations

import re
import unicodedata


def normalize_identifier(value: str) -> str:
    """Return a lowercase ASCII identifier.

    Parameters:
        value (str): Human-readable label.

    Returns:
        str: Normalized identifier.

    Raises:
        ValueError: If no identifier characters remain.
    """
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    identifier = re.sub(r"[^A-Za-z0-9]+", "-", ascii_value).strip("-").lower()
    if not identifier:
        msg = "Identifier cannot be empty"
        raise ValueError(msg)
    return identifier
''',
        encoding="utf-8",
    )

    result = _finalize_started_pi_fixture(manifest, sample_dir)

    assert result.visible_gate.passed
    assert result.hidden_gate.passed
    assert result.documentation_status.value == "missing"
    assert result.success
    assert result.failure_reason is None


def test_snapshot_includes_untracked_file_without_touching_index(tmp_path: Path) -> None:
    git = executable("git")
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.check_call([str(git), "init", "--quiet"], cwd=repo)
    subprocess.check_call([str(git), "config", "user.email", "test@example.invalid"], cwd=repo)
    subprocess.check_call([str(git), "config", "user.name", "Test"], cwd=repo)
    (repo / "tracked.txt").write_text("before\n", encoding="utf-8")
    subprocess.check_call([str(git), "add", "."], cwd=repo)
    subprocess.check_call([str(git), "commit", "--quiet", "-m", "Initial"], cwd=repo)
    (repo / "tracked.txt").write_text("after\n", encoding="utf-8")
    (repo / "new.txt").write_text("new\n", encoding="utf-8")

    seed_commit = subprocess.check_output(
        [str(git), "rev-parse", "HEAD"], cwd=repo, text=True
    ).strip()
    snapshot = snapshot_git(repo, tmp_path / "artifacts", seed_commit)

    patch = snapshot.diff_path.read_text(encoding="utf-8")
    assert snapshot.changed_paths == ["new.txt", "tracked.txt"]
    assert "new.txt" in patch
    assert "+new" in patch
    status = subprocess.check_output([str(git), "status", "--porcelain"], cwd=repo, text=True)
    assert "?? new.txt" in status


def test_hidden_invocation_ignores_agent_pytest_module(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    (manifest.worktree / "pytest.py").write_text(
        'raise RuntimeError("agent-controlled pytest loaded")\n', encoding="utf-8"
    )
    source_path = manifest.worktree / "src/identifier_tools/normalize.py"
    source_path.write_text(
        source_path.read_text(encoding="utf-8")
        .replace(
            "from __future__ import annotations\n",
            "from __future__ import annotations\n\nimport re\nimport unicodedata\n",
        )
        .replace(
            '    return value.strip().lower().replace(" ", "-")',
            '    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()\n'
            '    identifier = re.sub(r"[^A-Za-z0-9]+", "-", ascii_value).strip("-").lower()\n'
            "    if not identifier:\n"
            '        msg = "Identifier cannot be empty"\n'
            "        raise ValueError(msg)\n"
            "    return identifier",
        ),
        encoding="utf-8",
    )
    snapshot = snapshot_git(manifest.worktree, manifest.run_dir, manifest.seed_commit)
    hidden_snapshot = _materialize_gate_snapshot(manifest, snapshot, "hidden-malicious-pytest")
    hidden_path = root / "workspace" / "hidden" / manifest.spec.fixture.value

    hidden = _hidden_gate_suite(manifest, hidden_snapshot, hidden_path)

    assert hidden.passed
    assert "agent-controlled pytest loaded" not in hidden.subgates[1].output_path.read_text()


def test_redaction_preserves_usage_token_fields() -> None:
    source = json.dumps(
        {
            "api_key": "private-value",
            "access_token": "also-private",
            "input_tokens": 42,
            "reasoning_tokens": 7,
            "turn_token_usage": {"input_tokens": 42, "output_tokens": 3},
            "thread_token_usage": {"total_tokens": 52},
        }
    )

    redacted = redact_text(source)

    assert "private-value" not in redacted
    assert "also-private" not in redacted
    assert '"input_tokens": 42' in redacted
    assert '"reasoning_tokens": 7' in redacted
    parsed = json.loads(redacted)
    assert parsed["turn_token_usage"]["output_tokens"] == 3
    assert parsed["thread_token_usage"]["total_tokens"] == 52


START = datetime(2026, 1, 1, tzinfo=UTC)


def _commit(worktree: Path, *args: str) -> None:
    git = executable("git")
    subprocess.check_call(
        [str(git), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
        cwd=worktree,
    )


def _passed_suite(manifest: RunManifest, name: str) -> GateSuite:
    output_path = manifest.run_dir / f"{name}.log"
    output_path.write_text("ok\n", encoding="utf-8")
    gate = GateResult(
        name=name,
        command=["/usr/bin/true"],
        exit_code=0,
        passed=True,
        duration_seconds=0,
        output_path=output_path,
    )
    return GateSuite(
        name=name, subgates=[gate], passed=True, environment_path=manifest.run_dir / name
    )


def _failed_suite(manifest: RunManifest, name: str, failed: str) -> GateSuite:
    suite = _passed_suite(manifest, name)
    gate = suite.subgates[0].model_copy(update={"name": failed, "exit_code": 1, "passed": False})
    return suite.model_copy(update={"subgates": [suite.subgates[0], gate], "passed": False})


def test_session_discovery_requires_both_timing_boundaries(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    session = manifest.native_session_roots[0] / "session.jsonl"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.write_text("{}\n", encoding="utf-8")

    assert not _is_bounded_session_path(session, manifest)
    with pytest.raises(ValueError, match="`agent_started_at` and `stopped_at`"):
        discover_session_logs(manifest)
    assert session.is_file()


def test_session_discovery_without_logs_warns_and_keeps_missing_pi_root(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    manifest.agent_started_at = START
    manifest.stopped_at = START + timedelta(seconds=20)
    pi_root = manifest.native_session_roots[0]
    shutil.rmtree(pi_root)

    artifacts, warnings = discover_session_logs(manifest)

    assert not pi_root.exists()
    assert artifacts == []
    assert warnings == [
        f"Terminal log is missing: '{manifest.terminal_log_path}'",
        "No matching native JSON/JSONL session log was discovered",
    ]


def test_snapshot_refuses_an_unreadable_untracked_path(tmp_path: Path) -> None:
    git = executable("git")
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.check_call([str(git), "init", "--quiet"], cwd=repo)
    (repo / "tracked.txt").write_text("seed\n", encoding="utf-8")
    subprocess.check_call([str(git), "add", "."], cwd=repo)
    _commit(repo, "commit", "--quiet", "-m", "Seed")
    seed_commit = subprocess.check_output(
        [str(git), "rev-parse", "HEAD"], cwd=repo, text=True
    ).strip()
    unreadable = repo / "unreadable.txt"
    unreadable.write_text("agent output\n", encoding="utf-8")
    unreadable.chmod(0)
    try:
        with pytest.raises(
            RuntimeError, match=re.escape("Could not snapshot untracked path 'unreadable.txt'")
        ):
            snapshot_git(repo, tmp_path / "artifacts", seed_commit)
    finally:
        unreadable.chmod(0o600)


def test_pi_plan_configuration_reports_every_pinned_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "package.json"
    package.write_text(json.dumps({"version": "0.0.1"}), encoding="utf-8")
    cfg = tmp_path / "plan-mode.json"
    cfg.write_text(
        json.dumps({"implementationPlanRetention": "keep", "thinkingLevel": "high"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(prepare, "PI_PLAN_PACKAGE_PATH", package)
    monkeypatch.setattr(prepare, "PI_PLAN_CONFIGURATION_PATH", cfg)

    with pytest.raises(RuntimeError) as caught:
        verify_pi_plan_configuration(when=START)

    assert str(caught.value) == (
        "Pi plan configuration mismatch: "
        f"extension version expected '{PI_PLAN_EXTENSION_VERSION}', found '0.0.1'; "
        f"`implementationPlanRetention` expected '{PI_PLAN_RETENTION}', found 'keep'; "
        f"`thinkingLevel` expected '{PI_PLAN_THINKING_LEVEL}', found 'high'"
    )


def test_sandbox_profile_refuses_a_path_inside_the_clone(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    manifest.sandbox_profile_path = manifest.worktree / "agent.sb"

    with pytest.raises(ValueError, match="cannot be inside the fixture clone"):
        create_sandbox_profile(manifest)

    assert not manifest.sandbox_profile_path.exists()


def test_prepare_requires_generated_seeds(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Generated seed does not exist"):
        prepare_run(tmp_path, generate_matrix()[0])

    assert not (tmp_path / "artifacts").exists()


def test_prepare_replaces_an_existing_run_only_when_asked(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = generate_matrix()[0]
    manifest, _ = prepare_run(root, spec)
    stale = manifest.run_dir / "stale.txt"
    stale.write_text("stale\n", encoding="utf-8")

    with pytest.raises(FileExistsError, match="Run directory already exists"):
        prepare_run(root, spec)
    assert stale.is_file()

    replaced, _ = prepare_run(root, spec, replace=True)

    assert replaced.run_dir == manifest.run_dir
    assert not stale.exists()
    assert load_manifest(replaced.run_dir).seed_commit == manifest.seed_commit


def test_prepare_refuses_a_clone_that_is_not_pristine(
    tmp_path: Path,
    generated_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    real_output = prepare.output

    def dirty_status(argv: list[str], *, cwd: Path | None = None) -> str:
        if argv[1:] == ["status", "--porcelain"]:
            return " M src/module.py\n"
        return real_output(argv, cwd=cwd)

    monkeypatch.setattr(prepare, "output", dirty_status)

    with pytest.raises(RuntimeError, match=re.escape("with status 'M src/module.py'")):
        prepare_run(root, generate_matrix()[0])


def test_clarification_instructions_require_the_external_answer_file(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    spec = next(run for run in generate_matrix() if run.clarification is not None)
    manifest, _ = prepare_run(root, spec)
    manifest.clarification_path = None

    with pytest.raises(ValueError, match="requires an external answer artifact"):
        _instructions(manifest)


def test_mark_start_rejects_untracked_agent_files(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    (manifest.worktree / "notes.txt").write_text("early edit\n", encoding="utf-8")

    with pytest.raises(RunStateError, match=r"not pristine: '\?\? notes.txt'"):
        mark_run(manifest.run_dir, "start", when=START)

    assert load_manifest(manifest.run_dir).agent_started_at is None


def test_mark_start_names_only_unfinished_predecessors(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    first, second, third = generate_matrix()[:3]
    finished, _ = prepare_run(root, first)
    finished.status = RunStatus.FINALIZED
    save_manifest(finished)
    prepare_run(root, second)
    manifest, _ = prepare_run(root, third)

    with pytest.raises(RunStateError) as caught:
        mark_run(manifest.run_dir, "start", when=START)

    assert str(caught.value) == f"Matrix predecessor runs are not finalized: {[second.run_id]}"


@pytest.mark.parametrize("plan", [None, " \n"])
def test_mark_implementation_requires_accepted_plan_text(
    tmp_path: Path,
    generated_workspace: Path,
    plan: str | None,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    mark_run(manifest.run_dir, "start", when=START)
    if plan is not None:
        manifest.accepted_plan_path.write_text(plan, encoding="utf-8")

    with pytest.raises(RunStateError, match="Accepted plan artifact is missing or empty"):
        mark_run(manifest.run_dir, "implementation", when=START + timedelta(seconds=1))

    assert load_manifest(manifest.run_dir).implementation_started_at is None


def test_gate_that_cannot_execute_is_a_failed_gate(tmp_path: Path) -> None:
    output_path = tmp_path / "gates" / "missing.log"

    result = _run_gate("missing", [str(tmp_path / "no-such-gate")], tmp_path, output_path, {})

    assert result.exit_code == 127
    assert not result.passed
    assert output_path.read_text(encoding="utf-8").startswith("Could not execute gate: ")


def test_gate_snapshots_and_hidden_suite_replace_stale_copies(
    tmp_path: Path,
    generated_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    snapshot = snapshot_git(manifest.worktree, manifest.run_dir, manifest.seed_commit)
    destination = _materialize_gate_snapshot(manifest, snapshot, "visible")
    (destination / "stale.txt").write_text("stale\n", encoding="utf-8")

    assert _materialize_gate_snapshot(manifest, snapshot, "visible") == destination
    assert not (destination / "stale.txt").exists()

    stale_suite = manifest.run_dir / "hidden-suite" / "stale_test.py"
    stale_suite.parent.mkdir()
    stale_suite.write_text("stale\n", encoding="utf-8")
    calls: list[tuple[Path, dict[str, str]]] = []

    def record_gate(
        name: str, command: list[str], cwd: Path, output_path: Path, env: dict[str, str]
    ) -> GateResult:
        calls.append((cwd, env))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("", encoding="utf-8")
        return GateResult(
            name=name,
            command=command,
            exit_code=0,
            passed=True,
            duration_seconds=0,
            output_path=output_path,
        )

    monkeypatch.setattr(finalize, "_run_gate", record_gate)
    hidden_path = root / "workspace" / "hidden" / manifest.spec.fixture.value

    suite = _hidden_gate_suite(manifest, destination, hidden_path)

    assert suite.passed
    assert [cwd for cwd, _ in calls] == [manifest.benchmark_root, stale_suite.parent]
    assert all(env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] == "1" for _, env in calls)
    assert not stale_suite.exists()
    assert sorted(path.name for path in hidden_path.iterdir()) == sorted(
        path.name for path in stale_suite.parent.iterdir() if path.name != "pytest.ini"
    )


def test_documentation_status_classifies_non_python_changes() -> None:
    assert _documentation_status([]) is DocumentationStatus.NOT_APPLICABLE
    assert _documentation_status(["docs/usage.md", "src/a.py"]) is DocumentationStatus.UPDATED
    assert _documentation_status(["src/a.py"]) is DocumentationStatus.MISSING
    assert _documentation_status(["data.json"]) is DocumentationStatus.NOT_APPLICABLE


def test_failure_reason_reports_the_first_unmet_acceptance_condition(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])
    passed = _passed_suite(manifest, "visible")
    hidden_failed = _failed_suite(manifest, "hidden", "pytest")
    evidence = AcceptanceEvidence(
        planning_required=True,
        asked_before_choosing=None,
        plan_captured=True,
        documentation_required=False,
        documentation_status=DocumentationStatus.NOT_APPLICABLE,
    )

    assert (
        _failure_reason(passed, passed, replace(evidence, plan_captured=False))
        == "Accepted plan text was not captured before implementation"
    )
    assert (
        _failure_reason(passed, hidden_failed, evidence)
        == "Hidden acceptance subgates failed: pytest"
    )
    assert (
        _failure_reason(passed, passed, evidence)
        == "Required ambiguity clarification was not established before implementation"
    )
    assert _failure_reason(passed, passed, replace(evidence, asked_before_choosing=True)) is None


def test_final_seed_verification_requires_a_pristine_start(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest, _ = prepare_run(root, generate_matrix()[0])

    with pytest.raises(RunStateError, match="lacks pre-start pristine seed verification"):
        _verify_final_seed(manifest)


def test_claude_reasoning_needs_a_terminal_transcript() -> None:
    assert _reasoning_from_terminal(Harness.CLAUDE, []) is None


def _started_and_stopped(root: Path, spec_index: int = 0) -> RunManifest:
    manifest, _ = prepare_run(root, generate_matrix()[spec_index])
    mark_run(manifest.run_dir, "start", when=START, allow_out_of_order=True)
    return manifest


def test_finalize_requires_a_stop_boundary(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    manifest = _started_and_stopped(_benchmark_root(tmp_path, generated_workspace))

    with pytest.raises(RunStateError, match="Record `start` and `stop` before finalizing"):
        finalize_run(manifest.run_dir)


def test_finalize_rejects_contamination_written_during_the_run(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    manifest = _started_and_stopped(_benchmark_root(tmp_path, generated_workspace))
    (manifest.worktree / "notes" / "terminal.log").parent.mkdir()
    (manifest.worktree / "notes" / "terminal.log").write_text("copied\n", encoding="utf-8")
    mark_run(manifest.run_dir, "stop", when=START + timedelta(seconds=1))

    with pytest.raises(RunStateError, match="Final benchmark contamination found in clone"):
        finalize_run(manifest.run_dir)
    assert load_manifest(manifest.run_dir).status is RunStatus.PREPARED


def test_finalize_rejects_history_that_drops_the_seed(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    manifest = _started_and_stopped(_benchmark_root(tmp_path, generated_workspace))
    _commit(manifest.worktree, "checkout", "--quiet", "--orphan", "rewritten")
    _commit(manifest.worktree, "commit", "--quiet", "-m", "Rewrite history")
    mark_run(manifest.run_dir, "stop", when=START + timedelta(seconds=1))

    with pytest.raises(RunStateError, match="does not descend from seed"):
        finalize_run(manifest.run_dir)


def test_finalize_requires_the_hidden_acceptance_suite(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    manifest = _started_and_stopped(root)
    mark_run(manifest.run_dir, "stop", when=START + timedelta(seconds=1))
    shutil.rmtree(root / "workspace" / "hidden" / manifest.spec.fixture.value)

    with pytest.raises(FileNotFoundError, match="Hidden acceptance suite does not exist"):
        finalize_run(manifest.run_dir)
    assert load_manifest(manifest.run_dir).status is RunStatus.PREPARED


def test_finalize_takes_claude_reasoning_from_the_terminal_when_sessions_omit_it(
    tmp_path: Path,
    generated_workspace: Path,
    sample_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _benchmark_root(tmp_path, generated_workspace)
    index = next(i for i, run in enumerate(generate_matrix()) if run.harness is Harness.CLAUDE)
    manifest = _started_and_stopped(root, index)
    manifest.accepted_plan_path.write_text("Accepted plan\n", encoding="utf-8")
    mark_run(manifest.run_dir, "implementation", when=START + timedelta(seconds=10))
    mark_run(manifest.run_dir, "stop", when=START + timedelta(seconds=20))
    session_root = tmp_path / "claude-projects"
    session = session_root / "project" / "session.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text(
        json.dumps({"type": "system", "cwd": str(manifest.worktree)})
        + "\n"
        + (sample_dir / "claude-session.jsonl").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    mtime = (START + timedelta(seconds=15)).timestamp()
    os.utime(session, (mtime, mtime))
    manifest.terminal_log_path.write_text("Sonnet 5 with medium effort\n", encoding="utf-8")
    stopped = load_manifest(manifest.run_dir)
    stopped.native_session_roots = [session_root]
    save_manifest(stopped)
    monkeypatch.setattr(
        finalize, "_visible_gate_suite", lambda m, _cwd: _passed_suite(m, "visible")
    )
    monkeypatch.setattr(
        finalize, "_hidden_gate_suite", lambda m, _cwd, _hidden: _passed_suite(m, "hidden")
    )

    result = finalize_run(manifest.run_dir)

    assert result.actual_metadata.model == "claude-sonnet-5"
    assert result.actual_metadata.reasoning_level == "medium"
    assert _MISSING_REASONING_WARNING not in result.parser_warnings
    assert [item.source_kind for item in result.sessions] == ["terminal", "native-session"]
    assert session.is_file()
