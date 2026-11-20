"""Exercise Windows artifact staging with disposable build outputs on any host."""

from __future__ import annotations

import hashlib
import runpy
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci_native_helper
import native_lint

SCRIPT = Path(__file__).resolve().parents[1] / "ci_native_helper.py"
WORKFLOW = SCRIPT.parents[1] / ".github/workflows/native-helper.yml"
SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
BUILD_PREFIX = (
    b"source=0123456789abcdef0123456789abcdef01234567\n"
    b"target=x86_64-pc-windows-msvc\n"
    b"rust_requested=1.97.1\n"
    b"protocol=4\n"
    b"capability=fail-closed-live-target-v1\n"
)


@pytest.fixture
def runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Set up the workflow argv and fresh paths for staging.

    Parameters:
        tmp_path (Path): Temporary working directory for the job.
        monkeypatch (pytest.MonkeyPatch): Scoped cwd and argv overrides.

    Returns:
        tuple[Path, Path]: Build executable and artifact directory paths.
    """
    monkeypatch.chdir(tmp_path)
    executable = Path("cargo output/windows-bridge.exe")
    executable.parent.mkdir()
    artifact_dir = Path("artifact output")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(SCRIPT),
            "--source-sha",
            SOURCE_SHA,
            "--executable",
            str(executable),
            "--artifact-dir",
            str(artifact_dir),
        ],
    )
    return executable, artifact_dir


def test_built_helper_has_exact_payload_and_checksum(runner: tuple[Path, Path]) -> None:
    """Stage the binary and metadata even if a later fixture step was not reached."""
    executable, artifact_dir = runner
    payload = b"MZ\x00\xff\r\n\x01"
    executable.write_bytes(payload)
    artifact_dir.mkdir()

    ci_native_helper.stage(executable, artifact_dir, SOURCE_SHA)

    assert {path.name for path in artifact_dir.iterdir()} == {"windows-bridge.exe", "SHA256SUMS", "build.txt"}
    assert (artifact_dir / "windows-bridge.exe").read_bytes() == payload
    digest = hashlib.sha256(payload).hexdigest()
    assert (artifact_dir / "SHA256SUMS").read_bytes() == f"{digest}  windows-bridge.exe\r\n".encode("ascii")
    assert (
        artifact_dir / "build.txt"
    ).read_bytes() == BUILD_PREFIX + b"executable=PRESENT\nfixture=NOT_REACHED\r\n"


@pytest.mark.parametrize("fixture_status", [b"PASS", b"FAILED"])
def test_fixture_status_is_trimmed_but_evidence_is_copied_verbatim(
    runner: tuple[Path, Path], fixture_status: bytes
) -> None:
    """Stage diagnostics independently of the executable and without rewriting their bytes."""
    _, artifact_dir = runner
    evidence = {
        "native-fixture-status.txt": b" \t" + fixture_status + b"\r\n",
        "native-fixture.log": b"fixture output \xe2\x98\x83\r\n",
        "native-compiler.log": b"compiler output\r\n",
    }
    for filename, payload in evidence.items():
        Path(filename).write_bytes(payload)
    Path("unrelated.log").write_bytes(b"not part of the artifact")

    runpy.run_path(str(SCRIPT), run_name="__main__")

    assert {path.name for path in artifact_dir.iterdir()} == {*evidence, "build.txt"}
    assert (
        artifact_dir / "build.txt"
    ).read_bytes() == BUILD_PREFIX + b"executable=NOT_BUILT\nfixture=" + fixture_status + b"\r\n"
    for filename, payload in evidence.items():
        assert (artifact_dir / filename).read_bytes() == payload


def test_empty_fixture_status_fails_before_writing_build_status(runner: tuple[Path, Path]) -> None:
    """Do not treat an interrupted status write as a missing fixture step."""
    _, artifact_dir = runner
    Path("native-fixture-status.txt").touch()

    with pytest.raises(ValueError, match="Fixture status file is empty"):
        runpy.run_path(str(SCRIPT), run_name="__main__")

    assert list(artifact_dir.iterdir()) == []


def test_missing_build_and_fixture_emit_only_build_status(runner: tuple[Path, Path]) -> None:
    """Leave a status artifact to upload even when no earlier steps produced files."""
    _, artifact_dir = runner

    runpy.run_path(str(SCRIPT), run_name="__main__")

    assert {path.name for path in artifact_dir.iterdir()} == {"build.txt"}
    assert (
        artifact_dir / "build.txt"
    ).read_bytes() == BUILD_PREFIX + b"executable=NOT_BUILT\nfixture=NOT_REACHED\r\n"


def test_windows_workflow_routes_bootstrap_failures_to_receipt_only() -> None:
    """Run fallback on either bootstrap failure without clearing the job failure."""
    steps = yaml.safe_load(WORKFLOW.read_text())["jobs"]["windows-helper"]["steps"]
    _, setup, bootstrap, install, build, fixture, stage, receipt, upload = steps
    assert setup["id"] == "setup_uv"
    assert setup["uses"].startswith("astral-sh/setup-uv@")
    assert bootstrap["id"] == "bootstrap_python"
    launch = "uv run --no-project --python (Get-Content .python-version) python "
    assert bootstrap["run"] == launch + "--version"
    for step in (setup, bootstrap, install, build, fixture):
        assert "if" not in step
        assert "continue-on-error" not in step
    assert stage["if"] == "${{ always() && steps.bootstrap_python.outcome == 'success' }}"
    assert stage["run"].startswith(launch + "scripts/ci_native_helper.py ")
    assert receipt["if"] == (
        "${{ always() && (steps.setup_uv.outcome == 'failure'"
        " || steps.bootstrap_python.outcome == 'failure') }}"
    )
    assert receipt["shell"] == "pwsh"
    assert upload["uses"].startswith("actions/upload-artifact@")
    assert upload["if"] == "always()"
    assert upload["with"]["if-no-files-found"] == "error"
    assert upload["with"]["path"] == (
        "${{ steps.bootstrap_python.outcome == 'success' && 'native-helper-artifact/*'"
        " || 'native-helper-artifact/build.txt' }}"
    )


def test_bootstrap_failure_script_writes_receipt_without_uv(tmp_path: Path) -> None:
    """Execute the actual fallback block with neither uv nor Python on PATH.

    Parameters:
        tmp_path (Path): Disposable workspace with no build outputs.
    """
    workflow = yaml.safe_load(WORKFLOW.read_text())
    job = workflow["jobs"]["windows-helper"]
    fallback = next(
        step["run"] for step in job["steps"] if step.get("name") == "Record Windows helper bootstrap failure"
    )
    script = tmp_path / "fallback.ps1"
    script.write_text("$ErrorActionPreference = 'Stop'\n" + fallback, encoding="utf-8")
    pwsh = native_lint.binaries(WORKFLOW.parents[2] / ".native-lint")["pwsh"]
    subprocess.check_output(
        [str(pwsh), "-NoProfile", "-NonInteractive", "-File", str(script)],
        cwd=tmp_path,
        env={
            "PATH": "",
            "HOME": str(tmp_path),
            "HELPER_SOURCE_SHA": SOURCE_SHA,
            "RUSTUP_TOOLCHAIN": job["env"]["RUSTUP_TOOLCHAIN"],
        },
        stderr=subprocess.STDOUT,
    )

    artifact_dir = tmp_path / "native-helper-artifact"
    assert {path.name for path in artifact_dir.iterdir()} == {"build.txt"}
    assert (artifact_dir / "build.txt").read_bytes() == (
        BUILD_PREFIX + b"executable=NOT_BUILT\nfixture=NOT_REACHED\nstaging=BOOTSTRAP_FAILED\r\n"
    )
