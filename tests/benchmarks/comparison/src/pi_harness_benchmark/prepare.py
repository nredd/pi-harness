"""Prepare pristine clones and native interactive launch instructions.

References:
- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
- https://docs.anthropic.com/en/docs/claude-code
- https://github.com/openai/codex
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
from datetime import UTC, datetime
from pathlib import Path

from pi_harness_benchmark.fixtures import fixture_prompt
from pi_harness_benchmark.models import (
    Harness,
    PiPlanConfiguration,
    RunManifest,
    RunSpec,
    RunStatus,
)
from pi_harness_benchmark.process import executable, output

SEMANTIC_VERSION_RE = re.compile(
    r"(?<![0-9A-Za-z])(?P<version>(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z])"
)
PI_PLAN_EXTENSION_VERSION = "0.58.0"
PI_PLAN_PACKAGE_PATH = (
    Path.home()
    / ".pi"
    / "agent"
    / "npm"
    / "node_modules"
    / "@narumitw"
    / "pi-plan-mode"
    / "package.json"
)
PI_PLAN_CONFIGURATION_PATH = Path.home() / ".pi" / "agent" / "pi-plan-mode.json"
PI_PLAN_RETENTION = "clear-after-first-run"
PI_PLAN_THINKING_LEVEL = "inherit"
CLI_VERSIONS = {
    Harness.PI_ANTHROPIC: "0.85.1",
    Harness.PI_OPENAI: "0.85.1",
    Harness.CLAUDE: "2.1.268",
    Harness.CODEX: "0.154.0",
}


def _codex_permission_profile(run_dir: Path) -> str:
    """Build Codex-native read isolation without nesting macOS sandboxes.

    Codex executes tools in its own Seatbelt sandbox. Wrapping the TUI in another
    ``sandbox-exec`` process prevents that sandbox from initializing, so Codex gets
    an equivalent native permission profile instead. The profile inherits the normal
    workspace permissions and denies benchmark controls outside the worktree.

    Parameters:
        run_dir (Path): Current run artifact directory.

    Returns:
        str: TOML inline table accepted by Codex's ``--config`` option.
    """
    root = run_dir.parents[2]
    denied = [
        root / "workspace" / "**",
        root / "src" / "**",
        root / "tests" / "**",
        root / "README.md",
        root / "Makefile",
        root / "pyproject.toml",
        root / "uv.lock",
        run_dir / "prompt.txt",
        run_dir / "clarification.txt",
        run_dir / "accepted-plan.md",
        run_dir / "manifest.json",
        run_dir / "INSTRUCTIONS.txt",
        run_dir / "native-tui.sb",
        run_dir / "terminal.raw.log",
    ]
    runs_root = run_dir.parent
    denied.extend(path / "**" for path in runs_root.iterdir() if path != run_dir)
    uv_cache = Path(os.environ.get("UV_CACHE_DIR", Path.home() / ".cache" / "uv")).resolve()
    filesystem_rules = [f'{json.dumps(str(uv_cache / "**"))}="write"']
    filesystem_rules.extend(f'{json.dumps(str(path))}="deny"' for path in denied)
    rules = ", ".join(filesystem_rules)
    return f'permissions.benchmark_isolated={{extends=":workspace", filesystem={{{rules}}}}}'


def _launch_argv(spec: RunSpec, run_dir: Path) -> list[str]:
    """Build the native interactive CLI argument vector.

    Parameters:
        spec (RunSpec): Matrix row to prepare.
        run_dir (Path): Artifact directory outside the clone.

    Returns:
        list[str]: Native CLI argument vector without a task prompt.
    """
    if spec.harness is Harness.PI_ANTHROPIC:
        return [
            str(executable("pi")),
            "--provider",
            "anthropic",
            "--model",
            spec.model,
            "--thinking",
            "medium",
            "--session-dir",
            str(run_dir / "native-sessions" / "pi"),
            "--name",
            spec.run_id,
        ]
    if spec.harness is Harness.PI_OPENAI:
        return [
            str(executable("pi")),
            "--provider",
            "openai-codex",
            "--model",
            spec.model,
            "--thinking",
            "medium",
            "--session-dir",
            str(run_dir / "native-sessions" / "pi"),
            "--name",
            spec.run_id,
        ]
    if spec.harness is Harness.CLAUDE:
        return [
            str(executable("claude")),
            "--model",
            spec.model,
            "--effort",
            "medium",
            "--permission-mode",
            "plan",
        ]
    return [
        str(executable("codex")),
        "--model",
        spec.model,
        "--config",
        'model_reasoning_effort="medium"',
        "--config",
        'default_permissions="benchmark_isolated"',
        "--config",
        _codex_permission_profile(run_dir),
        "--cd",
        str(run_dir / "worktree"),
    ]


def _semantic_version(text: str) -> str | None:
    """Extract one unambiguous semantic version from CLI output.

    Parameters:
        text (str): Native version command output.

    Returns:
        str | None: Exact semantic version, or None when absent or ambiguous.
    """
    versions = [match.group("version") for match in SEMANTIC_VERSION_RE.finditer(text)]
    unique = list(dict.fromkeys(versions))
    return unique[0] if len(unique) == 1 else None


def _verified_cli_version(spec: RunSpec, launch_argv: list[str]) -> str:
    """Verify that the installed native CLI matches the pinned benchmark version.

    Parameters:
        spec (RunSpec): Matrix row being prepared.
        launch_argv (list[str]): Resolved native launch vector.

    Returns:
        str: Pinned normalized CLI version.

    Raises:
        RuntimeError: If the installed version differs from the benchmark pin.
    """
    expected = CLI_VERSIONS[spec.harness]
    raw_actual = output([launch_argv[0], "--version"]).strip()
    actual = _semantic_version(raw_actual)
    if actual != expected:
        msg = (
            f"Native CLI version mismatch for '{spec.harness}': expected '{expected}', "
            f"found '{raw_actual}'"
        )
        raise RuntimeError(msg)
    return expected


def verify_pi_plan_configuration(*, when: datetime | None = None) -> PiPlanConfiguration:
    """Verify and snapshot the exact non-secret Pi plan settings.

    Parameters:
        when (datetime | None): Explicit UTC verification time for tests.

    Returns:
        PiPlanConfiguration: Validated version, settings, hash, and timestamp.

    Raises:
        FileNotFoundError: If the package or configuration is absent.
        RuntimeError: If the installed version or relevant values differ from the pins.
    """
    package = json.loads(PI_PLAN_PACKAGE_PATH.read_text(encoding="utf-8"))
    cfg = json.loads(PI_PLAN_CONFIGURATION_PATH.read_text(encoding="utf-8"))
    version = package.get("version")
    retention = cfg.get("implementationPlanRetention")
    thinking = cfg.get("thinkingLevel")
    mismatches = []
    if version != PI_PLAN_EXTENSION_VERSION:
        mismatches.append(
            f"extension version expected '{PI_PLAN_EXTENSION_VERSION}', found '{version}'"
        )
    if retention != PI_PLAN_RETENTION:
        mismatches.append(
            f"`implementationPlanRetention` expected '{PI_PLAN_RETENTION}', found '{retention}'"
        )
    if thinking != PI_PLAN_THINKING_LEVEL:
        mismatches.append(
            f"`thinkingLevel` expected '{PI_PLAN_THINKING_LEVEL}', found '{thinking}'"
        )
    if mismatches:
        msg = "Pi plan configuration mismatch: " + "; ".join(mismatches)
        raise RuntimeError(msg)
    snapshot = {
        "extension_version": version,
        "implementationPlanRetention": retention,
        "thinkingLevel": thinking,
    }
    snapshot_bytes = json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
    timestamp = (when or datetime.now(UTC)).astimezone(UTC)
    return PiPlanConfiguration(
        extension_version=version,
        implementation_plan_retention=retention,
        thinking_level=thinking,
        snapshot_sha256=hashlib.sha256(snapshot_bytes).hexdigest(),
        verified_at=timestamp,
    )


def _sbpl_path(path: Path) -> str:
    """Quote one resolved path as an SBPL string literal.

    Parameters:
        path (Path): Filesystem path.

    Returns:
        str: JSON-compatible quoted string accepted by Seatbelt.
    """
    return json.dumps(str(Path(str(path)).resolve()))


def _sandbox_profile_text(manifest: RunManifest) -> str:
    """Render the least benchmark-specific native TUI Seatbelt profile.

    Parameters:
        manifest (RunManifest): Prepared run paths.

    Returns:
        str: SBPL profile denying the benchmark except approved writable subtrees.
    """
    root = _sbpl_path(manifest.benchmark_root)
    worktree = _sbpl_path(manifest.worktree)
    lines = [
        "(version 1)",
        "(allow default)",
        f"(deny file-read* (subpath {root}))",
        f"(deny file-write* (subpath {root}))",
        # Node's mutation tools call realpath(3), which needs ancestor metadata but not contents.
        f"(allow file-read-metadata (subpath {root}))",
        f"(allow file-read* (subpath {worktree}))",
        f"(allow file-write* (subpath {worktree}))",
    ]
    if manifest.spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        session_dir = _sbpl_path(manifest.run_dir / "native-sessions" / "pi")
        lines.extend(
            [
                f"(allow file-read* (subpath {session_dir}))",
                f"(allow file-write* (subpath {session_dir}))",
            ]
        )
    return "\n".join(lines) + "\n"


def create_sandbox_profile(manifest: RunManifest) -> Path:
    """Write the harness-owned Seatbelt profile outside the fixture clone.

    Parameters:
        manifest (RunManifest): Prepared run manifest.

    Returns:
        Path: Written profile path.
    """
    profile = manifest.sandbox_profile_path
    if profile.is_relative_to(manifest.worktree):
        msg = f"Sandbox profile cannot be inside the fixture clone: '{profile}'"
        raise ValueError(msg)
    profile.write_text(_sandbox_profile_text(manifest), encoding="utf-8")
    return profile


def _session_roots(spec: RunSpec, run_dir: Path) -> list[Path]:
    """Return narrowly scoped native session discovery roots.

    Parameters:
        spec (RunSpec): Matrix row to prepare.
        run_dir (Path): Artifact directory.

    Returns:
        list[Path]: Session roots; never credential or authentication paths.
    """
    if spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        return [run_dir / "native-sessions" / "pi"]
    if spec.harness is Harness.CLAUDE:
        return [Path.home() / ".claude" / "projects"]
    return [Path.home() / ".codex" / "sessions"]


def prepare_run(root: Path, spec: RunSpec, *, replace: bool = False) -> tuple[RunManifest, str]:
    """Clone a pristine seed and create operator instructions.

    Parameters:
        root (Path): Benchmark project root.
        spec (RunSpec): Run matrix row.
        replace (bool): Replace an existing prepared run when true.

    Returns:
        tuple[RunManifest, str]: Validated manifest and launch instructions.

    Raises:
        FileExistsError: If the run directory already exists.
        FileNotFoundError: If fixtures have not been generated.
    """
    root = Path(str(root)).resolve()
    seed = root / "workspace" / "seeds" / spec.fixture.value
    if not (seed / ".git").is_dir():
        msg = f"Generated seed does not exist: '{seed}'"
        raise FileNotFoundError(msg)
    run_dir = root / "artifacts" / "runs" / spec.run_id
    if run_dir.exists():
        if not replace:
            msg = f"Run directory already exists: '{run_dir}'"
            raise FileExistsError(msg)
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    worktree = run_dir / "worktree"
    git = executable("git")
    seed_commit = output([str(git), "rev-parse", "HEAD"], cwd=seed).strip()
    output([str(git), "clone", "--quiet", str(seed), str(worktree)])
    clone_head = output([str(git), "rev-parse", "HEAD"], cwd=worktree).strip()
    clone_status = output([str(git), "status", "--porcelain"], cwd=worktree)
    if clone_head != seed_commit or clone_status:
        msg = (
            f"Pristine clone verification failed: expected HEAD '{seed_commit}', "
            f"found '{clone_head}' with status '{clone_status.strip()}'"
        )
        raise RuntimeError(msg)

    prompt_path = run_dir / "prompt.txt"
    prompt_path.write_text(f"{fixture_prompt(spec.fixture)}\n", encoding="utf-8")
    clarification_path = None
    if spec.clarification is not None:
        clarification_path = run_dir / "clarification.txt"
        clarification_path.write_text(f"{spec.clarification.answer}\n", encoding="utf-8")
    accepted_plan_path = run_dir / "accepted-plan.md"
    terminal_log_path = run_dir / "terminal.raw.log"
    launch_argv = _launch_argv(spec, run_dir)
    cli_version = _verified_cli_version(spec, launch_argv)
    pi_plan_configuration = (
        verify_pi_plan_configuration()
        if spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}
        else None
    )
    if spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        (run_dir / "native-sessions" / "pi").mkdir(parents=True)
    sandbox_profile_path = run_dir / "native-tui.sb"
    sandbox_argv = (
        launch_argv
        if spec.harness is Harness.CODEX
        else [
            "/usr/bin/sandbox-exec",
            "-f",
            str(sandbox_profile_path),
            "--",
            *launch_argv,
        ]
    )
    script_argv = [str(executable("script")), "-q", str(terminal_log_path), *sandbox_argv]
    manifest = RunManifest(
        schema_version="2.0",
        status=RunStatus.PREPARED,
        spec=spec,
        benchmark_root=root,
        run_dir=run_dir,
        worktree=worktree,
        seed_commit=seed_commit,
        prepared_at=datetime.now(UTC),
        prompt_path=prompt_path,
        accepted_plan_path=accepted_plan_path,
        clarification_path=clarification_path,
        terminal_log_path=terminal_log_path,
        native_session_roots=_session_roots(spec, run_dir),
        launch_argv=launch_argv,
        launch_command=shlex.join(script_argv),
        sandbox_profile_path=sandbox_profile_path,
        pi_plan_configuration=pi_plan_configuration,
        cli_version=cli_version,
    )
    create_sandbox_profile(manifest)
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    instructions = _instructions(manifest)
    (run_dir / "INSTRUCTIONS.txt").write_text(instructions, encoding="utf-8")
    return manifest, instructions


def _instructions(manifest: RunManifest) -> str:
    """Render exact operator-driven native TUI steps.

    Parameters:
        manifest (RunManifest): Prepared run manifest.

    Returns:
        str: Human-readable setup, timing, plan, and stop procedure.
    """
    root = manifest.benchmark_root
    run_dir = manifest.run_dir
    worktree = manifest.worktree
    cli = str(executable("pi-harness-benchmark"))
    lines = [
        "SETUP (outside timing and model interaction)",
        f"1. cd {shlex.quote(str(worktree))}",
    ]
    if manifest.spec.harness is Harness.CLAUDE:
        trust_argv = [
            str(executable("claude")),
            "--model",
            manifest.spec.model,
            "--effort",
            "medium",
        ]
        lines.extend(
            [
                f"2. Run {shlex.join(trust_argv)}",
                "3. Accept Claude's workspace trust prompt for this fresh clone, then `/exit` "
                "without submitting any prompt.",
                "4. Confirm `git status --short` is empty.",
            ]
        )
    elif manifest.spec.harness is Harness.CODEX:
        lines.extend(
            [
                f"2. Run {shlex.join(manifest.launch_argv)}",
                "3. Accept Codex's workspace trust prompt for this fresh clone, then `/exit` "
                "without submitting any prompt.",
                "4. Confirm `git status --short` is empty.",
            ]
        )
    else:
        lines.append("2. Confirm `git status --short` is empty.")
    lines.extend(
        [
            "",
            "TIMED NATIVE SESSION",
            f"1. Run: {shlex.join([cli, 'mark', str(run_dir), 'start'])}",
            f"2. From the worktree, run: {manifest.launch_command}",
        ]
    )
    if manifest.spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        plan_step = "3. In Pi, run `/plan start`, then paste the exact contents of the prompt file."
    elif manifest.spec.harness is Harness.CLAUDE:
        plan_step = (
            "3. Claude starts in Plan permission mode. Paste the exact contents of the prompt file."
        )
    else:
        plan_step = (
            "3. In Codex, select Plan mode with Shift+Tab before pasting the exact prompt contents."
        )
    lines.extend([plan_step, f"   Prompt: {prompt_path_line(manifest.prompt_path)}"])
    next_step = 4
    if manifest.spec.clarification is not None:
        if manifest.clarification_path is None:
            msg = "Clarification metadata requires an external answer artifact"
            raise ValueError(msg)
        lines.extend(
            [
                "4. Do not volunteer the answer. The harness must ask the unresolved product "
                "question rather than guess. When it asks, paste this exact fixed answer:",
                f"   {manifest.spec.clarification.answer}",
                f"   Answer file: {prompt_path_line(manifest.clarification_path)}",
                "   If the harness guesses without asking, do not correct or coach it.",
            ]
        )
        next_step += 1
    lines.extend(
        [
            f"{next_step}. Save the accepted plan text outside the clone at "
            f"{manifest.accepted_plan_path}. It must be nonempty before implementation.",
            f"{next_step + 1}. Review the saved plan. When you accept it, immediately run this "
            "in another shell:",
            f"   {shlex.join([cli, 'mark', str(run_dir), 'implementation'])}",
            *implementation_steps(manifest, next_step + 2),
            f"{next_step + 3}. If asked whether to commit or push, use the fixed safety answer "
            "`Leave changes uncommitted and do not push.` In Claude's native choice UI, select "
            "`Neither, I'll review first`. Do not otherwise steer or rescue the agent.",
            f"{next_step + 4}. After the agent stops, exit the TUI and immediately run:",
            f"   {shlex.join([cli, 'mark', str(run_dir), 'stop'])}",
            f"{next_step + 5}. Finalize: {shlex.join([cli, 'finalize', str(run_dir)])}",
            "",
            "All terminal and native session logs stay outside `worktree/`. User CLI settings and "
            "authentication are inherited unchanged; the framework never reads auth files or "
            "environment secret values.",
            f"Benchmark root: {root}",
        ]
    )
    return "\n".join(lines) + "\n"


def implementation_steps(manifest: RunManifest, step: int) -> list[str]:
    """Return the exact native same-session implementation transition.

    Parameters:
        manifest (RunManifest): Prepared run manifest.
        step (int): One-based instruction step number.

    Returns:
        list[str]: Harness-specific autonomous implementation instructions.
    """
    if manifest.spec.harness in {Harness.PI_ANTHROPIC, Harness.PI_OPENAI}:
        return [
            f"{step}. In Pi, choose `Implement here`. Keep the current Normal auto mode. "
            "The verified `clear-after-first-run` policy clears retained plan state after the "
            "first implementation run. Do not manually edit or repair."
        ]
    if manifest.spec.harness is Harness.CLAUDE:
        return [
            f"{step}. In Claude, stay in the same session and choose the exact acceptance option "
            "`Yes, and use auto mode`. Let native auto mode implement without manual edits or "
            "repairs."
        ]
    return [
        f"{step}. In the same Codex session, press Shift+Tab after the proposed plan and choose "
        "`Yes, implement this plan`. The native handoff switches to Default mode and injects "
        "`Implement the plan.` Do not manually edit or repair."
    ]


def prompt_path_line(prompt_path: Path) -> str:
    """Return a shell-safe prompt display command.

    Parameters:
        prompt_path (Path): Prompt file outside the worktree.

    Returns:
        str: Exact command that displays the prompt.
    """
    return shlex.join(["/bin/cat", str(prompt_path)])


def load_manifest(run_dir: Path) -> RunManifest:
    """Load and validate a prepared run manifest.

    Parameters:
        run_dir (Path): Prepared run directory.

    Returns:
        RunManifest: Validated manifest.
    """
    manifest_path = Path(str(run_dir)).resolve() / "manifest.json"
    return RunManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))


def save_manifest(manifest: RunManifest) -> None:
    """Atomically save a run manifest.

    Parameters:
        manifest (RunManifest): Updated manifest.
    """
    path = manifest.run_dir / "manifest.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    temporary.replace(path)


def write_matrix(path: Path, runs: list[RunSpec]) -> None:
    """Write a validated run matrix as JSON.

    Parameters:
        path (Path): Destination JSON path.
        runs (list[RunSpec]): Matrix rows.
    """
    destination = Path(str(path)).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = [json.loads(run.model_dump_json()) for run in runs]
    destination.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
