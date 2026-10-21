"""Contract coverage for the packed todo plugin.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
    https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files
"""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contract_helpers import NoRequestProvider, StubProvider, make_context
from test_package_contracts import make_tarball

import package_contracts as pc

SUBJECT = "stock contract task"


def context(tmp_path: Path) -> pc.Context:
    """Create the smallest todo scenario context.

    Parameters:
        tmp_path (Path): Test scratch root.

    Returns:
        pc.Context: Context with a disposable sandbox and package artifact.
    """
    return make_context(tmp_path, pc.TODO_CONTRACT, "2.13.9")


def todo_event(
    *, text: str = f"Created #1 {SUBJECT}", snapshot_subject: str | None = SUBJECT, is_error: bool = False
) -> dict[str, Any]:
    """Build a synthetic `tool_execution_end` event for `todo`.

    Parameters:
        text (str): Result text content.
        snapshot_subject (str | None): `details.tasks[0].subject`; `None` omits the task.
        is_error (bool): The event's `isError` flag.

    Returns:
        dict[str, Any]: The event.
    """
    tasks = [] if snapshot_subject is None else [{"id": 1, "subject": snapshot_subject, "status": "pending"}]
    return {
        "type": "tool_execution_end",
        "toolName": "todo",
        "isError": is_error,
        "result": {
            "content": [{"type": "text", "text": text}],
            "details": {"action": "create", "tasks": tasks, "nextId": 2},
        },
    }


def drive(
    ctx: pc.Context,
    monkeypatch: pytest.MonkeyPatch,
    provider: StubProvider,
    run: pc.PiRun,
) -> pc.TodoEvidence:
    """Run `scenario_todo` with a stub provider and a canned Pi run.

    Parameters:
        ctx (pc.Context): Scenario context.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
        provider (StubProvider): Provider the scenario sees.
        run (pc.PiRun): Result `run_pi` returns.

    Returns:
        pc.TodoEvidence: The scenario's evidence.
    """
    monkeypatch.setattr(pc.Context, "provider_session", lambda self, _script: provider)
    monkeypatch.setattr(pc, "run_pi", lambda *_args, **_kwargs: run)
    return pc.scenario_todo(ctx)


def test_todo_manifest_rejects_dependency_drift() -> None:
    """Runtime dependencies are exactly the declared set at the declared ranges."""
    manifest = json.loads((pc.REPO_ROOT / "packages/todo/package.json").read_text())
    assert pc.audit_manifest(pc.TODO_CONTRACT, manifest, ["index.ts"]) == []
    problems = pc.audit_manifest(
        pc.TODO_CONTRACT,
        manifest | {"dependencies": {"@juicesharp/rpiv-config": "^2.13.8", "left-pad": "1.0.0"}},
        ["index.ts"],
    )
    assert any("left-pad" in problem for problem in problems)
    assert any("^2.13.9" in problem and "rpiv-config" in problem for problem in problems)
    assert any("rpiv-i18n" in problem for problem in problems)


def test_todo_pack_matches_contract(tmp_path: Path) -> None:
    """`npm pack` ships only allowed paths, every required file, and no images.

    Parameters:
        tmp_path (Path): Temporary tarball directory.
    """
    artifact = pc.pack(pc.TODO_CONTRACT, tmp_path, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()))
    assert pc.audit_files(pc.TODO_CONTRACT, artifact.files) == []
    assert set(pc.TODO_CONTRACT.required) <= set(artifact.files)
    assert not [name for name in artifact.files if name.endswith((".png", ".jpg", ".svg"))]
    assert not [name for name in artifact.files if name.endswith(".test.ts")]


def test_todo_audit_files_rejects_stray_file() -> None:
    """A file outside the allowlist or a missing required file is a violation."""
    files = [*pc.TODO_CONTRACT.required, "stray.txt", "docs/overlay.jpg"]
    problems = pc.audit_files(pc.TODO_CONTRACT, files)
    assert "unexpected file 'stray.txt'" in problems
    assert "unexpected file 'docs/overlay.jpg'" in problems
    assert pc.audit_files(pc.TODO_CONTRACT, ["README.md"])


def test_todo_own_license_rejects_root_license(tmp_path: Path) -> None:
    """The retained upstream copyright must survive packing, not the root license.

    Parameters:
        tmp_path (Path): Temporary tarball directory.
    """
    tarball = tmp_path / "package.tgz"
    make_tarball(tarball, {"LICENSE": (pc.REPO_ROOT / "LICENSE").read_bytes()})
    assert pc.TODO_CONTRACT.own_license
    assert pc.audit_license(tarball, (pc.REPO_ROOT / "packages/todo/LICENSE").read_bytes())
    make_tarball(tarball, {"LICENSE": (pc.REPO_ROOT / "packages/todo/LICENSE").read_bytes()})
    assert pc.audit_license(tarball, (pc.REPO_ROOT / "packages/todo/LICENSE").read_bytes()) == []


def test_todo_scenario_passes_and_records_persisted_subject(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A clean run with a snapshot-carrying result yields the evidence shape.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
    """
    run = pc.PiRun(0, (todo_event(),), "", "")
    evidence = drive(context(tmp_path), monkeypatch, StubProvider(["todo"]), run)
    assert evidence == {"tools": ["todo"], "subject": SUBJECT}
    pc.TodoEvidenceModel.model_validate(evidence)


@pytest.mark.parametrize(
    ("provider", "run", "match"),
    [
        (StubProvider(["read"]), pc.PiRun(0, (todo_event(),), "", ""), r"none of \['todo'\] declared"),
        (StubProvider(["todo"]), pc.PiRun(1, (), "", "cannot load rpiv-i18n"), "cannot load rpiv-i18n"),
        (StubProvider(["todo"]), pc.PiRun(0, (), "", "warn: oops"), "unexpected stderr"),
        (NoRequestProvider(), pc.PiRun(0, (todo_event(),), "", ""), "received no request"),
        (StubProvider(["todo"]), pc.PiRun(0, (), "", ""), "Expected exactly one `todo` result"),
        (
            StubProvider(["todo"]),
            pc.PiRun(0, (todo_event(text="boom", is_error=True),), "", ""),
            "todo create failed: boom",
        ),
        (
            StubProvider(["todo"]),
            pc.PiRun(0, (todo_event(text="Created #1 other"),), "", ""),
            "todo result omitted",
        ),
        (
            StubProvider(["todo"]),
            pc.PiRun(0, (todo_event(snapshot_subject=None),), "", ""),
            "did not persist",
        ),
        (
            StubProvider(["todo"]),
            pc.PiRun(0, (todo_event(snapshot_subject="other"),), "", ""),
            "did not persist",
        ),
    ],
    ids=[
        "missing-tool",
        "load-failure",
        "stderr",
        "no-provider-request",
        "no-result",
        "tool-error",
        "text-without-subject",
        "snapshot-empty",
        "snapshot-other-subject",
    ],
)
def test_todo_scenario_rejects_contract_violations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: StubProvider, run: pc.PiRun, match: str
) -> None:
    """Each failure mode named by the contract raises a `ContractError`.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
        provider (StubProvider): Provider the scenario sees.
        run (pc.PiRun): Canned Pi run.
        match (str): Expected error text.
    """
    with pytest.raises(pc.ContractError, match=match):
        drive(context(tmp_path), monkeypatch, provider, run)


def test_todo_scenario_rejects_sibling_tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A sibling package's tool in the model request means the package was not alone.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
    """
    ctx = dataclasses.replace(context(tmp_path), siblings=(pc.PLAN_MODE_CONTRACT,))
    tool = sorted(pc.PLAN_MODE_CONTRACT.exposes_tools)[0]
    run = pc.PiRun(0, (todo_event(),), "", "")
    with pytest.raises(pc.ContractError, match="sibling tools present"):
        drive(ctx, monkeypatch, StubProvider(["todo", tool]), run)
