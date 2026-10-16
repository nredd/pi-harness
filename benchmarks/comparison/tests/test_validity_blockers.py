from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from pi_harness_benchmark.artifacts import (
    _is_bounded_session_path,
    discover_session_logs,
    redact_text,
    snapshot_git,
)
from pi_harness_benchmark.finalize import (
    RunStateError,
    _gate_sandbox_profile,
    _materialize_gate_snapshot,
    _reasoning_from_terminal,
    mark_run,
)
from pi_harness_benchmark.matrix import generate_matrix
from pi_harness_benchmark.models import Harness, SessionArtifact
from pi_harness_benchmark.prepare import (
    PI_PLAN_EXTENSION_VERSION,
    _codex_permission_profile,
    _verified_cli_version,
    create_sandbox_profile,
    prepare_run,
)
from pi_harness_benchmark.process import executable
from pi_harness_benchmark.usage import SessionWindow, analyze_session

START = datetime(2026, 1, 1, tzinfo=UTC)
TRANSITION = START + timedelta(seconds=10)
STOP = START + timedelta(seconds=20)


def _clone_seed(tmp_path: Path) -> tuple[Path, str]:
    git = executable("git")
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.check_call([str(git), "init", "--quiet"], cwd=repo)
    subprocess.check_call([str(git), "config", "user.email", "test@example.invalid"], cwd=repo)
    subprocess.check_call([str(git), "config", "user.name", "Test"], cwd=repo)
    for name in ("committed.txt", "staged.txt", "unstaged.txt"):
        (repo / name).write_text("seed\n", encoding="utf-8")
    subprocess.check_call([str(git), "add", "."], cwd=repo)
    subprocess.check_call([str(git), "commit", "--quiet", "-m", "Seed"], cwd=repo)
    seed = subprocess.check_output([str(git), "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    return repo, seed


def test_snapshot_uses_seed_commit_across_every_git_state(tmp_path: Path) -> None:
    git = executable("git")
    repo, seed = _clone_seed(tmp_path)
    (repo / "committed.txt").write_text("agent commit\n", encoding="utf-8")
    subprocess.check_call([str(git), "add", "committed.txt"], cwd=repo)
    subprocess.check_call([str(git), "commit", "--quiet", "-m", "Agent commit"], cwd=repo)
    (repo / "staged.txt").write_text("staged\n", encoding="utf-8")
    subprocess.check_call([str(git), "add", "staged.txt"], cwd=repo)
    (repo / "unstaged.txt").write_text("unstaged\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("untracked\n", encoding="utf-8")

    snapshot = snapshot_git(repo, tmp_path / "artifacts", seed)

    assert snapshot.changed_paths == [
        "committed.txt",
        "staged.txt",
        "unstaged.txt",
        "untracked.txt",
    ]
    patch = snapshot.diff_path.read_text(encoding="utf-8")
    assert all(value in patch for value in ("agent commit", "staged", "unstaged", "untracked"))
    assert "committed.txt" in snapshot.diff_stat_path.read_text(encoding="utf-8")


def test_generated_sandbox_denies_controls_and_allows_only_worktree(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    source_fixture = root / "src" / "pi_harness_benchmark" / "fixtures.py"
    source_fixture.parent.mkdir(parents=True)
    source_fixture.write_text("CONTROL = True\n", encoding="utf-8")
    global_cfg = tmp_path / "global-cli-config.json"
    global_cfg.write_text("{}\n", encoding="utf-8")
    manifest, _ = prepare_run(root, generate_matrix()[0])
    profile = create_sandbox_profile(manifest)
    allowed = manifest.worktree / "allowed.txt"
    pi_session_sink = manifest.run_dir / "native-sessions" / "pi" / "sandbox-test.jsonl"
    global_sink = tmp_path / "global-session.jsonl"
    prompt_symlink = manifest.worktree / "prompt-link"
    prompt_symlink.symlink_to(manifest.prompt_path)
    protected = [
        manifest.prompt_path,
        manifest.run_dir / "manifest.json",
        root / "workspace" / "hidden",
        source_fixture,
    ]
    script = "\n".join(
        [
            f"printf allowed > {allowed}",
            f"test -r {manifest.worktree / 'README.md'}",
            f"test -r {global_cfg}",
            f"printf session > {pi_session_sink}",
            f"printf global > {global_sink}",
            *[f"! test -r {path}" for path in protected],
            f"! /bin/cat {prompt_symlink} >/dev/null 2>&1",
            *[f"! /usr/bin/touch {path} 2>/dev/null" for path in protected],
        ]
    )

    completed = subprocess.run(
        ["/usr/bin/sandbox-exec", "-f", str(profile), "/bin/sh", "-c", script],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout
    realpath = subprocess.run(
        [
            "/usr/bin/sandbox-exec",
            "-f",
            str(profile),
            str(executable("node")),
            "-e",
            'require("node:fs").realpathSync(process.argv[1])',
            str(manifest.worktree / "README.md"),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

    assert realpath.returncode == 0, realpath.stdout
    assert allowed.read_text(encoding="utf-8") == "allowed"
    assert pi_session_sink.read_text(encoding="utf-8") == "session"
    assert global_sink.read_text(encoding="utf-8") == "global"
    assert str(manifest.prompt_path) not in manifest.launch_argv
    assert (
        manifest.spec.clarification is None
        or manifest.spec.clarification.answer not in json.dumps(manifest.launch_argv)
    )


def test_gate_sandbox_blocks_cross_suite_side_effects(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    manifest, _ = prepare_run(root, generate_matrix()[0])
    visible = manifest.run_dir / "gate-snapshots" / "visible"
    visible.mkdir(parents=True)
    profile = _gate_sandbox_profile(manifest, "test-visible", read_write_paths=[visible])
    hidden_test = root / "workspace" / "hidden" / "localized-bug" / "test_acceptance.py"

    allowed = subprocess.run(
        [
            "/usr/bin/sandbox-exec",
            "-f",
            str(profile),
            "/usr/bin/touch",
            str(visible / "allowed"),
        ],
        check=False,
    )
    denied = subprocess.run(
        [
            "/usr/bin/sandbox-exec",
            "-f",
            str(profile),
            "/usr/bin/touch",
            str(hidden_test),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert allowed.returncode == 0
    assert denied.returncode != 0
    assert hidden_test.read_text(encoding="utf-8").startswith("from __future__")


def test_gate_snapshots_are_independent_and_preserve_agent_patch(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    manifest, _ = prepare_run(root, generate_matrix()[0])
    changed = manifest.worktree / "README.md"
    changed.write_text(changed.read_text(encoding="utf-8") + "\nAgent change.\n", encoding="utf-8")
    snapshot = snapshot_git(manifest.worktree, manifest.run_dir, manifest.seed_commit)

    visible = _materialize_gate_snapshot(manifest, snapshot, "visible")
    (visible / "README.md").write_text("visible mutation\n", encoding="utf-8")
    hidden = _materialize_gate_snapshot(manifest, snapshot, "hidden")

    assert "Agent change." in (hidden / "README.md").read_text(encoding="utf-8")
    assert "visible mutation" not in (hidden / "README.md").read_text(encoding="utf-8")
    assert snapshot.diff_path.read_text(encoding="utf-8") == snapshot.diff_path.read_text(
        encoding="utf-8"
    )


def test_pi_prepare_records_exact_plan_extension_and_transition_instructions(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])

    manifest, instructions = prepare_run(root, generate_matrix()[0])

    assert manifest.pi_plan_configuration is not None
    assert manifest.pi_plan_configuration.extension_version == PI_PLAN_EXTENSION_VERSION
    assert manifest.pi_plan_configuration.implementation_plan_retention == "clear-after-first-run"
    assert manifest.pi_plan_configuration.thinking_level == "inherit"
    assert "/plan start" in instructions
    assert "Implement here" in instructions
    assert "current Normal auto mode" in instructions
    assert "/plan`" not in instructions


@pytest.mark.native_runtime
def test_codex_uses_native_read_isolation_without_nested_seatbelt(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    """Run the real pinned Codex sandbox; fails if the exact native CLI is not on `PATH`."""
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    spec = next(run for run in generate_matrix() if run.harness is Harness.CODEX)
    manifest, _ = prepare_run(root, spec)

    assert "/usr/bin/sandbox-exec" not in manifest.launch_command
    assert 'default_permissions="benchmark_isolated"' in manifest.launch_argv
    profile = _codex_permission_profile(manifest.run_dir)
    uv_cache = Path(os.environ.get("UV_CACHE_DIR", Path.home() / ".cache" / "uv")).resolve()
    assert f"{uv_cache}/**" in profile
    assert str(root / "workspace" / "**") in profile
    assert str(manifest.prompt_path) in profile
    assert spec.clarification is None or spec.clarification.answer not in profile

    common = [
        str(executable("codex")),
        "sandbox",
        "--permission-profile",
        "benchmark_isolated",
        "--cd",
        str(manifest.worktree),
        "--config",
        'default_permissions="benchmark_isolated"',
        "--config",
        profile,
    ]
    allowed = subprocess.run(
        [*common, "/bin/cat", "README.md"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    denied = subprocess.run(
        [
            *common,
            "/bin/cat",
            str(root / "workspace" / "hidden" / "localized-bug" / "test_acceptance.py"),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    cache_probe = uv_cache / ".pi-harness-sandbox-write-probe"
    cache_write = subprocess.run(
        [*common, "/usr/bin/touch", str(cache_probe)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

    probe_exists = cache_probe.is_file()
    cache_probe.unlink(missing_ok=True)

    assert allowed.returncode == 0, allowed.stdout
    assert cache_write.returncode == 0, cache_write.stdout
    assert probe_exists
    assert denied.returncode != 0
    assert "Operation not permitted" in denied.stdout


def test_claude_and_codex_emit_exact_same_session_implementation_steps(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    specs = {run.harness: run for run in generate_matrix()}

    _, claude = prepare_run(root, specs[Harness.CLAUDE])
    _, codex = prepare_run(root, specs[Harness.CODEX])

    assert "Yes, and use auto mode" in claude
    assert "Neither, I'll review first" in claude
    assert "same session" in claude
    assert "Accept Codex's workspace trust prompt" in codex
    assert codex.index("workspace trust prompt") < codex.index("TIMED NATIVE SESSION")
    assert "Yes, implement this plan" in codex
    assert "native handoff switches to Default mode" in codex
    assert "Implement the plan." in codex


def test_claude_reasoning_uses_native_terminal_evidence(tmp_path: Path) -> None:
    terminal = tmp_path / "terminal.log"
    terminal.write_text("Sonnet 5 with medium effort - Claude Max\n", encoding="utf-8")
    artifact = SessionArtifact(
        source_kind="terminal",
        source_path=terminal,
        redacted_path=terminal,
        sha256="a" * 64,
        byte_count=terminal.stat().st_size,
    )

    assert _reasoning_from_terminal(Harness.CLAUDE, [artifact]) == "medium"
    assert _reasoning_from_terminal(Harness.PI_ANTHROPIC, [artifact]) is None


def test_cli_version_parser_rejects_substring_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = generate_matrix()[0]
    monkeypatch.setattr("pi_harness_benchmark.prepare.output", lambda _argv: "pi 0.85.10")

    with pytest.raises(RuntimeError, match="version mismatch"):
        _verified_cli_version(spec, ["/fake/pi"])


def test_cli_version_parser_accepts_exact_semantic_version(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = generate_matrix()[0]
    monkeypatch.setattr("pi_harness_benchmark.prepare.output", lambda _argv: "pi version 0.85.1")

    assert _verified_cli_version(spec, ["/fake/pi"]) == "0.85.1"


@pytest.mark.parametrize(
    "source",
    [
        "HA_TOKEN=dummy-secret-value",
        "ha_token='dummy-secret-value'",
        '"password": "dummy-secret-value"',
        '"clientSecret":"dummy-secret-value"',
        "Authorization: Basic ZHVtbXk6c2VjcmV0",
        "authorization='Bearer dummy-secret-value'",
    ],
)
def test_redaction_catches_generic_secret_assignments(source: str) -> None:
    redacted = redact_text(source)

    assert "dummy-secret-value" not in redacted
    assert "ZHVtbXk6c2VjcmV0" not in redacted
    assert "[REDACTED]" in redacted


def test_sensitive_path_matching_rejects_exact_sensitive_filenames(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    manifest, _ = prepare_run(root, generate_matrix()[0])
    manifest.agent_started_at = START
    manifest.stopped_at = STOP
    for relative in ("auth.json", "settings.local.json", "credentials.json", "config.toml"):
        path = tmp_path / relative
        path.write_text("{}", encoding="utf-8")
        path.touch()
        subprocess.check_call(["/usr/bin/touch", "-t", "202601010000.01", str(path)])
        assert not _is_bounded_session_path(path, manifest)


def test_pi_log_discovery_deletes_raw_run_scoped_sources(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    manifest, _ = prepare_run(root, generate_matrix()[0])
    manifest.agent_started_at = START
    manifest.stopped_at = STOP
    source = manifest.native_session_roots[0] / "session.jsonl"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("{}\n", encoding="utf-8")
    subprocess.check_call(["/usr/bin/touch", "-t", "202601010000.01", str(source)])
    manifest.terminal_log_path.write_text("HA_TOKEN=dummy-secret-value\n", encoding="utf-8")
    subprocess.check_call(
        ["/usr/bin/touch", "-t", "202601010000.01", str(manifest.terminal_log_path)]
    )

    artifacts, _ = discover_session_logs(manifest)

    assert not source.exists()
    assert not manifest.terminal_log_path.exists()
    assert all(artifact.source_path == artifact.redacted_path for artifact in artifacts)
    assert all(
        "dummy-secret-value" not in artifact.redacted_path.read_text() for artifact in artifacts
    )


def test_mark_start_requires_every_matrix_predecessor_finalized(
    tmp_path: Path,
    generated_workspace: Path,
) -> None:
    root = tmp_path / "benchmark"
    root.mkdir()
    subprocess.check_call(["/bin/cp", "-R", str(generated_workspace), str(root / "workspace")])
    second = generate_matrix()[1]
    manifest, _ = prepare_run(root, second)

    with pytest.raises(RunStateError, match="predecessor"):
        mark_run(manifest.run_dir, "start", when=START)

    marked = mark_run(
        manifest.run_dir,
        "start",
        when=START,
        allow_out_of_order=True,
    )
    assert marked.agent_started_at == START


def _write_records(path: Path, records: Sequence[object]) -> None:
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")


@pytest.mark.parametrize(
    ("harness", "question_item"),
    [
        (
            Harness.PI_ANTHROPIC,
            {
                "type": "message",
                "timestamp": "2026-01-01T00:00:05Z",
                "message": {
                    "role": "assistant",
                    "id": "a",
                    "content": [
                        {
                            "type": "toolCall",
                            "name": "plan_mode_question",
                            "arguments": {
                                "questions": [
                                    {
                                        "question": "Where should summarize(..., limit=N) apply its cap?",
                                        "options": [{"label": "After"}, {"label": "Before"}],
                                    }
                                ]
                            },
                        }
                    ],
                },
            },
        ),
        (
            Harness.CLAUDE,
            {
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:05Z",
                "message": {
                    "role": "assistant",
                    "id": "a",
                    "model": "claude-sonnet-5",
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "AskUserQuestion",
                            "input": {
                                "questions": [
                                    {
                                        "question": "Should limit apply before filtering or after ordering?"
                                    }
                                ]
                            },
                        }
                    ],
                },
            },
        ),
        (
            Harness.CODEX,
            {
                "type": "response_item",
                "timestamp": "2026-01-01T00:00:05Z",
                "payload": {
                    "type": "function_call",
                    "name": "request_user_input",
                    "arguments": json.dumps(
                        {
                            "questions": [
                                {
                                    "question": "Should limit apply before filtering or after ordering?"
                                }
                            ]
                        }
                    ),
                },
            },
        ),
    ],
)
def test_structured_question_arguments_establish_prechoice_question(
    tmp_path: Path,
    harness: Harness,
    question_item: dict[str, object],
) -> None:
    path = tmp_path / "session.jsonl"
    task_text = (
        "Add limit support. One high-impact choice is unresolved: whether limit applies to raw "
        "input rows before filtering and ordering, or returned records after filtering and ordering."
    )
    task = (
        {
            "type": "response_item",
            "timestamp": "2026-01-01T00:00:03Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": task_text}],
            },
        }
        if harness is Harness.CODEX
        else {
            "type": "message",
            "timestamp": "2026-01-01T00:00:03Z",
            "message": {"role": "user", "content": task_text},
        }
    )
    choice = {
        "type": "event_msg" if harness is Harness.CODEX else "message",
        "timestamp": "2026-01-01T00:00:06Z",
        "payload": {
            "type": "user_message",
            "message": "limit counts emitted active records after filtering and ordering, not input rows",
        },
        "message": {
            "role": "user",
            "content": "limit counts emitted active records after filtering and ordering, not input rows",
        },
    }
    _write_records(path, [task, question_item, choice])

    analysis = analyze_session(
        harness,
        [path],
        SessionWindow(START, TRANSITION, STOP),
        generate_matrix()[8].clarification,
    )

    assert analysis.planning_quality.asked_before_choosing is True
    assert "structured" in (analysis.planning_quality.evidence or "").lower()


def test_postchoice_question_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write_records(
        path,
        [
            {
                "type": "message",
                "timestamp": "2026-01-01T00:00:04Z",
                "message": {
                    "role": "assistant",
                    "content": "I will apply limit after filtering and ordering, not input rows.",
                },
            },
            {
                "type": "message",
                "timestamp": "2026-01-01T00:00:05Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "name": "plan_mode_question",
                            "arguments": {
                                "questions": [
                                    {
                                        "question": "Should limit apply before filtering or after ordering?"
                                    }
                                ]
                            },
                        }
                    ],
                },
            },
        ],
    )

    analysis = analyze_session(
        Harness.PI_ANTHROPIC,
        [path],
        SessionWindow(START, TRANSITION, STOP),
        generate_matrix()[8].clarification,
    )

    assert analysis.planning_quality.asked_before_choosing is False
    assert "after" in (analysis.planning_quality.evidence or "").lower()
