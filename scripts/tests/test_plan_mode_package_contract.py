"""Failure-path coverage for the packed Plan-mode contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_package_contracts import make_tarball

import faux_provider as fp
import package_contracts as pc


class StubProvider:
    """Minimal provider context exposing one recorded request."""

    def __init__(self, tools: list[str]) -> None:
        self.requests = [fp.RecordedRequest("m", ("user",), tuple(tools), "", route=None)]

    def __enter__(self) -> StubProvider:
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def context(tmp_path: Path) -> pc.Context:
    """Create the smallest Plan-mode scenario context.

    Parameters:
        tmp_path (Path): Test scratch root.

    Returns:
        pc.Context: Context with a disposable sandbox and package artifact.
    """
    work = tmp_path / "work"
    work.mkdir()
    return pc.Context(
        Path("pi"),
        pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()),
        tmp_path / "installed",
        pc.PackedArtifact(
            pc.PLAN_MODE_CONTRACT, tmp_path / "package.tgz", "0.59.3-nredd.1", "sha512-x", "0" * 40, 1, ()
        ),
        work,
        (),
    )


def test_plan_mode_manifest_rejects_dependency_drift() -> None:
    """The imported runtime dependency is exact and no other dependency is accepted."""
    manifest = json.loads((pc.REPO_ROOT / "packages/plan-mode/package.json").read_text())
    assert pc.audit_manifest(pc.PLAN_MODE_CONTRACT, manifest, ["dist/index.ts"]) == []
    problems = pc.audit_manifest(
        pc.PLAN_MODE_CONTRACT,
        manifest | {"dependencies": {"@narumitw/pi-tui-kit": "^0.1.0", "left-pad": "1.0.0"}},
        ["dist/index.ts"],
    )
    assert any("left-pad" in problem for problem in problems)
    assert any("^0.65.2" in problem for problem in problems)


def test_plan_mode_own_license_rejects_root_license(tmp_path: Path) -> None:
    """Imported copyright must survive packing instead of being replaced by the root license."""
    tarball = tmp_path / "package.tgz"
    make_tarball(tarball, {"LICENSE": (pc.REPO_ROOT / "LICENSE").read_bytes()})
    assert pc.audit_license(tarball, (pc.REPO_ROOT / "packages/plan-mode/LICENSE").read_bytes())


def test_plan_mode_scenario_reports_missing_tool_and_load_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing tool or failed extension load is a contract violation."""
    ctx = context(tmp_path)
    monkeypatch.setattr(
        pc.Context,
        "provider_session",
        lambda self, _script: StubProvider(["plan_mode_question"]),
    )
    monkeypatch.setattr(pc, "run_pi", lambda *_args, **_kwargs: pc.PiRun(0, (), "", ""))
    with pytest.raises(pc.ContractError, match="plan_mode_complete"):
        pc.scenario_plan_mode(ctx)
    monkeypatch.setattr(
        pc.Context,
        "provider_session",
        lambda self, _script: StubProvider(sorted(pc.PLAN_MODE_CONTRACT.exposes_tools)),
    )
    monkeypatch.setattr(pc, "run_pi", lambda *_args, **_kwargs: pc.PiRun(1, (), "", "missing pi-tui-kit"))
    with pytest.raises(pc.ContractError, match="missing pi-tui-kit"):
        pc.scenario_plan_mode(ctx)


def test_plan_mode_install_allows_only_declared_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The registry install branch rejects an undeclared installed package."""
    artifact = pc.PackedArtifact(
        pc.PLAN_MODE_CONTRACT, tmp_path / "package.tgz", "0.59.3-nredd.1", "sha512-x", "0" * 40, 1, ()
    )

    def fake_run(_cmd: list[object], *, cwd: Path, **_kwargs: Any) -> None:
        for name in ("@nredd/pi-plan-mode", "@narumitw/pi-tui-kit", "@earendil-works/pi-tui"):
            (cwd / "node_modules" / name).mkdir(parents=True, exist_ok=True)
        (cwd / "package-lock.json").write_text(
            json.dumps(
                {
                    "packages": {
                        "": {},
                        "node_modules/@nredd/pi-plan-mode": {},
                        "node_modules/@narumitw/pi-tui-kit": {},
                        "node_modules/@earendil-works/pi-tui": {},
                    }
                }
            )
        )

    monkeypatch.setattr(pc, "run", fake_run)
    with pytest.raises(pc.ContractError, match="pulled host modules"):
        pc.install_alone(artifact, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()), tmp_path / "project")
