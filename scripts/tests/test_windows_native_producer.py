"""Native Windows producer wiring and executable required-check refusal controls.

References:
    https://github.com/nredd/pi-harness/issues/696
"""

from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml
from test_ci_guest_matrix import PULL_REQUEST, Trigger, classify_context, evaluate, render

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
    subprocess.run([node, "-e", match[1], str(bundle)], check=True, capture_output=True, text=True)
    context = ssl.create_default_context(cafile=str(bundle))
    assert context.cert_store_stats()["x509_ca"] > 0
    assert context.check_hostname
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert bundle.read_text().startswith("-----BEGIN CERTIFICATE-----")


def windows_plan_context(decision: bool | str | None) -> dict[str, str]:
    """Return a real executing PR plan with a Windows decision override.

    Parameters:
        decision (bool | str | None): True keeps the planner's decision, False or a
            string overrides it, and None removes the field rather than writing JSON null.

    Returns:
        dict[str, str]: Workflow expression context with the modified plan JSON.

    Raises:
        json.JSONDecodeError: The classifier did not emit valid plan JSON.
        KeyError: The classifier omitted the plan, the Ubuntu owned cell, or the
            decision field to be removed.
    """
    context = classify_context(PULL_REQUEST)
    plan = json.loads(context["needs.classify.outputs.plan"])
    ubuntu = plan["owned (ubuntu-24.04)"]
    if decision is None:
        del ubuntu["windows_native_required"]
    elif decision is not True:
        # Keep the same shards to catch a consumer that recomputes the plan decision.
        ubuntu["windows_native_required"] = decision
    return context | {"needs.classify.outputs.plan": json.dumps(plan)}


def test_windows_plan_context_documents_and_omits_the_missing_decision() -> None:
    """Keep the missing-field fixture and its documented contract in sync.

    Returns:
        None: Assertions verify the typed contract and distinguish omission from null.
    """
    doc = windows_plan_context.__doc__
    assert doc is not None
    assert "Parameters:" in doc
    assert "decision (bool | str | None):" in doc
    assert "Returns:" in doc
    assert "dict[str, str]:" in doc
    assert "Raises:" in doc
    assert "json.JSONDecodeError:" in doc
    assert "None removes the field rather than writing JSON null" in doc
    context = windows_plan_context(None)
    plan = json.loads(context["needs.classify.outputs.plan"])
    assert "windows_native_required" not in plan["owned (ubuntu-24.04)"]


@pytest.mark.parametrize("decision", [True, False, None, "true", "false", ""])
def test_windows_producer_reads_a_strict_plan_decision(decision: bool | str | None) -> None:
    """Evaluate the real schedule condition without coercing absent fields or strings.

    Parameters:
        decision (bool | str | None): Boolean, malformed string, or absent decision.

    Returns:
        None: Assertions verify the condition accepts only booleans.
    """
    condition = workflow_jobs()["computer-use-windows"]["if"]
    context = windows_plan_context(decision)
    if isinstance(decision, bool):
        assert evaluate(condition, context) is decision
    else:
        with pytest.raises(json.JSONDecodeError):
            evaluate(condition, context)


def test_windows_producer_stays_off_without_an_executing_successful_cell() -> None:
    """Keep the producer off for a failed classifier or a missing or bypassed cell.

    Returns:
        None: Assertions verify the producer's scheduling condition.
    """
    condition = workflow_jobs()["computer-use-windows"]["if"]
    context = classify_context(PULL_REQUEST)
    for report in (
        context | {"needs.classify.result": "failure"},
        context | {"needs.classify.outputs.plan": ""},
        context | {"needs.classify.outputs.plan": "{}"},
        classify_context(Trigger(docs_only="true")),
    ):
        assert not evaluate(condition, report)


@pytest.mark.parametrize(
    ("decision", "result"),
    [
        (required, outcome)
        for required in (True, False)
        for outcome in ("success", "failure", "cancelled", "skipped", "")
    ]
    + [(None, "success"), ("true", "success"), ("false", "success"), ("", "success")],
)
def test_required_check_rejects_failed_or_missing_native_producer(
    tmp_path: Path, decision: bool | str | None, result: str
) -> None:
    """Execute the submitted fan-in against every terminal or missing native result.

    Parameters:
        tmp_path (Path): Disposable script directory.
        result (str): Native producer outcome.
        decision (bool | str | None): Boolean plan decision, a malformed string or an absent field.
    """
    fan_in = workflow_jobs()["owned-ubuntu"]
    required = render(fan_in["env"]["WINDOWS_REQUIRED"], windows_plan_context(decision))
    step = next(
        step for step in fan_in["steps"] if step.get("name") == "Require every planned shard to succeed"
    )
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
    passes = decision is False or (decision is True and result == "success")
    assert (completed.returncode == 0) is passes, completed.stdout + completed.stderr
    if not isinstance(decision, bool):
        assert "WINDOWS_REQUIRED must be true or false" in completed.stdout
    elif not passes:
        assert (
            "Native Windows x64 compiler, tests, reports and build scripts must succeed" in completed.stdout
        )
