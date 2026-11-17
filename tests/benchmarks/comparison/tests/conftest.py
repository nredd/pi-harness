from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pi_harness_benchmark import prepare
from pi_harness_benchmark.fixtures import generate_fixtures
from pi_harness_benchmark.models import Harness
from pi_harness_benchmark.prepare import CLI_VERSIONS


@pytest.fixture
def sample_dir() -> Path:
    return Path(__file__).parent / "samples"


@pytest.fixture(scope="session")
def generated_workspace(tmp_path_factory: pytest.TempPathFactory) -> Path:
    workspace = tmp_path_factory.mktemp("generated-workspace")
    generate_fixtures(workspace)
    return workspace


@pytest.fixture(autouse=True)
def pinned_native_cli_stubs(
    request: pytest.FixtureRequest,
    tmp_path_factory: pytest.TempPathFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stub the native CLIs and the Pi plan-mode install with the pinned historical values.

    Unit tests exercise `prepare` against the historical pinned CLIs; they must not depend on
    whichever native CLIs or Pi packages happen to be installed on the host. The stub `pi`/`claude`/
    `codex` binaries report the pinned versions without launching model sessions; the plan-mode
    package and configuration paths point at temporary files carrying the pinned values.

    Parameters:
        request (pytest.FixtureRequest): Current test and its native-runtime marker.
        tmp_path_factory (pytest.TempPathFactory): Temporary fixture directories.
        monkeypatch (pytest.MonkeyPatch): Scoped environment and module overrides.

    Returns:
        None: Test-local overrides are restored by pytest.
    """
    if request.node.get_closest_marker("native_runtime"):
        return  # Real-CLI tests must see the real pinned CLI on `PATH`, not stubs.
    stubs = tmp_path_factory.mktemp("native-cli-stubs")
    for binary, harness in (
        ("pi", Harness.PI_ANTHROPIC),
        ("claude", Harness.CLAUDE),
        ("codex", Harness.CODEX),
    ):
        stub = stubs / binary
        stub.write_text(f"#!/bin/sh\necho '{binary} {CLI_VERSIONS[harness]}'\n", encoding="utf-8")
        stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{stubs}:{os.environ['PATH']}")
    package = stubs / "pi-plan-mode-package.json"
    package.write_text(json.dumps({"version": prepare.PI_PLAN_EXTENSION_VERSION}), encoding="utf-8")
    cfg = stubs / "pi-plan-mode.json"
    cfg.write_text(
        json.dumps(
            {
                "implementationPlanRetention": prepare.PI_PLAN_RETENTION,
                "thinkingLevel": prepare.PI_PLAN_THINKING_LEVEL,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(prepare, "PI_PLAN_PACKAGE_PATH", package)
    monkeypatch.setattr(prepare, "PI_PLAN_CONFIGURATION_PATH", cfg)
