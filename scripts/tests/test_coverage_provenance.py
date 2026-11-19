"""Exercise real producer receipts and the renderer's fail-closed artifact boundary.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_coverage_report import document, plan

import coverage_provenance as producer
import coverage_report as report

ROOT = Path(__file__).resolve().parents[2]
HOST = "ubuntu-24.04"
CELL = f"coverage-{HOST}"
WORKFLOW = "example/repo/.github/workflows/ci.yml@refs/pull/1/merge"
RUN = report.Provenance("example/repo", "a" * 40, "b" * 40, 123, 2, "pull_request", WORKFLOW)
RECORD: dict[str, object] = {
    "run_id": 123,
    "run_attempt": 2,
    "job": "owned",
    "cell": CELL,
    "tested_sha": "b" * 40,
    "pr_head_sha": "a" * 40,
    "event_name": "pull_request",
    "workflow_ref": WORKFLOW,
}


@pytest.mark.parametrize("zipped", [False, True])
@pytest.mark.parametrize(
    "data",
    [
        None,
        b"not JSON",
        b"{}",
        b" " * (report.MAX_PROVENANCE_BYTES + 1),
        json.dumps(RECORD | {"tested_sha": "a" * 40}).encode(),
        json.dumps(RECORD | {"pr_head_sha": "b" * 40}).encode(),
        json.dumps(RECORD | {"run_attempt": 1}).encode(),
        json.dumps(RECORD | {"run_attempt": 2.0}).encode(),
        json.dumps(RECORD | {"run_id": 124}).encode(),
        json.dumps(RECORD | {"job": "owned-shards"}).encode(),
        json.dumps(RECORD | {"cell": "coverage-wsl2"}).encode(),
        json.dumps(RECORD | {"event_name": "push"}).encode(),
        json.dumps(RECORD | {"workflow_ref": WORKFLOW + "-other"}).encode(),
    ],
)
def test_bad_provenance_is_unavailable(tmp_path: Path, zipped: bool, data: bytes | None) -> None:
    """Never show counts or a numeric badge for absent or disagreeing provenance.

    Parameters:
        tmp_path (Path): Artifact download directory.
        zipped (bool): Read a ZIP instead of an already-unpacked artifact.
        data (bytes | None): Malformed or missing sidecar.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({HOST: plan()}))
    summary = json.dumps(document())
    if zipped:
        with zipfile.ZipFile(tmp_path / f"{CELL}.zip", "w") as archive:
            archive.writestr("coverage/summary.json", summary)
            if data is not None:
                archive.writestr("coverage/provenance.json", data)
    else:
        directory = tmp_path / CELL / "coverage"
        directory.mkdir(parents=True)
        (directory / "summary.json").write_text(summary)
        if data is not None:
            (directory / "provenance.json").write_bytes(data)
    evidence = report.load_evidence(tmp_path, manifest, RUN)
    assert evidence[0].state == "unavailable"
    assert evidence[0].summary is None
    assert "provenance" in evidence[0].reason or "Cannot decode JSON" in evidence[0].reason
    assert "Ubuntu enforced signals: unavailable" in report.render_markdown(evidence, RUN)
    assert "Ubuntu enforced signals: unavailable" in report.render_badge(evidence[0])


def set_run_env(monkeypatch: pytest.MonkeyPatch, job: str) -> None:
    """Install a synthetic GitHub runtime identity for a producer process.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Environment fixture.
        job (str): Current job key.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    for key, value in {
        "GITHUB_REPOSITORY": "example/repo",
        "GITHUB_RUN_ID": "123",
        "GITHUB_RUN_ATTEMPT": "2",
        "GITHUB_EVENT_NAME": "pull_request",
        "GITHUB_WORKFLOW_REF": WORKFLOW,
        "GITHUB_JOB": job,
        "COVERAGE_PR_HEAD_SHA": "a" * 40,
    }.items():
        monkeypatch.setenv(key, value)


def test_producer_fan_in_refuses_old_and_missing_shards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Round-trip real producer output, then test a partial rerun and a legacy download.

    Parameters:
        tmp_path (Path): Download and producer output directory.
        monkeypatch (pytest.MonkeyPatch): Simulated producer environment.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    downloads = tmp_path / "downloads"
    shard = f"{CELL}-ts"
    shard_receipt = downloads / shard / "coverage/provenance-ts.json"
    set_run_env(monkeypatch, "owned-shards")
    assert producer.main(["--cell", shard, "--tested-sha", "b" * 40, "--output", str(shard_receipt)]) == 0
    set_run_env(monkeypatch, "owned")
    output = tmp_path / CELL / "coverage/provenance.json"
    args = ["--cell", CELL, "--tested-sha", "b" * 40, "--output", str(output), "--shards", str(downloads)]
    assert producer.main(args) == 0
    assert json.loads(output.read_text()) == RECORD
    (output.parent / "summary.json").write_text(json.dumps(document()))
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({HOST: plan()}))
    assert report.load_evidence(tmp_path, manifest, RUN)[0].state == "available"
    output.unlink()
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "3")
    assert producer.main(args) == 1
    assert not output.exists()
    shard_receipt.unlink()
    assert producer.main(args) == 1
    shard_receipt.parent.rmdir()
    shard_receipt.parent.parent.rmdir()
    assert producer.main(args) == 1


@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_non_pr_record_uses_null_pr_head(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, event: str) -> None:
    """A non-PR producer writes the tested checkout and no PR head.

    Parameters:
        tmp_path (Path): Output directory.
        monkeypatch (pytest.MonkeyPatch): Simulated producer environment.
        event (str): Non-PR event.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    set_run_env(monkeypatch, "owned")
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)
    workflow = "example/repo/.github/workflows/ci.yml@refs/heads/main"
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", workflow)
    output = tmp_path / "provenance.json"
    args = ["--cell", CELL, "--tested-sha", "b" * 40, "--output", str(output)]
    assert producer.main(args) == 1  # Reject an unexpected PR head on these events.
    monkeypatch.setenv("COVERAGE_PR_HEAD_SHA", "")
    assert producer.main(args) == 0
    assert json.loads(output.read_text()) == RECORD | {
        "pr_head_sha": None,
        "event_name": event,
        "workflow_ref": workflow,
    }
    monkeypatch.delenv("GITHUB_JOB")
    assert producer.main(args) == 1


def test_zip_cannot_take_provenance_from_unpacked_artifact(tmp_path: Path) -> None:
    """A neighboring receipt never authenticates a ZIP lacking its own record.

    Parameters:
        tmp_path (Path): Download directory.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    sidecar = tmp_path / CELL / "coverage/provenance.json"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text(json.dumps(RECORD))
    archive = tmp_path / f"{CELL}.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("coverage/summary.json", json.dumps(document()))
    with pytest.raises(ValueError, match="Missing coverage provenance"):
        report.read_summary(archive, RECORD)
    with zipfile.ZipFile(archive, "a") as zipped:
        zipped.writestr("coverage/provenance.json", json.dumps(RECORD))
    assert report.read_summary(archive, RECORD) == document()
    assert report.read_summary(archive) == document()


@pytest.mark.parametrize(
    ("event", "host", "state"),
    [
        ("pull_request", "macos-14", "unavailable"),
        ("push", "wsl2", "unavailable"),
        ("workflow_dispatch", "macos-14", "available"),
    ],
)
def test_only_current_producer_cells_are_eligible(tmp_path: Path, event: str, host: str, state: str) -> None:
    """Accept receipts only for cells that really run on the event.

    Parameters:
        tmp_path (Path): Artifact download directory.
        event (str): GitHub workflow event.
        host (str): Fan-in host declared by the plan.
        state (str): Expected evidence state.
    Returns:
        None: The event and host contract is satisfied.
    Raises:
        AssertionError: The renderer accepts evidence from an unavailable producer or rejects a live one.
    """
    run = (
        RUN
        if event == "pull_request"
        else report.Provenance(
            RUN.repository,
            None,
            RUN.tested_sha,
            RUN.run_id,
            RUN.attempt,
            event,
            "example/repo/.github/workflows/ci.yml@refs/heads/main",
        )
    )
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({host: plan()}))
    cell = f"coverage-{host}"
    summary = document()
    if host == "macos-14":
        summary["os"] = "darwin"
        for row in summary["files"]:
            row["os"] = "darwin"
    with zipfile.ZipFile(tmp_path / f"{cell}.zip", "w") as archive:
        archive.writestr("coverage/summary.json", json.dumps(summary))
        archive.writestr("coverage/provenance.json", json.dumps(run.record("owned", cell)))
    evidence = report.load_evidence(tmp_path, manifest, run)[0]
    assert evidence.state == state, evidence.reason
    if state == "unavailable":
        assert evidence.reason == "No coverage producer for this host and event"


@pytest.mark.parametrize("link", [CELL, "coverage", "provenance.json"])
def test_unpacked_provenance_must_stay_in_its_artifact(tmp_path: Path, link: str) -> None:
    """Reject receipts aliased from another unpacked artifact.

    Parameters:
        tmp_path (Path): Artifact download directory.
        link (str): Artifact component replaced with a symlink.
    Returns:
        None: The aliased receipt is rejected.
    Raises:
        AssertionError: The renderer accepts evidence through a symlink.
    """
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({HOST: plan()}))
    coverage = tmp_path / CELL / "coverage"
    coverage.mkdir(parents=True)
    (coverage / "summary.json").write_text(json.dumps(document()))
    (coverage / "provenance.json").write_text(json.dumps(RECORD))
    link_path = {CELL: coverage.parent, "coverage": coverage, "provenance.json": coverage / link}[link]
    target = link_path.rename(tmp_path / "elsewhere")
    link_path.symlink_to(target)
    assert report.load_evidence(tmp_path, manifest, RUN)[0].state == "unavailable"


def test_producer_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the workflow's entry point with distinct tested and PR head commits.

    Parameters:
        tmp_path (Path): Artifact directory.
        monkeypatch (pytest.MonkeyPatch): Simulated producer environment.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    set_run_env(monkeypatch, "owned")
    output = tmp_path / "provenance.json"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/coverage_provenance.py"),
            "--tested-sha",
            "b" * 40,
            "--cell",
            CELL,
            "--output",
            str(output),
        ],
        check=True,
    )
    assert json.loads(output.read_text()) == RECORD


def test_ci_wires_receipts_to_existing_uploads() -> None:
    """Keep each producer's receipt beside the report, not in a separate artifact.

    Parameters:
        None.
    Returns:
        None: The boundary contract is satisfied.
    Raises:
        AssertionError: The boundary contract regresses.
    """
    jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
    for job, kind, cell, receipt in (
        ("owned", "fan-in", "coverage-${{ matrix.os }}", "coverage/provenance.json"),
        (
            "owned-shards",
            "shard",
            "coverage-${{ matrix.os }}-${{ matrix.shard }}",
            "coverage/provenance-${{ matrix.shard }}.json",
        ),
        (
            "owned-shards",
            "Swift",
            "computer-use-swift-${{ matrix.os }}",
            "packages/computer-use/coverage/swift/",
        ),
        (
            "computer-use-windows",
            "Windows native",
            "computer-use-rust-windows-x64",
            "packages/computer-use/coverage/native-windows/provenance.json",
        ),
    ):
        steps = jobs[job]["steps"]
        writer = next(step for step in steps if step.get("name") == f"Record {kind} coverage provenance")
        upload = steps[steps.index(writer) + 1]
        assert upload["with"]["name"] == cell
        assert receipt in upload["with"]["path"].splitlines()
        assert "git rev-parse HEAD" in writer["run"]
        assert writer["env"]["COVERAGE_PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
        assert writer["continue-on-error"] is True
        if kind == "fan-in":
            assert '--shards "$RUNNER_TEMP/shard-coverage"' in writer["run"]
