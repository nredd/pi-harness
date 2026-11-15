"""Exercise the sole tarball-membership gate and production-source completeness.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

import package_contracts as pc


@pytest.mark.parametrize("contract", pc.ALL_CONTRACTS, ids=lambda contract: contract.directory)
def test_every_payload_is_exact_and_rejects_each_omission(contract: pc.PackageContract) -> None:
    """Require an exact contract and reject losing any fixed shipped file.

    Parameters:
        contract (pc.PackageContract): Production package contract.

    Returns:
        None: Every omission is rejected.
    """
    assert contract.packed_files
    for omitted in contract.packed_files:
        files = [name for name in contract.packed_files if name != omitted]
        assert any(omitted in problem for problem in pc.audit_files(contract, files))


def test_legacy_allowlist_only_contract() -> None:
    """Retain the audit helper's allowlist-only seam for external contract consumers.

    Returns:
        None: Legacy allowlist validation remains supported.
    """
    contract = dataclasses.replace(pc.PRESET_CONTRACT, packed_files=(), required=("LICENSE",))
    assert pc.audit_files(contract, ["LICENSE"]) == []


def test_source_completeness_and_test_exclusion(tmp_path: Path) -> None:
    """Require new production modules, ignore development inputs, forbid packed tests.

    Parameters:
        tmp_path (Path): Disposable package directory.

    Returns:
        None: Missing sources and shipped tests fail independently.
    """
    for name in (
        "src/index.ts",
        "src/extra.mjs",
        "src/unit.test.ts",
        "src/unit.test.js",
        "src/unit.test.mts",
        "src/unit.test.mjs",
        "src/tests/helper.ts",
        "src/test/helper.ts",
        "src/fixtures/data.ts",
        "src/.hidden/helper.ts",
        "src/docs/runtime.ts",
        "src/dist/runtime.ts",
        "src/notes.md",
        "src/vitest.config.ts",
        "src/test-fixtures.ts",
    ):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    production = [
        "src/index.ts",
        "src/extra.mjs",
        "src/notes.md",
        "src/.hidden/helper.ts",
        "src/docs/runtime.ts",
        "src/dist/runtime.ts",
        "src/vitest.config.ts",
    ]
    assert pc.audit_source_files(tmp_path, production) == []
    for omitted in production:
        problems = pc.audit_source_files(tmp_path, [name for name in production if name != omitted])
        assert any(omitted in problem for problem in problems)
    problems = pc.audit_source_files(tmp_path, ["src/index.ts", "test/a.ts", "unit.test.ts"])
    assert any("src/extra.mjs" in problem for problem in problems)
    assert sum("must not ship" in problem for problem in problems) == 2


def test_legacy_todo_and_compiled_library(tmp_path: Path) -> None:
    """Preserve todo's root production walk and check compiled library outputs.

    Parameters:
        tmp_path (Path): Disposable workspace parent.

    Returns:
        None: Legacy modules and nested library outputs cannot silently disappear.
    """
    todo = tmp_path / "todo"
    todo.mkdir()
    for name in ("index.ts", "new.ts", "tool.mjs", "vitest.config.ts"):
        (todo / name).write_text("")
    assert pc.audit_source_files(todo, ["index.ts"]) == [
        "production source 'new.ts' requires packed 'new.ts'"
    ]
    assert pc.audit_source_files(tmp_path, []) == []
    (tmp_path / "src").mkdir()
    (tmp_path / "src/index.ts").write_text("")
    assert pc.audit_source_files(tmp_path, ["dist/index.js", "dist/index.d.ts"], library=True) == []
    assert len(pc.audit_source_files(tmp_path, [], library=True)) == 2
    (tmp_path / "src/nested").mkdir()
    (tmp_path / "src/nested/index.ts").write_text("")
    assert pc.audit_source_files(tmp_path, ["dist/index.js", "dist/index.d.ts"], library=True) == [
        "production source 'src/nested/index.ts' requires packed 'dist/nested/index.js'",
        "production source 'src/nested/index.ts' requires packed 'dist/nested/index.d.ts'",
    ]


def test_preset_resource_disk_completeness(tmp_path: Path) -> None:
    """Reject unpacked preset resources even when the exact packed list is unchanged.

    Parameters:
        tmp_path (Path): Disposable preset resource tree.

    Returns:
        None: Every resource type, including dotfiles, must ship.
    """
    for name in ("lib/known.ts", "lib/new.ts", "themes/new.json", "agents/.hidden.md"):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
    problems = pc.audit_source_files(
        tmp_path, ["lib/known.ts"], resource_directories=pc.PRESET_CONTRACT.resource_directories
    )
    assert problems == [
        "resource file 'agents/.hidden.md' is not packed",
        "resource file 'lib/new.ts' is not packed",
        "resource file 'themes/new.json' is not packed",
    ]


def test_packed_gate_reports_actual_pack_and_rejects_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Use the pack boundary to exercise all-contract success and missing-source failures.

    Parameters:
        tmp_path (Path): Disposable gate directories.
        monkeypatch (pytest.MonkeyPatch): Replace the external npm/tarball boundaries.

    Returns:
        None: The gate reports actual files and rejects mismatches.
    """
    contract = dataclasses.replace(
        pc.PRESET_CONTRACT, packed_files=("LICENSE",), required=("LICENSE",), resource_directories=()
    )
    artifact = pc.PackedArtifact(contract, tmp_path / "x.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ("LICENSE",))
    monkeypatch.setattr(pc, "ALL_CONTRACTS", (contract,))
    monkeypatch.setattr(pc, "pack", Mock(return_value=artifact))
    work = tmp_path / "pass"
    work.mkdir()
    assert pc.run_packed_files_gate(work) == {"preset": ["LICENSE"]}
    monkeypatch.setattr(pc, "pack", Mock(return_value=dataclasses.replace(artifact, files=())))
    work = tmp_path / "fail"
    work.mkdir()
    with pytest.raises(pc.ContractError, match="LICENSE"):
        pc.run_packed_files_gate(work)
    monkeypatch.setattr(pc, "ALL_CONTRACTS", (contract, pc.TODO_CONTRACT))
    load = Mock(return_value=artifact)
    monkeypatch.setattr(pc, "load_tarball", load)
    work = tmp_path / "supplied"
    work.mkdir()
    assert pc.run_packed_files_gate(work, {"preset": artifact.path}) == {"preset": ["LICENSE"]}
    load.assert_called_once_with(contract, artifact.path)


@pytest.mark.parametrize("report", [False, True])
def test_packed_only_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, report: bool) -> None:
    """Select the fast path without invoking stock Pi and optionally persist its evidence.

    Parameters:
        tmp_path (Path): Disposable report directory.
        monkeypatch (pytest.MonkeyPatch): Replace the gate execution boundary.
        report (bool): Whether to request a JSON report.

    Returns:
        None: The CLI selects the fast gate and serializes its report.
    """
    result = {"preset": ["LICENSE"]}
    gate = Mock(return_value=result)
    monkeypatch.setattr(pc, "run_packed_files_gate", gate)
    args = ["--packed-files-only"]
    output = tmp_path / "report.json"
    if report:
        args += ["--report", str(output)]
    assert pc.main(args) == 0
    gate.assert_called_once()
    if report:
        assert json.loads(output.read_text()) == result
