"""Failure-only standalone evidence with an explicit, credential-scanned file boundary.

References:
- https://github.com/nredd/pi-harness/pull/178
"""

from __future__ import annotations

import hashlib
import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from harness import standalone_diagnostics as diag
from harness.credentials import CREDENTIAL
from harness.sandbox import build_sandbox


@pytest.fixture
def inputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Create public build inputs with deliberately forbidden sibling files.

    Parameters:
        tmp_path (Path): private test directory.

    Returns:
        tuple[Path, Path, Path]: executable, core checkout and build evidence roots.
    """
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
    """Require successful startup to create no artifact, replay or binary copy.

    Parameters:
        tmp_path (Path): private test directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic command replacement.

    Returns:
        None: assertions complete.
    """
    box = build_sandbox(tmp_path / "sandbox")
    calls: list[list[str]] = []

    def execute(argv: list[str], **kwargs: object) -> diag.StartupResult:
        """Return one recorded successful startup.

        Parameters:
            argv (list[str]): requested subprocess arguments.
            kwargs (object): unused synthetic environment options.

        Returns:
            diag.StartupResult: strict successful startup output.
        """
        calls.append(argv)
        return diag.StartupResult(0, b"STACK-OK\n", b"")

    monkeypatch.setattr(diag, "execute", execute)
    output = tmp_path / "artifacts"
    assert diag.diagnose(box, *inputs, output) == 0
    assert not output.exists()
    assert len(calls) == 1


def test_failure_preserves_original_status_and_allowlist(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Capture exact bytes and correlated code, never homes or arbitrary caches.

    Parameters:
        tmp_path (Path): private test directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic command/identity replacement.

    Returns:
        None: assertions complete.
    """
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

    def execute(argv: list[str], **kwargs: object) -> diag.StartupResult:
        """Return a failed primary run followed by a deliberately passing replay.

        Parameters:
            argv (list[str]): requested subprocess arguments.
            kwargs (object): unused synthetic environment options.

        Returns:
            diag.StartupResult: primary failure or supplemental raw stack.
        """
        calls.append(argv)
        if len(calls) == 1:
            return diag.StartupResult(23, b"", b"ORIGINAL Type3 is not defined\n")
        return diag.StartupResult(
            0, b"STACK-OK\n", b"ReferenceError: Type3 is not defined\n at original.ts:4:2\n"
        )

    monkeypatch.setattr(diag, "execute", execute)
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata(core_sha="f" * 40))
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
    """Require a closed artifact allowlist, not recursive home upload.

    Parameters:
        name (str): forbidden candidate path.

    Returns:
        None: assertion completes.
    """
    assert not diag.allowed_artifact_path(Path(name))


def test_fixed_artifact_inventory_is_explicit() -> None:
    """Require deliberate matrix review whenever a fixed artifact path changes.

    Returns:
        None: independent inventory equality assertion completes.
    """
    expected_paths = {
        "pi",
        "SHA256SUMS",
        "build.json",
        "build.log",
        "compile-command.json",
        "module-graph.json",
        "startup.stdout",
        "startup.stderr",
        "replay.stdout",
        "replay.stderr",
        "replay-wrapper.ts",
        "stack.json",
        "packages/pi-memory/index.ts",
        "packages/pi-memory/package.json",
        "packages/pi-memory/npm-lock.json",
        "core/loader.js",
        "core/virtual-modules.js",
        "core/typebox-helpers.js",
        "core/jiti-package.json",
        "core/typebox-package.json",
        "core/package-lock.json",
        "harness-package-lock.json",
    }
    assert expected_paths == diag.FIXED_PATHS


@pytest.mark.parametrize(
    "name",
    [
        *sorted(diag.FIXED_PATHS),
        *[
            f"jiti/{phase}/pi-memory-index{maps}{interop}.01234567.{extension}"
            for phase in ("primary", "replay")
            for maps in ("", "+map")
            for interop in ("", ".i")
            for extension in ("cjs", "mjs")
        ],
    ],
)
@pytest.mark.parametrize(
    "token",
    [
        b"npm_" + b"aB1" * 12,
        b"npm_" + b"a" * 37,
        b"ghp_" + b"a" * 20,
        b"github_pat_" + b"a" * 30,
        b"sk-" + b"a" * 16,
        b"pk-" + b"a" * 16,
        b"sk-ant-" + b"a" * 20,
        b"xoxb-" + b"a" * 10,
        b"AKIA" + b"A" * 16,
        b"-----BEGIN DSA PRIVATE KEY-----",
        b"Bearer " + b"a" * 24,
        b'"refresh_token": "' + b"a" * 24 + b'"',
        b'{"access_token":"x"}',
        b'{"refresh_token":"x"}',
        b'{"api_key":"x"}',
        b"bEaReR x",
        b"https://user:password@example.invalid/",
    ],
)
def test_credential_scan_refuses_entire_publication(
    tmp_path: Path,
    inputs: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    token: bytes,
) -> None:
    """Publish the clean collector candidate before rejecting each contaminated token/path pair.

    Parameters:
        tmp_path (Path): private publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic primary/replay and publication injection.
        name (str): fixed or representative correlated-cache artifact path to contaminate.
        token (bytes): generated synthetic credential signature, never a real credential.

    Returns:
        None: clean byte preservation, scanner refusal and primary-status assertions complete.
    """
    output = tmp_path / "artifacts"
    content = b"\xffprefix " + token + b" suffix\r\n"
    publish = diag.publish
    assert diag.allowed_artifact_path(Path(name))
    publications: list[Path] = []

    def contaminated_publish(files: dict[str, bytes], destination: Path) -> None:
        """Prove the actual collector dictionary publishes before injecting the synthetic token.

        Parameters:
            files (dict[str, bytes]): actual collector publication candidates.
            destination (Path): fresh publication directory.

        Returns:
            None: never returned because the real scanner must refuse publication.

        Raises:
            ValueError: the verified credential refusal, passed through to the collector.
        """
        publications.append(destination)
        clean = tmp_path / "clean-artifacts"
        # SHA256SUMS is generated, not an original input; all other selected paths get clean bytes.
        candidate = files if name == "SHA256SUMS" else files | {name: b"\xffclean input\r\n"}
        publish(candidate, clean)
        assert (clean / name).is_file()
        for original_name, original_bytes in candidate.items():
            assert (clean / original_name).read_bytes() == original_bytes
        sums = "".join(
            f"{hashlib.sha256(data).hexdigest()}  {path}\n" for path, data in sorted(candidate.items())
        )
        assert (clean / "SHA256SUMS").read_bytes() == sums.encode()
        with pytest.raises(ValueError, match="credential") as refused:
            publish(candidate | {name: content}, destination)
        raise refused.value

    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "execute", lambda *_, **__: diag.StartupResult(37, b"", b"failed"))
    monkeypatch.setattr(diag, "replay_memory", lambda *_: diag.StartupResult(0, b"STACK-OK\n", b""))
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    monkeypatch.setattr(diag, "publish", contaminated_publish)
    assert diag.diagnose(box, *inputs, output) == 37
    assert publications == [output]
    assert not output.exists()


def test_npm_signature_length_boundary() -> None:
    """Require at least 36 alphanumeric npm-token characters without reading real credentials.

    Returns:
        None: synthetic boundary assertions complete.
    """
    assert CREDENTIAL.search(b"npm_" + b"a" * 35) is None
    assert CREDENTIAL.search(b"npm_" + b"a" * 36) is not None
    assert CREDENTIAL.search(b"npm_" + b"a" * 37) is not None


def test_symlink_cache_is_not_read(tmp_path: Path) -> None:
    """Reject a cache symlink pointing into an unrelated token store.

    Parameters:
        tmp_path (Path): private cache and forbidden sibling directory.

    Returns:
        None: assertion completes.
    """
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "auth.json").write_text("secret")
    (root / "source.mjs").symlink_to(tmp_path / "auth.json")
    with pytest.raises(ValueError, match="symlink"):
        diag.read_regular(root / "source.mjs", root)


def test_prepare_build_wrapper_forwards_without_env_dump(tmp_path: Path) -> None:
    """Forward ordinary commands and add only the compile metafile flag.

    Parameters:
        tmp_path (Path): private executable/metadata directory.

    Returns:
        None: executable-seam assertions complete.
    """
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
    """Refuse zero exit with warnings or incorrect assistant output.

    Parameters:
        tmp_path (Path): private fixture directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic incorrect command result.

    Returns:
        None: assertion completes.
    """
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "execute", lambda argv, **_: diag.StartupResult(0, b"wrong", b"warning"))
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    assert diag.diagnose(box, *inputs, tmp_path / "artifacts") != 0


def test_capture_failure_never_masks_original_status(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preserve the child's status when a scanner refuses artifact publication.

    Parameters:
        tmp_path (Path): private fixture/publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic failed command result.

    Returns:
        None: assertions complete.
    """
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "execute", lambda argv, **_: diag.StartupResult(37, b"", b"failed"))
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    inputs[0].write_bytes(b"ghp_" + b"x" * 36)
    output = tmp_path / "artifacts"
    assert diag.diagnose(box, *inputs, output) == 37
    assert not output.exists()


def test_stale_output_is_refused_before_startup(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse stale evidence before invoking another startup.

    Parameters:
        tmp_path (Path): private fixture/publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): fail if any command is executed.

    Returns:
        None: assertion completes.
    """
    box = build_sandbox(tmp_path / "sandbox")
    output = tmp_path / "artifacts"
    output.mkdir()
    monkeypatch.setattr(diag, "execute", lambda *_, **__: pytest.fail("must refuse before execution"))
    with pytest.raises(FileExistsError, match="stale"):
        diag.diagnose(box, *inputs, output)


def test_timeout_remains_failure_under_scrubbed_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Preserve timeout streams without passing ambient credentials.

    Parameters:
        tmp_path (Path): private fixture directory.
        monkeypatch (pytest.MonkeyPatch): synthetic credential and timeout result.

    Returns:
        None: assertions complete.
    """
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-not-for-diagnostics")

    def timeout(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        """Check the scrubbed environment and raise a timeout with partial streams.

        Parameters:
            argv (list[str]): requested subprocess arguments.
            kwargs (object): subprocess options including the scrubbed environment.

        Returns:
            subprocess.CompletedProcess[bytes]: never returned.

        Raises:
            subprocess.TimeoutExpired: deterministic timeout carrying partial output.
        """
        env = kwargs["env"]
        assert isinstance(env, dict)
        assert "OPENAI_API_KEY" not in env
        assert env["HOME"] == str(box.home)
        raise subprocess.TimeoutExpired(argv, 60, output=b"partial", stderr=b"original error")

    monkeypatch.setattr(subprocess, "run", timeout)
    result = diag.execute(["/fake/pi"], box=box, extra={})
    assert result.returncode == 124
    assert result.stdout == b"partial"
    assert result.stderr == b"original error"
    assert result.timed_out is True


def test_workflow_captures_only_failed_linux_startup() -> None:
    """Require failure-only upload with a scanned-artifact readiness receipt.

    Returns:
        None: workflow contract assertions complete.
    """
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
    """Announce readiness only after a scanned failed artifact is published.

    Parameters:
        tmp_path (Path): private fixture/publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): synthetic installer, subprocess and CLI inputs.
        status (int): original startup exit code.
        credential (bool): contaminate the binary to trigger scan refusal.
        ready (bool): expected upload readiness publication.

    Returns:
        None: CLI contract assertions complete.
    """
    binary, core, evidence = inputs
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "install_stack", lambda *_: box)
    monkeypatch.setattr(
        diag,
        "execute",
        lambda argv, **_: diag.StartupResult(status, b"STACK-OK\n" if status == 0 else b"", b""),
    )
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
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


def test_cli_rejects_stale_destination_before_install(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse an invalid destination before any package installer runs.

    Parameters:
        tmp_path (Path): private publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): fail if installation is attempted.

    Returns:
        None: early-validation assertion completes.
    """
    binary, core, evidence = inputs
    output = tmp_path / "stale"
    output.mkdir()
    monkeypatch.setattr(diag, "install_stack", lambda *_: pytest.fail("must not install"))
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
            str(output),
        ],
    )
    with pytest.raises(FileExistsError, match="before installation"):
        diag.main()


@pytest.mark.parametrize("data", [{"core_sha": 3}, {"unknown": "field"}])
def test_metadata_refuses_wrong_types_and_unknown_fields(data: dict[str, object]) -> None:
    """Validate the serialized identity shape without coercion or silent extra fields.

    Parameters:
        data (dict[str, object]): deliberately malformed build identity.

    Returns:
        None: schema-refusal assertion completes.
    """
    with pytest.raises(ValueError, match="validation error for BuildMetadata"):
        diag.BuildMetadata.model_validate(data)


@pytest.mark.parametrize("status", [0, 23, 124])
@pytest.mark.parametrize("replay_timeout", [False, True])
@pytest.mark.parametrize(
    ("stdout", "stderr"), [(b"STACK-OK\r\n", b"error\r\n"), (b"out\xff\r\n", b"err\xfe\r\n")]
)
def test_real_child_stream_bytes_and_primary_verdict(
    tmp_path: Path,
    inputs: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    *,
    status: int,
    stdout: bytes,
    stderr: bytes,
    replay_timeout: bool,
) -> None:
    """Preserve real child bytes despite a passing or timed-out supplemental replay.

    Parameters:
        tmp_path (Path): private fixture directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic metadata and replay.
        status (int): original child exit status.
        stdout (bytes): exact original output, including CRLF or invalid UTF8.
        stderr (bytes): exact original error stream.
        replay_timeout (bool): replace the successful replay verdict with a synthetic timeout.

    Returns:
        None: byte equality and original verdict assertions complete.
    """
    binary, core, evidence = inputs
    binary.write_text(
        f"#!{sys.executable}\nimport os\nos.write(1, {stdout!r})\n"
        f"os.write(2, {stderr!r})\nraise SystemExit({status})\n"
    )
    binary.chmod(0o700)
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    replay = diag.execute(
        [
            sys.executable,
            "-c",
            'import os; os.write(1, b"STACK-OK\\r\\n"); os.write(2, b"replay\\xff\\r\\n")',
        ],
        box=box,
        extra={},
    )
    if replay_timeout:
        replay = diag.StartupResult(124, replay.stdout, replay.stderr, timed_out=True)
    monkeypatch.setattr(diag, "replay_memory", lambda *_: replay)
    output = tmp_path / "artifact"
    assert diag.diagnose(box, binary, core, evidence, output) == (status or 1)
    assert (output / "startup.stdout").read_bytes() == stdout
    assert (output / "startup.stderr").read_bytes() == stderr
    assert (output / "replay.stdout").read_bytes() == b"STACK-OK\r\n"
    assert (output / "replay.stderr").read_bytes() == b"replay\xff\r\n"
    report = json.loads((output / "build.json").read_text())
    assert report["startup_returncode"] == status
    assert report["replay_returncode"] == (124 if replay_timeout else 0)
    assert report["startup_timed_out"] is False
    assert report["replay_timed_out"] is replay_timeout


@pytest.mark.parametrize(
    ("stdout", "stderr"), [(b"partial\r\n", b"error\r\n"), (b"\xff", b"\xfe"), (None, None)]
)
def test_timeout_artifact_keeps_partial_streams_unmodified(
    tmp_path: Path,
    inputs: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    stdout: bytes | None,
    stderr: bytes | None,
) -> None:
    """Record timeout separately without appending to or decoding partial streams.

    Parameters:
        tmp_path (Path): private fixture directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): deterministic timeout and metadata.
        stdout (bytes | None): timeout partial output or absent pipe data.
        stderr (bytes | None): timeout partial error or absent pipe data.

    Returns:
        None: raw stream and separate timeout metadata assertions complete.
    """
    box = build_sandbox(tmp_path / "sandbox")

    def timeout(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        """Raise a deterministic timeout with original partial bytes.

        Parameters:
            argv (list[str]): requested command.
            kwargs (object): unused subprocess options.

        Returns:
            subprocess.CompletedProcess[bytes]: never returned.

        Raises:
            subprocess.TimeoutExpired: original partial byte streams.
        """
        raise subprocess.TimeoutExpired(argv, 60, output=stdout, stderr=stderr)

    monkeypatch.setattr(subprocess, "run", timeout)
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    output = tmp_path / "artifact"
    assert diag.diagnose(box, *inputs, output) == 124
    assert (output / "startup.stdout").read_bytes() == (stdout or b"")
    assert (output / "startup.stderr").read_bytes() == (stderr or b"")
    report = json.loads((output / "build.json").read_text())
    assert report["startup_returncode"] == 124
    assert report["startup_timed_out"] is True
    assert report["replay_timed_out"] is None


def test_read_regular_refuses_a_non_regular_input(tmp_path: Path) -> None:
    """A directory where a file belongs is refused instead of read."""
    (tmp_path / "evidence.json").mkdir()
    with pytest.raises(ValueError, match=r"^Diagnostic input is not a bounded regular file$"):
        diag.read_regular(tmp_path / "evidence.json", tmp_path)


def test_publish_refuses_unsafe_inventories_before_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An existing destination, an unlisted path or an oversized input stops publication with nothing written.

    Parameters:
        tmp_path (Path): private publication parent.
        monkeypatch (pytest.MonkeyPatch): shrinks the size limit so no large buffer is allocated.
    """
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(FileExistsError, match=r"^Diagnostic output must be a new directory$"):
        diag.publish({"pi": b"x"}, existing)
    output = tmp_path / "artifacts"
    with pytest.raises(ValueError, match=r"^Unapproved diagnostic artifact path$"):
        diag.publish({"auth.json": b"x"}, output)
    monkeypatch.setattr(diag, "MAX_FILE_BYTES", 4)
    with pytest.raises(ValueError, match=r"^Diagnostic input exceeds the publication size limit$"):
        diag.publish({"pi": b"12345"}, output)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["existing"]


def test_capture_cache_refuses_conflicting_correlated_bytes(tmp_path: Path) -> None:
    """One correlated Jiti name with different bytes in two cache roots is ambiguous, so it is refused."""
    box = build_sandbox(tmp_path / "sandbox")
    core = tmp_path / "core"
    source = box.agent_dir / "npm/node_modules/pi-memory/index.ts"
    name = diag.cache_names(source)[0]
    for root, contents in ((box.root / "tmp/jiti", "one"), (core / "node_modules/.cache/jiti", "two")):
        root.mkdir(parents=True)
        (root / name).write_text(contents)
    with pytest.raises(ValueError, match=r"^Conflicting correlated Jiti cache bytes$"):
        diag.capture_cache(box, core, source, "primary")


def test_build_metadata_records_versions_and_unavailable_queries(
    tmp_path: Path, inputs: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each identity comes from its own query; one that cannot start is recorded as unavailable, not raised.

    Parameters:
        tmp_path (Path): private fixture directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): a `PATH` with no `bun`.
    """
    binary, core, _evidence = inputs
    binary.write_text("#!/bin/sh\necho 'pi 9.9.9'\n")
    binary.chmod(0o755)
    identity = ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "-c", "commit.gpgsign=false"]
    subprocess.run(["git", "init", "-q", str(core)], check=True)
    subprocess.run(
        ["git", "-C", str(core), *identity, "commit", "-q", "--allow-empty", "-m", "c"], check=True
    )
    head = subprocess.check_output(["git", "-C", str(core), "rev-parse", "HEAD"], text=True).strip()
    empty = tmp_path / "empty-path"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    metadata = diag.build_metadata(build_sandbox(tmp_path / "sandbox"), binary, core)
    assert (metadata.core_sha, metadata.pi_version) == (head, "pi 9.9.9")
    assert metadata.bun_version == "unavailable (FileNotFoundError)"
    assert metadata.node_version.startswith("v")
    assert metadata.build_command[-3:] == ["linux-x64", "--out", str(binary.parent.parent)]


def test_replay_memory_skips_a_stack_without_the_memory_package(tmp_path: Path) -> None:
    """An installed memory entrypoint that no `npm:pi-memory@` declaration loads is never rewritten."""
    box = build_sandbox(tmp_path / "sandbox")
    memory = box.agent_dir / "npm/node_modules/pi-memory"
    memory.mkdir(parents=True)
    (memory / "index.ts").write_text("export default function() {}")
    box.patch_json("settings.json", {"packages": ["npm:other@1.0.0", {"source": "npm:another@1.0.0"}]})
    assert diag.replay_memory(box, ["pi"], {}) is None
    assert not (memory / "diagnostic-wrapper.ts").exists()


def test_cli_prepare_build_uses_the_pinned_bun_on_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`prepare-build` wraps the `bun` found on `PATH`, and refuses with a usage error when there is none.

    Parameters:
        tmp_path (Path): private executable and evidence directories.
        monkeypatch (pytest.MonkeyPatch): `PATH` and CLI arguments.
    """
    tools = tmp_path / "tools"
    tools.mkdir()
    monkeypatch.setenv("PATH", str(tools))
    monkeypatch.setattr(diag.sys, "argv", ["diagnostic", "prepare-build", "--directory", str(tmp_path / "a")])
    with pytest.raises(SystemExit) as caught:
        diag.main()
    assert caught.value.code == 2
    assert not (tmp_path / "a").exists()
    (tools / "bun").write_text("#!/bin/sh\n")
    (tools / "bun").chmod(0o755)
    assert diag.main() == 0
    assert repr(str((tools / "bun").resolve())) in (tmp_path / "a/bin/bun").read_text()


def test_cli_keeps_the_status_when_readiness_cannot_be_announced(
    tmp_path: Path,
    inputs: tuple[Path, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unwritable `--github-output` is logged; the original failed startup status still wins.

    Parameters:
        tmp_path (Path): private fixture/publication directory.
        inputs (tuple[Path, Path, Path]): synthetic executable/core/evidence.
        monkeypatch (pytest.MonkeyPatch): synthetic installer, startup and CLI inputs.
        caplog (pytest.LogCaptureFixture): captured diagnostics.
    """
    binary, core, evidence = inputs
    box = build_sandbox(tmp_path / "sandbox")
    monkeypatch.setattr(diag, "install_stack", lambda *_: box)
    monkeypatch.setattr(diag, "execute", lambda argv, **_: diag.StartupResult(5, b"", b"failed"))
    monkeypatch.setattr(diag, "build_metadata", lambda *_: diag.BuildMetadata())
    github_output = tmp_path / "github-output"
    github_output.mkdir()
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
    with caplog.at_level("ERROR", logger=diag.LOGGER.name):
        assert diag.main() == 5
    assert (tmp_path / "artifacts").is_dir()
    assert "Cannot announce scanned diagnostic artifact; original startup status preserved" in caplog.messages


def test_module_entrypoint_requires_an_action(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`python -m harness.standalone_diagnostics` with no action is a usage error, before any install."""
    monkeypatch.setattr(sys, "argv", ["standalone_diagnostics"])
    monkeypatch.delitem(sys.modules, "harness.standalone_diagnostics")
    with pytest.raises(SystemExit) as caught:
        runpy.run_module("harness.standalone_diagnostics", run_name="__main__")
    assert caught.value.code == 2
    assert "the following arguments are required: action" in capsys.readouterr().err


def test_file_sha256_matches_hashlib_across_chunk_boundary(tmp_path: Path) -> None:
    """Hash a file larger than one read chunk identically to `hashlib`."""
    data = b"x" * (1024 * 1024 + 7)
    path = tmp_path / "pi"
    path.write_bytes(data)
    assert diag.file_sha256(path) == hashlib.sha256(data).hexdigest()


def test_verify_reproducible_records_matching_digest(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Identical builds pass and leave the carried digest, creating its parent directory."""
    first, second = tmp_path / "a", tmp_path / "b"
    first.write_bytes(b"same bytes")
    second.write_bytes(b"same bytes")
    out = tmp_path / "artifacts/standalone-pi.sha256"
    with caplog.at_level("INFO"):
        assert diag.verify_reproducible(first, second, out) == 0
    expected = hashlib.sha256(b"same bytes").hexdigest()
    assert out.read_text() == f"{expected}  pi\n"
    assert f"Standalone build reproducible: sha256 {expected}" in caplog.messages


def test_verify_reproducible_without_digest_file(tmp_path: Path) -> None:
    """The digest file is optional."""
    first, second = tmp_path / "a", tmp_path / "b"
    first.write_bytes(b"same")
    second.write_bytes(b"same")
    assert diag.verify_reproducible(first, second, None) == 0
    assert sorted(path.name for path in tmp_path.iterdir()) == ["a", "b"]


def test_verify_reproducible_fails_on_a_single_byte_difference(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Nondeterministic output fails, logs both digests and writes no digest."""
    first, second = tmp_path / "a", tmp_path / "b"
    first.write_bytes(b"Type3 ok")
    second.write_bytes(b"Type4 ok")
    out = tmp_path / "digest"
    assert diag.verify_reproducible(first, second, out) == 1
    assert not out.exists()
    message = (
        f"Standalone build is NOT reproducible: first {hashlib.sha256(b'Type3 ok').hexdigest()}, "
        f"second {hashlib.sha256(b'Type4 ok').hexdigest()}"
    )
    assert message in caplog.messages


@pytest.mark.parametrize(("second", "status"), [(b"same", 0), (b"different", 1)])
def test_cli_verify_reproducible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, second: bytes, status: int
) -> None:
    """The CLI action returns the comparison verdict as the process status."""
    first_path, second_path = tmp_path / "a", tmp_path / "b"
    first_path.write_bytes(b"same")
    second_path.write_bytes(second)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "standalone_diagnostics",
            "verify-reproducible",
            "--first",
            str(first_path),
            "--second",
            str(second_path),
        ],
    )
    assert diag.main() == status


def test_workflow_rebuilds_and_compares_standalone_before_use() -> None:
    """Require a second identical build, verified before `PI_BIN` is exported or any stack runs."""
    workflow = yaml.safe_load((Path(__file__).parents[2] / ".github/workflows/ci.yml").read_text())
    steps = workflow["jobs"]["stack"]["steps"]
    run = next(step for step in steps if step.get("id") == "build")["run"]
    assert run.count("./scripts/build-binaries.sh --skip-install --offline-model-data") == 2
    assert "--skip-build" not in run
    assert "verify-reproducible" in run
    assert "standalone-pi.sha256" in run
    assert run.index("verify-reproducible") < run.index('echo "PI_BIN=')
    upload = next(
        step
        for step in steps
        if step.get("with", {}).get("name") == "standalone-${{ matrix.platform }}-${{ matrix.stack }}"
    )
    assert upload["with"]["path"] == "integration/artifacts/"
    assert "always()" in upload["if"]
