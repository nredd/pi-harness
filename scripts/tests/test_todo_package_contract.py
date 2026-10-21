"""Contract coverage for the packed todo plugin."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import package_contracts as pc


class StubProvider:
    """Minimal provider context exposing a recorded todo tool declaration."""

    def __init__(self) -> None:
        """Initialize the one model request the scenario inspects."""
        self.requests = [fp.RecordedRequest("m", ("user",), ("todo",), "", route=None)]

    def __enter__(self) -> StubProvider:
        """Enter the inert provider context."""
        return self

    def __exit__(self, *_args: object) -> None:
        """Leave the inert provider context."""


def context(tmp_path: Path) -> pc.Context:
    """Create the smallest todo scenario context."""
    work = tmp_path / "work"
    work.mkdir()
    return pc.Context(
        Path("pi"),
        pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()),
        tmp_path / "installed",
        pc.PackedArtifact(pc.TODO_CONTRACT, tmp_path / "package.tgz", "2.13.9", "sha512-x", "0" * 40, 1, ()),
        work,
        (),
    )


def test_todo_manifest_declares_exact_runtime_dependencies() -> None:
    """The imported config and i18n SDKs are explicit runtime dependencies."""
    manifest = json.loads((pc.REPO_ROOT / "packages/todo/package.json").read_text())
    assert pc.audit_manifest(pc.TODO_CONTRACT, manifest, ["index.ts"]) == []


def test_todo_scenario_requires_a_successful_create(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing or failed todo call is a stock-contract violation."""
    ctx = context(tmp_path)
    monkeypatch.setattr(pc.Context, "provider_session", lambda self, _script: StubProvider())
    monkeypatch.setattr(pc, "run_pi", lambda *_args, **_kwargs: pc.PiRun(0, (), "", ""))
    with pytest.raises(pc.ContractError, match="Expected exactly one `todo` result"):
        pc.scenario_todo(ctx)
