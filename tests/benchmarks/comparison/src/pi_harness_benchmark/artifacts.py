"""Discover, redact, and snapshot benchmark artifacts.

References:
- https://git-scm.com/docs/git-diff
- https://docs.python.org/3/library/hashlib.html
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from pi_harness_benchmark.models import GitSnapshot, RunManifest, SessionArtifact
from pi_harness_benchmark.process import executable, output

AUTH_HEADER_RE = re.compile(r"(?i)\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+")
ASSIGNMENT_RE = re.compile(
    r"(?P<prefix>(?P<key_quote>[\"']?)(?P<key>[A-Za-z][A-Za-z0-9_.-]*)"
    r"(?P=key_quote)\s*(?:=|:)\s*)"
    r"(?P<value>\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^\s,;}]+)"
)
SENSITIVE_DIRECTORY_NAMES = frozenset({"auth", "credentials", "keychain", "secrets"})
SENSITIVE_FILE_NAMES = frozenset(
    {
        "auth.json",
        "config.toml",
        "credentials.json",
        "secrets.json",
        "settings.local.json",
    }
)
SENSITIVE_KEY_WORDS = frozenset(
    {"apikey", "authorization", "clientsecret", "password", "secret", "token"}
)
SESSION_SUFFIXES = frozenset({".json", ".jsonl"})


def redact_text(text: str) -> str:
    """Redact credential-shaped values while retaining token-count fields.

    Parameters:
        text (str): Session or terminal text.

    Returns:
        str: Redacted text.
    """

    def replace_assignment(match: re.Match[str]) -> str:
        key = match.group("key")
        normalized = re.sub(r"[^a-z0-9]+", "", key.lower())
        words = {
            word
            for word in re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key)
            .lower()
            .replace("-", "_")
            .replace(".", "_")
            .split("_")
            if word
        }
        sensitive = normalized in SENSITIVE_KEY_WORDS or bool(words & SENSITIVE_KEY_WORDS)
        if key.lower().endswith(("_tokens", "_token_usage")) or key.lower() in {
            "input_tokens",
            "output_tokens",
            "reasoning_tokens",
            "total_tokens",
        }:
            sensitive = False
        if not sensitive:
            return match.group(0)
        value = match.group("value")
        quote = value[0] if value[:1] in {'"', "'"} else ""
        replacement = f"{quote}[REDACTED]{quote}" if quote else "[REDACTED]"
        return f"{match.group('prefix')}{replacement}"

    redacted = AUTH_HEADER_RE.sub(lambda match: f"{match.group(0).split()[0]} [REDACTED]", text)
    return ASSIGNMENT_RE.sub(replace_assignment, redacted)


def _copy_redacted(source: Path, destination: Path, kind: str) -> SessionArtifact:
    """Copy one allowed log through mandatory redaction.

    Parameters:
        source (Path): Terminal or native session log.
        destination (Path): Artifact destination.
        kind (str): Artifact source label.

    Returns:
        SessionArtifact: Validated copy metadata.
    """
    text = source.read_text(encoding="utf-8", errors="replace")
    redacted = redact_text(text).encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(redacted)
    return SessionArtifact(
        source_kind=kind,
        source_path=destination,
        redacted_path=destination,
        sha256=hashlib.sha256(redacted).hexdigest(),
        byte_count=len(redacted),
    )


def _is_bounded_session_path(path: Path, manifest: RunManifest) -> bool:
    """Return whether one path is a safe session file within the timed interval.

    Parameters:
        path (Path): Potential session file.
        manifest (RunManifest): Timed run identity.

    Returns:
        bool: True when path, suffix, and modification time are allowed.
    """
    if not path.is_file() or path.suffix.lower() not in SESSION_SUFFIXES:
        return False
    components = [part.lower() for part in path.parts]
    if any(
        component in SENSITIVE_DIRECTORY_NAMES or component in SENSITIVE_FILE_NAMES
        for component in components
    ):
        return False
    if manifest.agent_started_at is None or manifest.stopped_at is None:
        return False
    modified = datetime.fromtimestamp(path.stat().st_mtime, tz=manifest.agent_started_at.tzinfo)
    return manifest.agent_started_at <= modified <= manifest.stopped_at


def _is_session_candidate(path: Path, root: Path, manifest: RunManifest) -> bool:
    """Return whether one path is an allowed, associated native session log.

    Parameters:
        path (Path): Potential session file.
        root (Path): Configured native session root.
        manifest (RunManifest): Timed run identity.

    Returns:
        bool: True when the path is safe and belongs to this run.
    """
    if not _is_bounded_session_path(path, manifest):
        return False
    if root == manifest.run_dir / "native-sessions" / "pi":
        return True
    sample = path.read_text(encoding="utf-8", errors="replace")
    return str(manifest.worktree) in sample or manifest.spec.run_id in sample


def _session_candidates(manifest: RunManifest) -> list[Path]:
    """Collect unique native session candidates from approved roots.

    Parameters:
        manifest (RunManifest): Timed run identity.

    Returns:
        list[Path]: Sorted candidate paths.
    """
    candidates = [
        path
        for root in manifest.native_session_roots
        if root.is_dir()
        for path in root.rglob("*")
        if _is_session_candidate(path, root, manifest)
    ]
    linked = [
        child
        for candidate in candidates
        if (session_dir := candidate.with_suffix("")).is_dir()
        for child in session_dir.rglob("*")
        if _is_bounded_session_path(child, manifest)
    ]
    return sorted(dict.fromkeys(candidates + linked))


def discover_session_logs(manifest: RunManifest) -> tuple[list[SessionArtifact], list[str]]:
    """Discover only timestamp-bounded native logs associated with this worktree.

    Parameters:
        manifest (RunManifest): Stopped run manifest.

    Returns:
        tuple[list[SessionArtifact], list[str]]: Redacted artifacts and warnings.

    Raises:
        ValueError: If start or stop timestamps are absent.
    """
    if manifest.agent_started_at is None or manifest.stopped_at is None:
        msg = "Run must have `agent_started_at` and `stopped_at` before log discovery"
        raise ValueError(msg)
    destination_root = manifest.run_dir / "session-logs"
    artifacts: list[SessionArtifact] = []
    warnings: list[str] = []
    if manifest.terminal_log_path.is_file():
        artifacts.append(
            _copy_redacted(
                manifest.terminal_log_path,
                destination_root / "terminal.log",
                "terminal",
            )
        )
        manifest.terminal_log_path.unlink()
    else:
        warnings.append(f"Terminal log is missing: '{manifest.terminal_log_path}'")

    candidates = _session_candidates(manifest)
    for index, source in enumerate(candidates):
        suffix = source.suffix if source.suffix in SESSION_SUFFIXES else ".log"
        destination = destination_root / f"native-{index:02d}{suffix}"
        artifacts.append(_copy_redacted(source, destination, "native-session"))
    pi_root = manifest.run_dir / "native-sessions" / "pi"
    if pi_root in manifest.native_session_roots and pi_root.exists():
        shutil.rmtree(pi_root)
    if not candidates:
        warnings.append("No matching native JSON/JSONL session log was discovered")
    return artifacts, warnings


def snapshot_git(worktree: Path, artifact_dir: Path, seed_commit: str) -> GitSnapshot:
    """Capture tracked and untracked changes without modifying the worktree or index.

    Parameters:
        worktree (Path): Disposable fixture clone.
        artifact_dir (Path): Run artifact directory outside the clone.
        seed_commit (str): Pristine manifest commit used as the diff base.

    Returns:
        GitSnapshot: Commit, paths, and patch metadata.
    """
    worktree = Path(str(worktree)).resolve()
    artifact_dir = Path(str(artifact_dir)).resolve()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    git = executable("git")
    head = output([str(git), "rev-parse", "HEAD"], cwd=worktree).strip()
    tracked_changes = output(
        [str(git), "diff", "--name-only", "-z", "--no-renames", seed_commit, "--"],
        cwd=worktree,
    ).split("\0")
    untracked_changes = output(
        [str(git), "ls-files", "--others", "--exclude-standard", "-z"], cwd=worktree
    ).split("\0")
    changed_paths = sorted(
        dict.fromkeys(path for path in tracked_changes + untracked_changes if path)
    )
    patch = output([str(git), "diff", "--binary", seed_commit, "--"], cwd=worktree)
    tracked = set(output([str(git), "ls-files"], cwd=worktree).splitlines())
    for relative in changed_paths:
        candidate = worktree / relative
        if relative in tracked or not candidate.is_file():
            continue
        completed = subprocess.run(
            [str(git), "diff", "--binary", "--no-index", "--", "/dev/null", relative],
            cwd=worktree,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if completed.returncode not in {0, 1}:
            msg = f"Could not snapshot untracked path '{relative}': {completed.stdout.strip()}"
            raise RuntimeError(msg)
        patch += completed.stdout
    diff_path = artifact_dir / "agent.diff"
    diff_stat_path = artifact_dir / "agent.diffstat"
    diff_path.write_text(patch, encoding="utf-8")
    patch_lines = patch.splitlines()
    added_lines = sum(line.startswith("+") and not line.startswith("+++") for line in patch_lines)
    deleted_lines = sum(line.startswith("-") and not line.startswith("---") for line in patch_lines)
    stat = output([str(git), "diff", "--stat", seed_commit, "--"], cwd=worktree)
    if any(path not in tracked for path in changed_paths):
        stat += "\nUntracked paths:\n" + "\n".join(
            path for path in changed_paths if path not in tracked
        )
    diff_stat_path.write_text(stat, encoding="utf-8")
    return GitSnapshot(
        head=head,
        diff_path=diff_path,
        diff_stat_path=diff_stat_path,
        changed_paths=changed_paths,
        dirty=bool(changed_paths),
        patch_bytes=len(patch.encode()),
        patch_lines=len(patch_lines),
        added_lines=added_lines,
        deleted_lines=deleted_lines,
    )
