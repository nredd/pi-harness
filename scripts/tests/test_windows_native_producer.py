"""Native Windows producer wiring and executable required-check refusal controls.

References:
    https://github.com/nredd/pi-harness/issues/696
"""

from __future__ import annotations

import os
import re
import shutil
import ssl
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow_jobs() -> dict[str, Any]:
    """Read the submitted workflow, not a copied shell implementation.

    Returns:
        dict[str, Any]: CI job definitions.
    """
    return yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]


def test_windows_producer_uses_native_x64_and_preserves_reports() -> None:
    """Keep the native compiler/test producer independent of WSL pool routing."""
    jobs = workflow_jobs()
    producer = jobs["computer-use-windows"]
    assert producer["runs-on"] == "windows-2025"
    assert producer["needs"] == "classify"
    assert "packages/computer-use" in producer["if"]
    assert producer["env"]["RUSTUP_TOOLCHAIN"] == "1.97.1"
    steps = producer["steps"]
    commands = "\n".join(step.get("run", "") for step in steps)
    assert "host: x86_64-pc-windows-msvc" in commands
    assert "--version 0.9.1 --locked" in commands
    assert "cargo check --locked --all-targets" in commands
    assert "cargo clippy --locked --all-targets" in commands
    assert "rust-coverage.mjs --crate windows --output" in commands
    assert "test/windows-build-scripts.test.mjs" in commands
    assert not any(step.get("continue-on-error") for step in steps)
    assert "scripts/coverage_provenance.py" not in commands
    upload = next(
        step for step in steps if step.get("name") == "Preserve Windows source-bound native reports"
    )
    assert upload["if"] == "always()"
    assert upload["with"]["if-no-files-found"] == "error"
    assert "provenance.json" not in upload["with"]["path"]
    for report in ("lcov.info", "coverage.json", "metadata.json", "summary.txt", "*.log", "compiler.log"):
        assert report in upload["with"]["path"]
    assert "computer-use-windows" in jobs["owned-ubuntu"]["needs"]
    assert (
        "packages/computer-use/native/windows/bridge-rs/** text eol=lf"
        in (ROOT / ".gitattributes").read_text()
    )
    verify = commands.index("python -m pi_release.release --verify-root-overrides --root .")
    assert verify < commands.index("npm ci --ignore-scripts")
    assert "$env:SSL_CERT_FILE = Join-Path $env:RUNNER_TEMP" in commands
    assert 'require("node:tls").rootCertificates' in commands
    assert "Git\\mingw64" not in commands


def test_required_fan_in_accounts_the_windows_artifact_separately() -> None:
    """Require accounting on the selected Ubuntu check, not on unrelated or macOS runs."""
    jobs = workflow_jobs()
    ubuntu = jobs["owned-ubuntu"]
    steps = ubuntu["steps"]
    by_name = {step.get("name"): step for step in steps}
    download = by_name["Download Windows x64 coverage"]
    account = by_name["Account for Windows x64 coverage separately"]
    required = by_name["Require every planned shard to succeed"]
    assert steps.index(required) < steps.index(download) < steps.index(account)
    assert download["with"]["name"] == "computer-use-rust-windows-x64"
    assert download["if"] == account["if"]
    assert "steps.plan.outputs.run == 'true' && env.WINDOWS_REQUIRED == 'true'" in account["if"]
    assert jobs["owned-macos"]["env"]["WINDOWS_REQUIRED"] == "false"
    assert "--os win32 --base" in account["run"]
    assert 'cp "$reports"/windows-*/lcov.info "$destination/lcov.info"' in account["run"]
    assert "coverage/windows-x64-summary.json" in account["run"]
    assert (
        "coverage/windows-x64-summary.json"
        in by_name["Preserve independent coverage reports and summary"]["with"]["path"]
    )
    assert not account.get("continue-on-error")


def test_windows_verifier_uses_loadable_public_node_roots(tmp_path: Path) -> None:
    """Execute the workflow's actual CA producer and validate the resulting TLS roots offline.

    Parameters:
        tmp_path (Path): Disposable public PEM destination.
    """
    steps = workflow_jobs()["computer-use-windows"]["steps"]
    verify = next(
        step
        for step in steps
        if step.get("name") == "Verify root core overrides before installing dependencies"
    )
    match = re.search(r"node -e '([^']+)'", verify["run"])
    assert match is not None
    node = shutil.which("node")
    assert node is not None, "The repository's pinned Node toolchain is required"
    bundle = tmp_path / "public-roots.pem"
    subprocess.run(
        [node, "-e", match[1], str(bundle)], check=True, capture_output=True, text=True, timeout=30
    )
    context = ssl.create_default_context(cafile=str(bundle))
    assert context.cert_store_stats()["x509_ca"] > 0
    assert context.check_hostname
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert bundle.read_text().startswith("-----BEGIN CERTIFICATE-----")


@pytest.mark.parametrize("result", ["success", "failure", "cancelled", "skipped", ""])
@pytest.mark.parametrize("required", ["true", "false"])
def test_required_check_rejects_failed_or_missing_native_producer(
    tmp_path: Path, result: str, required: str
) -> None:
    """Execute the submitted fan-in against every terminal or missing native result.

    Parameters:
        tmp_path (Path): Disposable script directory.
        result (str): Native producer outcome.
        required (str): Whether the classified cell requires computer-use.
    """
    steps = workflow_jobs()["owned-ubuntu"]["steps"]
    step = next(step for step in steps if step.get("name") == "Require every planned shard to succeed")
    script = tmp_path / "require.sh"
    script.write_text(step["run"])
    completed = subprocess.run(
        ["/bin/bash", "-e", str(script)],
        cwd=ROOT,
        env=os.environ
        | {
            "SHARDS_RESULT": "success",
            "CELL": "owned (ubuntu-24.04)",
            "WINDOWS_REQUIRED": required,
            "WINDOWS_RESULT": result,
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    passes = required == "false" or result == "success"
    assert (completed.returncode == 0) is passes, completed.stdout + completed.stderr
    if not passes:
        assert (
            "Native Windows x64 compiler, tests, reports and build scripts must succeed" in completed.stdout
        )
