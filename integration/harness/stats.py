"""Stats histories and cross-machine fixtures produced by the actual portable CLI.

No snapshot schema is mirrored here. Export/import runs the declared package's standalone
artifact in a producer home with no Pi packages or credentials.

References:
- https://github.com/nredd/pi-session-kit
- https://github.com/nredd/pi-subscription-router/blob/main/docs/reset-aware-stats-plan.md
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

from harness.session_kit import assistant, compact, iso

PORTABLE_ARTIFACT = Path(".local/lib/pi-stats-export.mjs")
PRIVATE_SENTINEL = "STATS-PRIVATE-TEXT-DO-NOT-EXPORT"
# Output tokens; assistant() adds input/cache counters for a total of 26 * output.
HOURLY_CALLS = [
    (1, "anthropic", "claude-opus-5-5", 1),
    (4, "openai-codex", "gpt-6.1-sol", 2),
    (6, "anthropic", "claude-opus-5-5", 3),
    (23, "openai-codex", "gpt-6.1-sol", 4),
    (25, "anthropic", "claude-opus-5-5", 5),
    (45 * 24, "openai-codex", "gpt-6.1-sol", 6),
]


@dataclass(frozen=True)
class ExportedMachine:
    """CLI result, not its snapshot schema.

    Attributes:
        machine_id (str): persistent install UUID.
        snapshot_dir (Path): exported per-machine directory.
    """

    machine_id: str
    snapshot_dir: Path


def write_history(agent_dir: Path, entries: list[str], *, session_id: str = "hourly") -> Path:
    """Write a real session containing private metadata that exports must omit.

    Parameters:
        agent_dir (Path): isolated producer or viewer agent directory.
        entries (list[str]): assistant JSONL entries.
        session_id (str): preserved session identity.

    Returns:
        Path: written history.

    Raises:
        ValueError: no assistant entries were supplied.
    """
    if not entries:
        raise ValueError("Stats history requires at least one entry")
    root = agent_dir / "sessions" / "--private-source-path--"
    root.mkdir(parents=True, exist_ok=True)
    header = {
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": json.loads(entries[0])["timestamp"],
        "cwd": str(root),
    }
    name = {"type": "session_info", "name": PRIVATE_SENTINEL}
    path = root / f"{session_id}.jsonl"
    path.write_text("\n".join([compact(header), compact(name), *entries]) + "\n")
    return path


def hourly_entries(now: datetime) -> list[str]:
    """Create UTC calls safely inside ranges, plus ignored and future usage.

    Parameters:
        now (datetime): aware reference instant shared by all producers.

    Returns:
        list[str]: six countable calls, followed by exclusions.

    Raises:
        ValueError: reference instant is timezone-naive.
    """
    if now.utcoffset() is None:
        raise ValueError("Hourly stats require a timezone-aware reference instant")
    entries = []
    for hours, provider, model, tokens in HOURLY_CALLS:
        entry = json.loads(assistant(now - timedelta(hours=hours), provider, model, tokens))
        entry["message"]["content"] = [{"type": "text", "text": PRIVATE_SENTINEL}]
        entries.append(compact(entry))
    entries.extend(
        [
            assistant(now + timedelta(days=2), "anthropic", "claude-opus-5-5", 1_000_000),
            assistant(now, "faux", "faux-1", 10_000_000),
            assistant(now, "router", "default", 0),
            compact(
                {
                    "type": "message",
                    "timestamp": iso(now),
                    "message": {
                        "role": "toolResult",
                        "content": [],
                        "usage": {"input": 50_000_000, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    },
                }
            ),
        ]
    )
    return entries


def portable_command(artifact: Path, home: Path, args: list[str]) -> str:
    """Run only Node and a copied standalone bundle in a package-free home.

    Parameters:
        artifact (Path): actual rendered portable bundle.
        home (Path): isolated home with no Pi installation or credentials.
        args (list[str]): CLI arguments.

    Returns:
        str: CLI stdout.

    Raises:
        FileNotFoundError: artifact or Node is unavailable.
        subprocess.CalledProcessError: CLI rejected the operation.
    """
    if not artifact.is_file():
        raise FileNotFoundError(f"Portable stats artifact is missing: '{artifact}'")
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("No `node` on PATH")
    home.mkdir(parents=True, exist_ok=True)
    standalone = home / PORTABLE_ARTIFACT
    standalone.parent.mkdir(parents=True, exist_ok=True)
    if artifact.resolve() != standalone.resolve():
        shutil.copy2(artifact, standalone)
    # No NODE_PATH, NODE_OPTIONS, auth variables, private extensions, or executable PATH.
    env = {"HOME": str(home), "PATH": os.defpath, "TZ": "UTC"}
    return subprocess.check_output(
        [node, str(standalone), *args], cwd=home, env=env, text=True, stderr=subprocess.STDOUT, timeout=30
    )


def export_machine(artifact: Path, home: Path, agent_dir: Path, output: Path) -> ExportedMachine:
    """Export a fake producer through the real CLI and validate its public result.

    Parameters:
        artifact (Path): rendered standalone bundle.
        home (Path): clean producer home.
        agent_dir (Path): source history directory.
        output (Path): shared data tree.

    Returns:
        ExportedMachine: persistent UUID and per-machine snapshot directory.

    Raises:
        ValueError: stdout violates the export CLI contract.
    """
    result = json.loads(
        portable_command(artifact, home, ["export", "--agent-dir", str(agent_dir), "--output", str(output)])
    )
    machine_id = str(result["machineId"])
    UUID(machine_id)
    snapshot = Path(result["snapshotDir"]).resolve()
    expected = (output / "machines" / machine_id).resolve()
    if snapshot != expected or not (snapshot / "manifest.json").is_file():
        raise ValueError(f"Invalid exported `snapshotDir`: '{snapshot}', expected '{expected}'")
    return ExportedMachine(machine_id, snapshot)


def import_machines(artifact: Path, home: Path, agent_dir: Path, input_dir: Path) -> None:
    """Atomically import via the public CLI, without knowing the cache schema.

    Parameters:
        artifact (Path): rendered standalone bundle.
        home (Path): clean CLI home.
        agent_dir (Path): viewer directory.
        input_dir (Path): shared export tree.
    """
    portable_command(artifact, home, ["import", "--agent-dir", str(agent_dir), "--input", str(input_dir)])


def seed_shared_stats(artifact: Path, root: Path, agent_dir: Path) -> tuple[ExportedMachine, ...]:
    """Seed local history and two independent machines, deduping their copied events.

    Local has 546 tokens; remote unique calls add 78. Combined All/5h/24h
    totals are 624/156/338. Both remote files copy the local calls, so a
    broken cross-machine fingerprint would inflate all three totals. Each new
    remote call has the same timestamp/model/counters as a local call but a
    distinct entry ID, so tuple-only dedup would incorrectly erase it.

    Parameters:
        artifact (Path): rendered standalone bundle.
        root (Path): scratch producer homes and shared data.
        agent_dir (Path): viewer's real local sessions directory.

    Returns:
        tuple[ExportedMachine, ...]: three independently enrolled installations.
    """
    now = datetime.now(UTC)
    entries = hourly_entries(now)
    write_history(agent_dir, entries)
    output = root / "shared"
    local = export_machine(artifact, root / "local-cli", agent_dir, output)
    machines = [local]
    for index in range(1, 3):
        home = root / f"work-{index}"
        source = home / ".pi" / "agent"
        extra = json.loads(entries[index - 1]) | {"id": f"remote-distinct-entry-{index}"}
        write_history(source, [*entries, compact(extra)])
        machines.append(export_machine(artifact, home, source, output))
    import_machines(artifact, root / "import-cli", agent_dir, output)
    return tuple(machines)
