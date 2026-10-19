"""Attack portable-stats contract inspections without executing the artifact matrix.

References:
    https://github.com/nredd/pi-harness/blob/main/docs/package-contracts.md
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import package_contracts as pc

MACHINE = "12345678-1234-4567-8901-123456789abc"
OTHER = "87654321-1234-4567-8901-123456789abc"
STAMP = 1_790_000_001_000


def snapshot(directory: Path, mutation: str = "", machine_id: str = MACHINE) -> dict[str, object]:
    """Write a content-addressed usage-only fixture, optionally violating one boundary.

    Parameters:
        directory (Path): Machine directory.
        mutation (str): Deliberate contract violation.
        machine_id (str): Exported installation UUID.

    Returns:
        dict[str, object]: Manifest and shards in importer-cache shape.
    """
    event = {
        "id": "a" * 64,
        "entryId": "entry",
        "sessionId": "b" * 64,
        "ms": STAMP,
        "provider": "local",
        "model": "m",
        "input": 5,
        "output": 2,
        "cacheRead": 0,
        "cacheWrite": 0,
        "cost": 0.01,
    }
    if mutation == "private-field":
        event["content"] = pc.STATS_PRIVATE_SENTINEL
    if mutation == "sentinel":
        event["model"] = pc.STATS_PRIVATE_SENTINEL
    shard = {"version": 1, "machineId": machine_id, "month": "2026-09", "events": [event], "sessions": []}
    if mutation == "empty":
        shard["events"] = []
    if mutation == "header":
        shard["machineId"] = OTHER
    data = json.dumps(shard).encode()
    sha = hashlib.sha256(data).hexdigest()
    filename = f"2026-09-{sha}.json"
    manifest = {
        "version": 1,
        "machineId": machine_id,
        "label": "Pi machine",
        "exportedAt": STAMP,
        "shards": [{"month": "2026-09", "file": filename, "sha256": sha, "bytes": len(data)}],
    }
    directory.mkdir(parents=True, exist_ok=True)
    if mutation == "extra-file":
        (directory / "private.txt").write_text(pc.STATS_PRIVATE_SENTINEL)
    (directory / "manifest.json").write_text(json.dumps(manifest))
    if mutation != "missing":
        (directory / filename).write_bytes(data + (b" " if mutation == "digest" else b""))
    return {"manifest": manifest, "shards": [shard]}


@pytest.mark.parametrize(
    "mutation", ["private-field", "sentinel", "extra-file", "empty", "header", "digest", "missing"]
)
def test_snapshot_inspection_rejects_corrupt_or_private_months(tmp_path: Path, mutation: str) -> None:
    """Reject malformed month bytes even when a CLI claims successful export.

    Parameters:
        tmp_path (Path): Fixture root.
        mutation (str): Invalid month condition.
    """
    snapshot(tmp_path, mutation)
    with pytest.raises(pc.ContractError):
        pc.inspect_stats_snapshot(tmp_path, MACHINE, [pc.STATS_PRIVATE_SENTINEL])


def artifact_runner(mutation: str, calls: list[str]) -> Callable[..., subprocess.CompletedProcess[str]]:
    """Build an explicit external-command double with state shared across repeated operations.

    Parameters:
        mutation (str): Export/import violation to inject.
        calls (list[str]): Recorded operation order.

    Returns:
        Callable[..., subprocess.CompletedProcess[str]]: Controlled process boundary.
    """
    exported: dict[str, object] = {}

    def run(
        cmd: Sequence[str | Path],
        *,
        env: dict[str, str],
        cwd: Path,
        timeout: int,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        """Record clean argv/env and materialize the files the contract actually inspects.

        Parameters:
            cmd (Sequence[str | Path]): Absolute Node plus copied bundle and arguments.
            env (dict[str, str]): Explicit credential-free child environment.
            cwd (Path): Unrelated working directory.
            timeout (int): Bounded process deadline.
            check (bool): False only for the rejected-flag probe.

        Returns:
            subprocess.CompletedProcess[str]: Protocol result from the controlled boundary.
        """
        nonlocal exported
        argv = [str(part) for part in cmd]
        assert set(env) == {"HOME", "PATH", "TZ"}
        assert env["PATH"] == os.defpath
        assert cwd.name == "artifact-cwd"
        assert timeout == pc.PI_TIMEOUT_S
        assert Path(argv[1]).read_bytes() == b"packed bytes"
        operation = argv[2]
        calls.append(operation)
        if "--bogus" in argv:
            assert not check
            return subprocess.CompletedProcess(argv, 0 if mutation == "unknown-flag" else 1, "", "bad flag")
        agent = Path(argv[argv.index("--agent-dir") + 1])
        home = Path(env["HOME"])
        assert agent == home / ".pi" / "agent"
        if mutation == "credentials":
            (agent / "auth.json").write_text("{}")
        if mutation == "modules":
            (home / "node_modules").mkdir(exist_ok=True)
        if operation == "export":
            history = next(agent.rglob("*.jsonl")).read_text()
            assert pc.STATS_PRIVATE_SENTINEL in history
            assert "--private-source-path--" in history
            output = Path(argv[argv.index("--output") + 1])
            mid = OTHER if mutation == "uuid" and calls.count("export") == 2 else MACHINE
            exported = snapshot(output / "machines" / mid, machine_id=mid)
            result = {"machineId": mid, "snapshotDir": str(output / "machines" / mid)}
        else:
            if mutation != "no-cache":
                directory = agent / "pi-session-kit"
                directory.mkdir(exist_ok=True)
                machine = json.loads(json.dumps(exported))
                if mutation == "duplicate" and calls.count("import") == 2:
                    machine["shards"] *= 2
                (directory / "stats-global.json").write_text(json.dumps({"machines": {MACHINE: machine}}))
            result = {"imported": 1, "retained": 0, "problems": [], "importedAt": STAMP}
        return subprocess.CompletedProcess(argv, 0, json.dumps(result), "")

    return run


@pytest.mark.parametrize(
    "mutation", ["", "uuid", "duplicate", "no-cache", "credentials", "modules", "unknown-flag"]
)
def test_artifact_matrix_uses_clean_homes_and_rejects_false_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    """Drive repeated commands with an explicit process double, never the real CLI matrix.

    Parameters:
        tmp_path (Path): Isolated histories and homes.
        monkeypatch (pytest.MonkeyPatch): Replace only the external command boundary.
        mutation (str): Violation injected by the fake exporter/importer.
    """
    source = tmp_path / "source" / "sessions"
    source.mkdir(parents=True)
    (source / "s.jsonl").write_text(json.dumps({"type": "session", "id": "s"}) + "\n")
    calls: list[str] = []
    monkeypatch.setattr(pc, "run", artifact_runner(mutation, calls))
    if mutation:
        with pytest.raises(pc.ContractError):
            pc.exercise_stats_artifact(Path("/node"), b"packed bytes", source.parent, tmp_path / "work")
    else:
        manifest = pc.exercise_stats_artifact(
            Path("/node"), b"packed bytes", source.parent, tmp_path / "work"
        )
        assert manifest.machineId == MACHINE
        assert calls == ["export", "export", "import", "import", "export"]
