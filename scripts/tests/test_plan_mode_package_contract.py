"""Failure-path coverage for the packed Plan-mode contract.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
    https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contract_helpers import StubProvider, make_context
from test_package_contracts import make_tarball

import package_contracts as pc


def context(tmp_path: Path) -> pc.Context:
    """Create the smallest Plan-mode scenario context.

    Parameters:
        tmp_path (Path): Test scratch root.

    Returns:
        pc.Context: Context with a disposable sandbox and package artifact.
    """
    return make_context(tmp_path, pc.PLAN_MODE_CONTRACT, "0.59.3-nredd.1")


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


def test_plan_mode_pack_matches_contract(tmp_path: Path) -> None:
    """`npm pack` ships exactly the contract and manifest payload.

    Parameters:
        tmp_path (Path): Temporary tarball directory.
        No additional fixtures are needed; this test creates its isolated npm environment.
    """
    artifact = pc.pack(pc.PLAN_MODE_CONTRACT, tmp_path, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()))
    manifest = json.loads((pc.REPO_ROOT / "packages/plan-mode/package.json").read_text())
    assert pc.audit_files(pc.PLAN_MODE_CONTRACT, artifact.files) == []
    assert manifest["files"] == ["src", "dist", "docs", "README.md", "LICENSE"]


def test_plan_mode_own_license_rejects_root_license(tmp_path: Path) -> None:
    """Imported copyright must survive packing instead of being replaced by the root license.

    Parameters:
        tmp_path (Path): Temporary tarball directory.
    """
    tarball = tmp_path / "package.tgz"
    make_tarball(tarball, {"LICENSE": (pc.REPO_ROOT / "LICENSE").read_bytes()})
    assert pc.audit_license(tarball, (pc.REPO_ROOT / "packages/plan-mode/LICENSE").read_bytes())


def question_run(text: str) -> pc.PiRun:
    """Build a clean Pi run whose `plan_mode_question` call answered `text`.

    Parameters:
        text (str): Tool result text.

    Returns:
        pc.PiRun: Exit 0 with one question record.
    """
    record = {
        "type": "tool_execution_end",
        "toolName": "plan_mode_question",
        "isError": False,
        "result": {"content": [{"type": "text", "text": text}]},
    }
    return pc.PiRun(0, (record,), "", "")


def stub_scenario(monkeypatch: pytest.MonkeyPatch, tools: list[str], result: pc.PiRun) -> list[list[str]]:
    """Substitute the provider and Pi run, recording each Pi argument vector.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
        tools (list[str]): Tools the fake model receives.
        result (pc.PiRun): Run to return.

    Returns:
        list[list[str]]: Receives the CLI arguments of every `run_pi` call.
    """
    calls: list[list[str]] = []

    def fake_run_pi(*args: Any, **_kwargs: Any) -> pc.PiRun:
        """Record the Pi CLI arguments.

        Parameters:
            *args (Any): `run_pi` positionals; the last is the argument list.
            **_kwargs (Any): Ignored.

        Returns:
            pc.PiRun: The canned run.
        """
        calls.append(list(args[-1]))
        return result

    monkeypatch.setattr(pc.Context, "provider_session", lambda self, _script: StubProvider(tools))
    monkeypatch.setattr(pc, "run_pi", fake_run_pi)
    return calls


def test_plan_mode_scenario_reports_missing_tool_and_load_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing tool or failed extension load is a contract violation.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
    """
    ctx = context(tmp_path)
    stub_scenario(monkeypatch, ["plan_mode_question"], pc.PiRun(0, (), "", ""))
    with pytest.raises(pc.ContractError, match="plan_mode_complete"):
        pc.scenario_plan_mode(ctx)
    stub_scenario(
        monkeypatch, sorted(pc.PLAN_MODE_CONTRACT.exposes_tools), pc.PiRun(1, (), "", "missing pi-tui-kit")
    )
    with pytest.raises(pc.ContractError, match="missing pi-tui-kit"):
        pc.scenario_plan_mode(ctx)


def test_plan_mode_scenario_succeeds_and_enters_plan_mode_with_a_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The success path records both tools and the `ui_unavailable` result.

    `/plan start` sends no turn, so the scenario must pass `/plan <prompt>`.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
    """
    calls = stub_scenario(
        monkeypatch, sorted(pc.PLAN_MODE_CONTRACT.exposes_tools), question_run("error: ui_unavailable")
    )
    evidence = pc.scenario_plan_mode(context(tmp_path))
    assert evidence == {
        "tools": ["plan_mode_complete", "plan_mode_question"],
        "question_result": "error: ui_unavailable",
    }
    assert len(calls) == 1
    prompt = calls[0][-1]
    assert prompt.startswith("/plan ")
    assert prompt != "/plan start"
    assert prompt.removeprefix("/plan ").strip()


def test_plan_mode_scenario_rejects_question_result_without_ui_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A question result that is not the headless refusal fails.

    Parameters:
        tmp_path (Path): Temporary scenario root.
        monkeypatch (pytest.MonkeyPatch): Dependency substitutions.
    """
    stub_scenario(monkeypatch, sorted(pc.PLAN_MODE_CONTRACT.exposes_tools), question_run("answered: Yes"))
    with pytest.raises(pc.ContractError, match="unexpected active Plan question result"):
        pc.scenario_plan_mode(context(tmp_path))


KIT = "@narumitw/pi-tui-kit"
ROOT_PACKAGE = "@nredd/pi-plan-mode"


def lay_out_install(
    cwd: Path,
    packages: dict[str, dict[str, Any]],
    *,
    lock: dict[str, dict[str, Any]] | None = None,
    extra_dirs: tuple[str, ...] = (),
) -> None:
    """Materialize `node_modules` from manifests and write a lockfile.

    Parameters:
        cwd (Path): Consumer project root.
        packages (dict[str, dict[str, Any]]): Manifest fields by `node_modules/...` path.
        lock (dict[str, dict[str, Any]] | None): Lock entries by path; derived from `packages` when `None`.
        extra_dirs (tuple[str, ...]): Top-level directories without a manifest.
    """
    for path, manifest in packages.items():
        (cwd / path).mkdir(parents=True, exist_ok=True)
        (cwd / path / "package.json").write_text(json.dumps({"name": path, **manifest}))
    for name in extra_dirs:
        (cwd / "node_modules" / name).mkdir(parents=True)
    entries = lock if lock is not None else {path: {} for path in packages}
    (cwd / "package-lock.json").write_text(json.dumps({"packages": {"": {}, **entries}}))


def good_install() -> dict[str, dict[str, Any]]:
    """Return a valid install: the package, its declared dependency and one transitive module.

    Returns:
        dict[str, dict[str, Any]]: Manifests by path.
    """
    return {
        f"node_modules/{ROOT_PACKAGE}": {"dependencies": {KIT: "^0.65.2"}},
        f"node_modules/{KIT}": {"dependencies": {"a": "1"}, "optionalDependencies": {"opt": "1"}},
        "node_modules/a": {"dependencies": {"c": "1"}},
        "node_modules/a/node_modules/c": {},
    }


def lock_for(packages: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Return honest lock entries (root package deps only) for `packages`.

    Parameters:
        packages (dict[str, dict[str, Any]]): Manifests by path.

    Returns:
        dict[str, dict[str, Any]]: Lock entries by path.
    """
    return {
        path: {"dependencies": manifest["dependencies"]} if path.endswith(ROOT_PACKAGE) else {}
        for path, manifest in packages.items()
    }


def run_install(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    packages: dict[str, dict[str, Any]],
    *,
    lock: dict[str, dict[str, Any]] | None = None,
    extra_dirs: tuple[str, ...] = (),
) -> Path:
    """Run `install_alone` for the Plan-mode contract over a faked npm install.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
        packages (dict[str, dict[str, Any]]): Manifests by path.
        lock (dict[str, dict[str, Any]] | None): Lock entries; honest ones when `None`.
        extra_dirs (tuple[str, ...]): Top-level directories without a manifest.

    Returns:
        Path: The installed package directory.
    """
    artifact = pc.PackedArtifact(
        pc.PLAN_MODE_CONTRACT, tmp_path / "package.tgz", "0.59.3-nredd.1", "sha512-x", "0" * 40, 1, ()
    )
    entries = lock if lock is not None else lock_for(packages)
    monkeypatch.setattr(
        pc,
        "run",
        lambda _cmd, *, cwd, **_kwargs: lay_out_install(cwd, packages, lock=entries, extra_dirs=extra_dirs),
    )
    return pc.install_alone(
        artifact, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()), tmp_path / "project"
    )


def test_install_closure_accepts_nested_resolution_and_absent_optional(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nested `c` resolves under `a`, and an uninstalled optional dependency is fine.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    installed = run_install(tmp_path, monkeypatch, good_install())
    assert installed == tmp_path / "project" / "node_modules" / ROOT_PACKAGE


def test_install_closure_includes_an_installed_optional_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An installed optional dependency belongs to the closure, so omitting it from the lock fails.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = good_install() | {"node_modules/opt": {}}
    run_install(tmp_path / "ok", monkeypatch, packages)
    lock = lock_for(packages)
    del lock["node_modules/opt"]
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        run_install(tmp_path / "bad", monkeypatch, packages, lock=lock)


def test_install_closure_rejects_a_hoisted_duplicate_of_a_nested_module(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A top-level `c` that nothing resolves to is extra, because `a` resolves its nested copy.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        run_install(tmp_path, monkeypatch, good_install() | {"node_modules/c": {}})


def test_install_closure_missing_direct_dependency_is_a_contract_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing declared dependency raises `ContractError`, never `KeyError`.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = {
        path: m for path, m in good_install().items() if path.startswith(f"node_modules/{ROOT_PACKAGE}")
    }
    with pytest.raises(pc.ContractError, match=f"requires '{KIT}'"):
        run_install(tmp_path, monkeypatch, packages)


def test_install_closure_missing_transitive_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A required transitive dependency that is not installed fails.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = {path: m for path, m in good_install().items() if path != "node_modules/a"}
    packages.pop("node_modules/a/node_modules/c")
    with pytest.raises(pc.ContractError, match="requires 'a'"):
        run_install(tmp_path, monkeypatch, packages)


def test_install_closure_rejects_extra_lock_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A lock entry for a package nothing requires fails.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = good_install()
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        run_install(tmp_path, monkeypatch, packages, lock=lock_for(packages) | {"node_modules/left-pad": {}})


def test_install_closure_rejects_extra_top_level_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A top-level directory outside the closure fails even when the lock is honest.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    with pytest.raises(pc.ContractError, match="install entries differ"):
        run_install(tmp_path, monkeypatch, good_install(), extra_dirs=("stray",))


def test_install_closure_rejects_an_installed_package_outside_the_closure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An installed package nobody requires fails when the lock hides it.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = good_install() | {"node_modules/left-pad": {}}
    lock = lock_for(good_install())
    with pytest.raises(pc.ContractError, match="installed packages differ"):
        run_install(tmp_path, monkeypatch, packages, lock=lock)


def test_install_closure_distrusts_tampered_transitive_lock_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lock claims about transitive entries never widen or narrow the installed closure.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    packages = good_install()
    claims_ghost = lock_for(packages) | {
        f"node_modules/{KIT}": {"dependencies": {"ghost": "1"}},
        "node_modules/ghost": {},
    }
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        run_install(tmp_path / "ghost", monkeypatch, packages, lock=claims_ghost)
    hides_a = {path: entry for path, entry in lock_for(packages).items() if path != "node_modules/a"}
    hides_a[f"node_modules/{KIT}"] = {"dependencies": {}}
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        run_install(tmp_path / "hides", monkeypatch, packages, lock=hides_a)


def test_plan_mode_install_allows_only_declared_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The registry install branch rejects an undeclared subject dependency.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    artifact = pc.PackedArtifact(
        pc.PLAN_MODE_CONTRACT, tmp_path / "package.tgz", "0.59.3-nredd.1", "sha512-x", "0" * 40, 1, ()
    )

    def fake_run(_cmd: list[object], *, cwd: Path, **_kwargs: Any) -> None:
        """Create an install lockfile containing an undeclared host package.

        Parameters:
            _cmd (list[object]): Ignored subprocess command.
            cwd (Path): Consumer project root.
            **_kwargs (Any): Ignored subprocess keyword arguments.
        """
        for name in ("@nredd/pi-plan-mode", "@narumitw/pi-tui-kit", "@earendil-works/pi-tui"):
            (cwd / "node_modules" / name).mkdir(parents=True, exist_ok=True)
        (cwd / "package-lock.json").write_text(
            json.dumps(
                {
                    "packages": {
                        "": {},
                        "node_modules/@nredd/pi-plan-mode": {
                            "dependencies": {"@narumitw/pi-tui-kit": "^0.65.2", "left-pad": "1.0.0"}
                        },
                        "node_modules/@narumitw/pi-tui-kit": {},
                        "node_modules/@earendil-works/pi-tui": {},
                    }
                }
            )
        )

    monkeypatch.setattr(pc, "run", fake_run)
    with pytest.raises(pc.ContractError, match="dependencies differ"):
        pc.install_alone(artifact, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()), tmp_path / "project")
