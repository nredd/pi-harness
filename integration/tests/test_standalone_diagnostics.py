"""Failure-only standalone evidence with an explicit, credential-scanned file boundary.

References:
- https://github.com/nredd/pi-harness/pull/178
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
import yaml

from harness import standalone_diagnostics as diag
from harness.sandbox import build_sandbox


@pytest.fixture
def inputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Create only public build inputs, including deliberately forbidden sibling files."""
    binary = tmp_path / "build/linux-x64/pi"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"exact compiled executable")
    core = tmp_path / "core"
    core.mkdir()
    (core / "package-lock.json").write_text("{}")
    evidence = tmp_path / "build-evidence"
    evidence.mkdir()
    (evidence / "compile-command.json").write_text('["bun", "build", "--compile"]')
    (evidence / "module-graph.json").write_text('{"inputs": {}}')
    (evidence / "auth.json").write_text("DO NOT COPY")
    (binary.parent / ".storage").mkdir()
    (binary.parent / ".storage/token").write_text("DO NOT COPY")
    return binary, core, evidence


def test_success_captures_nothing(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A successful startup creates no artifact, replay or binary copy."""
    box = build_sandbox(tmp_path / "sandbox")
    calls: list[list[str]] = []

    def execute(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "STACK-OK\n", "")

    monkeypatch.setattr(diag, "execute", execute)
    output = tmp_path / "artifacts"
    assert diag.diagnose(box, *inputs, output) == 0
    assert not output.exists()
    assert len(calls) == 1


def test_failure_preserves_original_status_and_allowlist(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Capture exact bytes and correlated code, never installed homes or arbitrary caches."""
    binary, core, evidence = inputs
    box = build_sandbox(tmp_path / "sandbox")
    memory = box.agent_dir / "npm/node_modules/pi-memory"
    memory.mkdir(parents=True)
    source = memory / "index.ts"
    source.write_text("export default function() { throw new Error('Type3 is not defined'); }")
    (memory / "package.json").write_text('{"name":"pi-memory","version":"0.4.2"}')
    (memory / "auth.json").write_text("DO NOT COPY")
    (box.agent_dir / "npm/package-lock.json").write_text(
        json.dumps(
            {
                "packages": {
                    "node_modules/pi-memory": {"version": "0.4.2", "integrity": "sha512-public"},
                    "unrelated": {"token": "DO NOT COPY"},
                }
            }
        )
    )
    box.patch_json("settings.json", {"packages": ["npm:pi-memory@0.4.2"]})
    cache = box.root / "tmp/jiti"
    cache.mkdir()
    name = diag.cache_names(source)[0]
    (cache / name).write_text("throw new ReferenceError('Type3 is not defined');")
    (cache / "pi-memory-index.unrelated.mjs").write_text("DO NOT COPY")
    (box.home / "live-token-store").write_text("DO NOT COPY")
    calls: list[list[str]] = []

    def execute(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        if len(calls) == 1:
            return subprocess.CompletedProcess(argv, 23, "", "ORIGINAL Type3 is not defined\n")
        return subprocess.CompletedProcess(
            argv, 0, "STACK-OK\n", "ReferenceError: Type3 is not defined\n at original.ts:4:2\n"
        )

    monkeypatch.setattr(diag, "execute", execute)
    monkeypatch.setattr(diag, "build_metadata", lambda *_: {"core_sha": "f" * 40})
    output = tmp_path / "artifacts"
    assert diag.diagnose(box, binary, core, evidence, output) == 23
    assert len(calls) == 2  # The diagnostic replay cannot turn the first failure green.
    assert (output / "pi").read_bytes() == binary.read_bytes()
    assert (output / "startup.stderr").read_text() == "ORIGINAL Type3 is not defined\n"
    assert "at original.ts:4:2" in (output / "replay.stderr").read_text()
    assert (output / "packages/pi-memory/index.ts").read_bytes() == source.read_bytes()
    assert (output / "jiti/primary" / name).is_file()
    identity = json.loads((output / "packages/pi-memory/npm-lock.json").read_text())
    assert identity == {"version": "0.4.2", "integrity": "sha512-public"}
    assert not any(b"DO NOT COPY" in p.read_bytes() for p in output.rglob("*") if p.is_file())
    sums = (output / "SHA256SUMS").read_text()
    assert f"{hashlib.sha256(binary.read_bytes()).hexdigest()}  pi\n" in sums
    assert all(diag.allowed_artifact_path(p.relative_to(output)) for p in output.rglob("*") if p.is_file())
    wrapper = (output / "replay-wrapper.ts").read_text()
    assert "error.stack" in wrapper
    assert "throw error" in wrapper
    report = json.loads((output / "build.json").read_text())
    assert report["startup_returncode"] == 23
    assert report["replay_returncode"] == 0
    manifest = json.loads((memory / "package.json").read_text())
    assert manifest["pi"]["extensions"] == ["./diagnostic-wrapper.ts"]
    assert box.settings()["packages"][0]["extensions"] == ["diagnostic-wrapper.ts"]


@pytest.mark.parametrize(
    "name",
    [
        "auth.json",
        ".storage/token",
        "jiti/primary/auth.json",
        "../pi",
        "/pi",
        "packages/pi-memory/secrets.ts",
    ],
)
def test_unknown_artifact_paths_are_denied(name: str) -> None:
    """The artifact is a closed allowlist, not a recursive home upload."""
    assert not diag.allowed_artifact_path(Path(name))


@pytest.mark.parametrize(
    "name",
    ["pi", "startup.stderr", "packages/pi-memory/index.ts", "jiti/primary/pi-memory-index.01234567.mjs"],
)
def test_credential_scan_refuses_entire_publication(tmp_path: Path, name: str) -> None:
    """Even an allowlisted file cannot publish token-like contents, including binary bytes."""
    output = tmp_path / "artifacts"
    with pytest.raises(ValueError, match="credential"):
        diag.publish({name: b"prefix ghp_" + b"a" * 36 + b" suffix"}, output)
    assert not output.exists()


def test_symlink_cache_is_not_read(tmp_path: Path) -> None:
    """An exact cache filename must not escape to an unrelated token store through a symlink."""
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "auth.json").write_text("secret")
    (root / "source.mjs").symlink_to(tmp_path / "auth.json")
    with pytest.raises(ValueError, match="symlink"):
        diag.read_regular(root / "source.mjs", root)


def test_prepare_build_wrapper_forwards_without_env_dump(tmp_path: Path) -> None:
    """The wrapper adds only a metafile flag to compile calls and records the exact argv."""
    bun = tmp_path / "bun-real"
    bun.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
    bun.chmod(0o755)
    evidence = tmp_path / "evidence"
    diag.prepare_build(evidence, bun)
    wrapper = evidence / "bin/bun"
    version = subprocess.check_output([str(wrapper), "--version"], text=True)
    assert version == "--version\n"
    assert not (evidence / "compile-command.json").exists()
    output = subprocess.check_output([str(wrapper), "build", "--compile", "entry.js"], text=True)
    assert f"--metafile={evidence / 'module-graph.json'}" in output
    argv = json.loads((evidence / "compile-command.json").read_text())
    assert argv == [
        str(bun),
        "build",
        "--compile",
        "entry.js",
        f"--metafile={evidence / 'module-graph.json'}",
    ]
    assert not (evidence / "environment.json").exists()


def test_strict_startup_output_is_a_failure(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Zero exit with warnings or the wrong assistant output is not a successful startup."""
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(
        diag, "execute", lambda argv, **_: subprocess.CompletedProcess(argv, 0, "wrong", "warning")
    )
    monkeypatch.setattr(diag, "build_metadata", lambda *_: {})
    assert diag.diagnose(box, *inputs, tmp_path / "artifacts") != 0


def test_capture_failure_never_masks_original_status(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A scanner refusal must not publish partial bytes or replace the failed child's status."""
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(
        diag, "execute", lambda argv, **_: subprocess.CompletedProcess(argv, 37, "", "failed")
    )
    monkeypatch.setattr(diag, "build_metadata", lambda *_: {})
    inputs[0].write_bytes(b"ghp_" + b"x" * 36)
    output = tmp_path / "artifacts"
    assert diag.diagnose(box, *inputs, output) == 37
    assert not output.exists()


def test_stale_output_is_refused_before_startup(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stale evidence cannot accidentally be uploaded after a successful later invocation."""
    box = build_sandbox(tmp_path / "sandbox")
    output = tmp_path / "artifacts"
    output.mkdir()
    monkeypatch.setattr(diag, "execute", lambda *_, **__: pytest.fail("must refuse before execution"))
    with pytest.raises(FileExistsError, match="stale"):
        diag.diagnose(box, *inputs, output)


def test_timeout_remains_failure_under_scrubbed_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A timeout preserves both partial streams and never receives ambient auth variables."""
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-not-for-diagnostics")

    def timeout(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        env = kwargs["env"]
        assert isinstance(env, dict)
        assert "OPENAI_API_KEY" not in env
        assert env["HOME"] == str(box.home)
        raise subprocess.TimeoutExpired(argv, 60, output=b"partial", stderr=b"original error")

    monkeypatch.setattr(subprocess, "run", timeout)
    result = diag.execute(["/fake/pi"], box=box, extra={})
    assert result.returncode == 124
    assert result.stdout == "partial"
    assert result.stderr.startswith("original error")


def test_workflow_captures_only_failed_linux_startup() -> None:
    """The build graph is observed once; upload is failure-only and cannot include fixture homes."""
    workflow = yaml.safe_load((Path(__file__).parents[2] / ".github/workflows/ci.yml").read_text())
    steps = workflow["jobs"]["stack"]["steps"]
    probe = next(step for step in steps if step.get("id") == "startup")
    assert "matrix.platform == 'linux-x64'" in probe["if"]
    assert "steps.build.outcome == 'success'" in probe["if"]
    assert "continue-on-error" not in probe
    assert "standalone_diagnostics startup" in probe["run"]
    upload = next(
        step for step in steps if step.get("name") == "Upload scanned standalone startup failure evidence"
    )
    assert "steps.startup.outcome == 'failure'" in upload["if"]
    assert "steps.startup.outputs.artifact_ready == 'true'" in upload["if"]
    assert upload["with"]["path"] == "${{ runner.temp }}/standalone-startup-diagnostics/"
    build = next(step for step in steps if step.get("id") == "build")
    assert "standalone_diagnostics" in build["run"]
    assert "prepare-build" in build["run"]
    assert 'tee "$RUNNER_TEMP/pi-build-evidence/build.log"' in build["run"]
    assert any(step.get("name") == "Standalone D and E (personal)" for step in steps)


@pytest.mark.parametrize(
    ("status", "credential", "ready"), [(0, False, False), (9, False, True), (33, True, False)]
)
def test_cli_announces_only_scanned_failed_artifacts(
    tmp_path: Path,
    inputs: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: int,
    credential: bool,
    ready: bool,
) -> None:
    """The workflow readiness output is absent on success and credential-scan refusal."""
    binary, core, evidence = inputs
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "install_stack", lambda *_: box)
    monkeypatch.setattr(
        diag,
        "execute",
        lambda argv, **_: subprocess.CompletedProcess(argv, status, "STACK-OK\n" if status == 0 else "", ""),
    )
    monkeypatch.setattr(diag, "build_metadata", lambda *_: {})
    if credential:
        binary.write_bytes(b"ghp_" + b"x" * 36)
    github_output = tmp_path / "github-output"
    monkeypatch.setattr(
        diag.sys,
        "argv",
        [
            "diagnostic",
            "startup",
            "--binary",
            str(binary),
            "--core",
            str(core),
            "--build-evidence",
            str(evidence),
            "--output",
            str(tmp_path / "artifacts"),
            "--github-output",
            str(github_output),
        ],
    )
    assert diag.main() == status
    assert github_output.exists() is ready
    if ready:
        assert github_output.read_text() == "artifact_ready=true\n"
