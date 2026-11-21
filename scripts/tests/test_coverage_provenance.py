"""Exercise real producer receipts and the renderer's fail-closed artifact boundary.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml
from coverage_report_fixtures import document, plan

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_provenance as producer
import coverage_report as report
from coverage_provenance_record import (
    COVERAGE_HOSTS,
    MAX_PROVENANCE_BYTES,
    SEMANTICS_FIELD,
    Provenance,
    ProvenanceRecord,
    producer_job,
    producer_job_for_cell,
)

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "tests/integration"))
from harness.git_fixture import git as fixture_git
from harness.git_fixture import git_env

HOST = "ubuntu-24.04"
CELL = f"coverage-{HOST}"
WORKFLOW = "example/repo/.github/workflows/ci.yml@refs/pull/1/merge"
RUN = Provenance("example/repo", "a" * 40, "b" * 40, 123, 2, "pull_request", WORKFLOW)
RECORD: ProvenanceRecord = {
    "run_id": 123,
    "run_attempt": 2,
    "job": "owned-ubuntu",
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
        b" " * (MAX_PROVENANCE_BYTES + 1),
        json.dumps(RECORD | {"tested_sha": "a" * 40}).encode(),
        json.dumps(RECORD | {"pr_head_sha": "b" * 40}).encode(),
        json.dumps(RECORD | {"run_attempt": 1}).encode(),
        json.dumps(RECORD | {"run_attempt": 2.0}).encode(),
        json.dumps(RECORD | {"run_id": 124}).encode(),
        json.dumps(RECORD | {"job": "owned-shards-ubuntu"}).encode(),
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
    monkeypatch.setattr(producer, "checkout_sha", lambda: RUN.tested_sha)
    downloads = tmp_path / "downloads"
    shard = f"{CELL}-ts"
    shard_receipt = downloads / shard / "coverage/provenance-ts.json"
    set_run_env(monkeypatch, "owned-shards-ubuntu")
    assert producer.main(["--cell", shard, "--output", str(shard_receipt)]) == 0
    set_run_env(monkeypatch, "owned-ubuntu")
    output = tmp_path / CELL / "coverage/provenance.json"
    args = ["--cell", CELL, "--output", str(output), "--shards", str(downloads)]
    assert producer.main(args) == 0
    assert json.loads(output.read_text()) == RECORD
    (output.parent / "summary.json").write_text(json.dumps(document()))
    manifest = tmp_path / "plan.json"
    manifest.write_text(json.dumps({HOST: plan()}))
    assert report.load_evidence(tmp_path, manifest, RUN)[0].state == "available"
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
    monkeypatch.setattr(producer, "checkout_sha", lambda: RUN.tested_sha)
    set_run_env(monkeypatch, "owned-ubuntu")
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)
    workflow = "example/repo/.github/workflows/ci.yml@refs/heads/main"
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", workflow)
    output = tmp_path / "provenance.json"
    args = ["--cell", CELL, "--output", str(output)]
    assert producer.main(args) == 1  # Reject an unexpected PR head on these events.
    monkeypatch.setenv("COVERAGE_PR_HEAD_SHA", "")
    assert producer.main(args) == 0
    assert json.loads(output.read_text()) == RECORD | {
        "pr_head_sha": None,
        "event_name": event,
        "workflow_ref": workflow,
    }
    run = Provenance("example/repo", None, RUN.tested_sha, 123, 2, event, workflow)
    rendered = report.render_markdown((), run)
    assert f"head: n/a; tested: {RUN.tested_sha};" in rendered
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
        else Provenance(
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
        job = producer_job(host, shard=False) if host in COVERAGE_HOSTS else "owned-ubuntu"
        archive.writestr("coverage/provenance.json", json.dumps(run.record(job, cell)))
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


@pytest.mark.parametrize("from_hook", [False, True], ids=["clean", "git-hook"])
def test_producer_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, from_hook: bool) -> None:
    """Stamp the actual checkout despite Git warnings and a caller's hook environment.

    Parameters:
        tmp_path (Path): Parent of the caller and producer checkouts.
        monkeypatch (pytest.MonkeyPatch): Simulated producer environment.
        from_hook (bool): Inherit Git hook variables pointing at the caller.
    Returns:
        None: Only the producer checkout supplies the tested SHA.
    Raises:
        AssertionError: A checkout is misidentified or the caller's refs change.
    """
    set_run_env(monkeypatch, "owned-ubuntu")
    monkeypatch.setenv("GITHUB_SHA", "c" * 40)
    monkeypatch.setenv("LC_ALL", "C")
    caller = tmp_path / "caller"
    caller.mkdir()
    fixture_git(caller, "-c", "init.templateDir=", "init", "--quiet")
    no_hooks = f"core.hooksPath={os.devnull}"
    fixture_git(caller, "-c", no_hooks, "commit", "--quiet", "--allow-empty", "-m", "Caller commit")
    caller_sha = fixture_git(caller, "rev-parse", "HEAD").strip()
    caller_refs = fixture_git(caller, "show-ref", "--heads")
    if from_hook:
        monkeypatch.setenv("GIT_DIR", str(caller / ".git"))
        monkeypatch.setenv("GIT_INDEX_FILE", str(caller / ".git/index"))
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "caller.gitconfig"))

    checkout = tmp_path / "checkout"
    checkout.mkdir()
    fixture_git(checkout, "-c", "init.templateDir=", "init", "--quiet")
    cfg = checkout / "vitest.config.ts"
    cfg.write_text("export default { test: { coverage: { provider: 'v8' } } }\n")
    fixture_git(checkout, "add", cfg.name)
    fixture_git(checkout, "-c", no_hooks, "commit", "--quiet", "-m", "Producer commit")
    tested_sha = fixture_git(checkout, "rev-parse", "HEAD").strip()
    fixture_git(checkout, "update-ref", "refs/heads/HEAD", tested_sha)
    fixture_git(checkout, "config", "core.warnAmbiguousRefs", "true")
    assert fixture_git(caller, "show-ref", "--heads") == caller_refs
    assert tested_sha not in {caller_sha, RUN.head_sha, "c" * 40}
    output = checkout / "provenance.json"
    env = git_env()
    assert env["GIT_CONFIG_GLOBAL"] == os.devnull
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    summary = checkout / "summary.json"
    summary.write_text('{"packages":{}}\n')
    cmd = [
        sys.executable,
        str(ROOT / "scripts/coverage_provenance.py"),
        "--cell",
        CELL,
        "--output",
        str(output),
        "--summary",
        str(summary),
    ]
    stamped = []
    for name, content in [("src.ts", "first"), ("src.ts", "second"), (cfg.name, "other provider")]:
        (checkout / name).write_text(content)
        fixture_git(checkout, "add", name)
        fixture_git(checkout, "-c", no_hooks, "commit", "--quiet", "-m", "Change input")
        tested_sha = fixture_git(checkout, "-c", "core.warnAmbiguousRefs=false", "rev-parse", "HEAD").strip()
        result = subprocess.run(
            cmd, cwd=checkout, env=env, capture_output=True, text=True, check=False, timeout=30
        )
        assert result.returncode == 0, result.stderr
        assert "refname 'HEAD' is ambiguous" in result.stderr
        payload = json.loads(summary.read_text())
        fingerprint = payload[producer.SEMANTICS_FIELD]
        assert payload == {"packages": {}, producer.SEMANTICS_FIELD: fingerprint}
        assert json.loads(output.read_text()) == RECORD | {
            "tested_sha": tested_sha,
            producer.SEMANTICS_FIELD: fingerprint,
        }
        stamped.append(fingerprint)
    assert stamped[0] == stamped[1] != stamped[2]
    assert fixture_git(caller, "rev-parse", "HEAD").strip() == caller_sha
    assert fixture_git(caller, "show-ref", "--heads") == caller_refs


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        ("git-missing", "Cannot locate `git`"),
        ("git-failed", "Cannot resolve checkout `HEAD`: Git exited with code 128"),
        ("non-sha", "Expected a single 40-character checkout SHA on Git stdout"),
        ("extra-line", "Expected a single 40-character checkout SHA on Git stdout"),
        ("unknown-job", "Unknown coverage producer job"),
    ],
)
def test_invalid_checkout_or_job_does_not_leave_a_sidecar(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
    message: str,
) -> None:
    """Do not retain earlier provenance when the producer cannot record its own identity.

    Parameters:
        tmp_path (Path): Isolated producer workspace.
        monkeypatch (pytest.MonkeyPatch): Simulated producer environment.
        caplog (pytest.LogCaptureFixture): Captured producer diagnostics.
        failure (str): Invalid checkout or job identity.
        message (str): Expected failure message.
    Returns:
        None: No stale sidecar survives a failed write.
    Raises:
        AssertionError: The producer accepts invalid identity or leaves an old sidecar.
    """
    set_run_env(monkeypatch, "owned-ubuntu")
    monkeypatch.setattr(producer.shutil, "which", lambda _: None if failure == "git-missing" else "/git")
    if failure == "git-failed":
        response = Mock(side_effect=subprocess.CalledProcessError(128, "git", output=RUN.tested_sha))
    else:
        response = Mock(
            return_value={"non-sha": "not a sha\n", "extra-line": f"{RUN.tested_sha}\n\n"}.get(
                failure, f"{RUN.tested_sha}\n"
            )
        )
    monkeypatch.setattr(producer.subprocess, "check_output", response)
    if failure == "unknown-job":
        monkeypatch.setenv("GITHUB_JOB", "not-a-coverage-producer")
    output = tmp_path / "provenance.json"
    output.write_text(json.dumps(RECORD))
    assert producer.main(["--cell", CELL, "--output", str(output)]) == 1
    assert not output.exists()
    assert message in caplog.text


@pytest.mark.parametrize(
    "path",
    [
        ".node-version",
        ".bun-version",
        ".python-version",
        ".npmrc",
        ".github/actions/setup/action.yml",
        ".github/workflows/ci.yml",
        "coverage/policy.json",
        "scripts/run-vitest.ts",
        "scripts/.coveragerc",
        "scripts/setup.cfg",
        "scripts/tox.ini",
        "scripts/pyproject.toml",
        "release/.coveragerc",
        "release/setup.cfg",
        "release/tox.ini",
        "release/pyproject.toml",
        "tests/integration/.coveragerc",
        "tests/integration/setup.cfg",
        "tests/integration/tox.ini",
        "tests/integration/pyproject.toml",
        "tests/integration/uv.lock",
        "tests/integration/probes/vitest.config.ts",
        "packages/subagents/vitest.workflow-examples.config.ts",
        "packages/session-kit/tests/fixtures/monitor/worker-death.vitest.config.ts",
        "packages/subagents/vite.config.ts",
        "packages/subagents/istanbul.config.js",
        "packages/subagents/nyc.config.js",
        "packages/subagents/tsconfig.json",
        "tsconfig.base.json",
        "tests/lib/src/home-setup.ts",
        "tests/lib/src/home-guard.ts",
        "tests/lib/src/sandbox.ts",
        "packages/plan-mode/tests/fixtures/vitest.global-setup.ts",
        "packages/plan-mode/tests/fixtures/vitest.setup.ts",
        "packages/plan-mode/tests/fixtures/vitest.runner.ts",
        "packages/plan-mode/tests/fixtures/test-timeout-policy.ts",
        "packages/todo/tests/fixtures/setup.ts",
        "packages/subagents/tests/fixtures/tmp-root-setup.ts",
        "packages/subagents/tests/workflow/workflow-examples.test.ts",
        "packages/subagents/src/workflow/runtime.ts",
        "packages/subagents/src/workflow/worker-source.ts",
        "package-lock.json",
        "packages/computer-use/Makefile",
        "packages/computer-use/scripts/swift-coverage.mjs",
        "packages/computer-use/scripts/rust-coverage.mjs",
        "packages/computer-use/native/Bridge.xcconfig",
        "packages/computer-use/native/Package.swift",
        "packages/computer-use/native/Package.resolved",
        "packages/computer-use/native/.swiftpm/settings.json",
        "packages/computer-use/native/linux/bridge-rs/Cargo.toml",
        "packages/computer-use/native/linux/bridge-rs/Cargo.lock",
        "packages/computer-use/native/linux/bridge-rs/build.rs",
        "packages/computer-use/native/linux/bridge-rs/.cargo/settings.toml",
        "rust-toolchain.toml",
    ],
)
def test_each_instrumentation_input_suppresses_delta(path: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Change exactly one Git tree entry and require incompatible measured-main deltas.

    Parameters:
        path (str): A committed producer input or discoverable configuration path.
        monkeypatch (pytest.MonkeyPatch): Scoped Git tree response.
    Returns:
        None.
    Raises:
        AssertionError: Changing the input did not suppress the delta.
    """
    fixed = b"100644 blob 1111\tMakefile\0"
    entry = b"\t" + path.encode() + b"\0"
    tree = Mock(side_effect=[fixed + b"100644 blob 2222" + entry, fixed + b"100644 blob 3333" + entry])
    monkeypatch.setattr(producer.subprocess, "check_output", tree)
    before = producer.semantics_fingerprint(RUN.tested_sha)
    after = producer.semantics_fingerprint(RUN.tested_sha)
    assert before != after
    manifest = plan()
    signals = tuple(report.Signal.parse(name, value) for name, value in manifest["signals"].items())
    baseline = report.Evidence(
        HOST, "available", signals, report.Summary.parse(document() | {SEMANTICS_FIELD: before})
    )
    current = report.Evidence(
        HOST, "available", signals, report.Summary.parse(document() | {SEMANTICS_FIELD: after})
    )
    assert (
        report.measured_delta(current, baseline, signals[0])
        == "not comparable: instrumentation fingerprints differ"
    )


@pytest.mark.parametrize("package", ["todo", "session-kit", "subagents"])
def test_application_config_preserves_fingerprint(package: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Do not treat an application file named `config.ts` as coverage configuration.

    Parameters:
        package (str): Package whose application configuration changes.
        monkeypatch (pytest.MonkeyPatch): Scoped Git tree response.
    Returns:
        None.
    Raises:
        AssertionError: The application edit changed the instrumentation fingerprint.
    """
    fixed = b"100644 blob 1111\tMakefile\0"
    entry = f"\tpackages/{package}/src/config.ts\0".encode()
    tree = Mock(side_effect=[fixed + b"100644 blob 2222" + entry, fixed + b"100644 blob 3333" + entry])
    monkeypatch.setattr(producer.subprocess, "check_output", tree)
    assert producer.semantics_fingerprint(RUN.tested_sha) == producer.semantics_fingerprint(RUN.tested_sha)


@pytest.mark.parametrize("failure", ["no-git", "git-failed", "no-inputs"])
def test_unavailable_fingerprint(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    """Do not generate a compatibility fingerprint without instrumentation evidence.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Scoped subprocess overrides.
        failure (str): Missing instrumentation case.
    Returns:
        None.
    Raises:
        AssertionError: Invalid evidence generated a stamp.
    """
    monkeypatch.setattr(producer.shutil, "which", lambda _: None if failure == "no-git" else "/git")
    git = Mock(return_value=b"100644 blob deadbeef\tscripts/tests/fixture.py\0")
    if failure == "git-failed":
        git.side_effect = subprocess.TimeoutExpired("git", 30)
    monkeypatch.setattr(producer.subprocess, "check_output", git)
    with pytest.raises(
        (FileNotFoundError, ValueError), match=r"locate `git`|coverage instrumentation inputs"
    ):
        producer.semantics_fingerprint(RUN.tested_sha)


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
        ("owned-ubuntu", "fan-in", "coverage-${{ matrix.os }}", "coverage/provenance.json"),
        ("owned-macos", "fan-in", "coverage-${{ matrix.os }}", "coverage/provenance.json"),
        (
            "owned-shards-ubuntu",
            "shard",
            "coverage-${{ matrix.os }}-${{ matrix.shard }}",
            "coverage/provenance-${{ matrix.shard }}.json",
        ),
        (
            "owned-shards-macos",
            "shard",
            "coverage-${{ matrix.os }}-${{ matrix.shard }}",
            "coverage/provenance-${{ matrix.shard }}.json",
        ),
    ):
        steps = jobs[job]["steps"]
        writer = next(step for step in steps if step.get("name") == f"Record {kind} coverage provenance")
        upload = steps[steps.index(writer) + 1]
        assert upload["with"]["name"] == cell
        assert receipt in upload["with"]["path"].splitlines()
        assert "python3 scripts/coverage_provenance.py --cell" in writer["run"]
        assert "--tested-sha" not in writer["run"]
        assert "git rev-parse" not in writer["run"]
        assert writer["env"]["COVERAGE_PR_HEAD_SHA"] == "${{ github.event.pull_request.head.sha }}"
        assert writer["continue-on-error"] is True
        if kind == "fan-in":
            assert '--shards "$RUNNER_TEMP/shard-coverage"' in writer["run"]


@pytest.mark.parametrize("job", ["owned-shards-ubuntu", "owned-shards-macos"])
def test_swift_artifact_retains_reports_without_stamp(job: str) -> None:
    """Keep native evidence without producing a sidecar no renderer reads.

    Parameters:
        job (str): Job holding the Swift report upload.
    Returns:
        None: The Swift upload remains and no stamp is written.
    Raises:
        AssertionError: The upload changes or a producer stamp returns.
    """
    steps = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"][job]["steps"]
    upload = next(step for step in steps if step.get("name") == "Preserve real-source Swift coverage")
    assert upload["with"]["name"] == "computer-use-swift-${{ matrix.os }}"
    assert upload["with"]["path"] == "packages/computer-use/coverage/swift/"
    assert all("coverage/swift/provenance.json" not in step.get("run", "") for step in steps)
    assert all(step.get("name") != "Record Swift coverage provenance" for step in steps)


@pytest.mark.parametrize("host", ["ubuntu-24.04", "macos-14"])
def test_expected_producer_jobs_exist_in_the_workflow(host: str) -> None:
    """Pin the job ids the verifier and renderer expect to the real workflow job keys.

    Parameters:
        host (str): Coverage host whose producer jobs are checked.
    Returns:
        None: Both the fan-in and the shard job exist.
    Raises:
        AssertionError: The workflow renamed a job without the provenance code following it.
    """
    jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
    assert producer_job(host, shard=False) in jobs
    assert producer_job(host, shard=True) in jobs


def test_producer_job_for_cell_lookup() -> None:
    """Resolve only artifact hosts with a known producer job.

    Parameters:
        None.
    Returns:
        None: Both known jobs resolve and unknown hosts raise `KeyError`.
    Raises:
        AssertionError: A job is misidentified or an unknown host is accepted.
    """
    assert producer_job_for_cell("coverage-ubuntu-24.04", shard=False) == "owned-ubuntu"
    assert producer_job_for_cell("coverage-macos-14", shard=True) == "owned-shards-macos"
    with pytest.raises(KeyError, match="wsl2"):
        producer_job_for_cell("coverage-wsl2", shard=False)
