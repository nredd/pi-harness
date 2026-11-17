"""Keep candidate child probes behind authenticated root core installation.

References:
    https://github.com/nredd/pi-harness/issues/774
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_candidate_child_install_authenticates_root_overrides_first() -> None:
    """Require the real preflight before root npm, with a preflight-only token."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    steps = workflow["jobs"]["core"]["steps"]
    preflight = next(
        step for step in steps if step.get("name") == "Verify root core overrides before child install"
    )
    install = next(
        step
        for step in steps
        if step.get("name") == "Install owned packages for candidate-core child verification"
    )
    probe = next(
        step
        for step in steps
        if step.get("name") == "Verify assembled direct and routed child compaction on candidate core"
    )
    build = next(
        step
        for step in steps
        if step.get("name") == "Build owned packages before candidate-core child verification"
    )
    assert steps.index(preflight) < steps.index(install) < steps.index(build) < steps.index(probe)
    assert build["working-directory"] == probe["working-directory"] == "."
    assert build["run"] == "make build"
    assert probe["run"] == (
        "uv run --locked --project tests/integration pytest "
        "tests/integration/scenarios/test_core_compaction.py"
    )
    assert preflight["working-directory"] == install["working-directory"] == "."
    assert preflight["run"] == "make verify-root-overrides"
    assert preflight["env"] == {"GH_TOKEN": "${{ github.token }}"}
    assert install["run"] == "npm ci --ignore-scripts"
    assert "env" not in install
    assert "env" not in workflow
    assert "env" not in workflow["jobs"]["core"]
    assert workflow["permissions"] == {"contents": "read"}


def test_candidate_child_inputs_trigger_the_fork_gate() -> None:
    """Run source probes when their code, shared support or build inputs change."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    inputs = {
        "forks/**",
        ".gitmodules",
        ".github/workflows/forks.yml",
        "Makefile",
        "tests/integration/probes/**",
        "tests/integration/scenarios/test_core_compaction.py",
        "tests/integration/harness/**",
        "tests/integration/conftest.py",
        "tests/integration/pyproject.toml",
        "tests/integration/uv.lock",
        "release/**",
        "tests/inprocess/support.ts",
        "packages/subagents/**",
        "biome.json",
        "package.json",
        "package-lock.json",
        ".npmrc",
        ".node-version",
    }
    for event in ("pull_request", "push"):
        assert inputs <= set(workflow[True][event]["paths"])
