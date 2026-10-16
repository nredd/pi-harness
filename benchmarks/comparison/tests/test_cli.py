from __future__ import annotations

import json
import logging
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from pi_harness_benchmark import cli
from pi_harness_benchmark.models import Fixture


def _invoke(monkeypatch: pytest.MonkeyPatch, arguments: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", ["pi-harness-benchmark", *arguments])
    cli.main()


def test_cli_matrix_writes_36_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    output = tmp_path / "matrix.json"
    caplog.set_level(logging.INFO)

    _invoke(monkeypatch, ["--root", str(tmp_path), "matrix", "--output", str(output)])

    assert len(json.loads(output.read_text(encoding="utf-8"))) == 36
    assert "Wrote 36 runs" in caplog.text


def test_cli_dispatches_generate_prepare_mark_finalize_and_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)

    def fake_generate(workspace: Path, *, force: bool) -> dict[Fixture, str]:
        assert workspace == tmp_path / "workspace"
        assert force
        return {Fixture.LOCALIZED_BUG: "a" * 40}

    monkeypatch.setattr(cli, "generate_fixtures", fake_generate)
    _invoke(monkeypatch, ["--root", str(tmp_path), "generate", "--force"])
    assert "localized-bug" in caplog.text

    run_dir = tmp_path / "run"
    fake_manifest = SimpleNamespace(
        run_dir=run_dir,
        spec=SimpleNamespace(run_id="run-id"),
    )

    def fake_prepare(root: Path, spec: object, *, replace: bool) -> tuple[object, str]:
        assert root == tmp_path
        assert spec is not None
        assert not replace
        return fake_manifest, "native instructions"

    monkeypatch.setattr(cli, "prepare_run", fake_prepare)
    _invoke(
        monkeypatch,
        ["--root", str(tmp_path), "prepare", "01-anthropic-localized-bug-r1-pi-anthropic"],
    )
    assert "native instructions" in caplog.text

    def fake_mark(selected: Path, event: str, *, allow_out_of_order: bool = False) -> object:
        assert selected == run_dir
        assert event == "start"
        assert not allow_out_of_order
        return fake_manifest

    monkeypatch.setattr(cli, "mark_run", fake_mark)
    _invoke(monkeypatch, ["mark", str(run_dir), "start"])
    assert "Recorded 'start'" in caplog.text

    fake_result = SimpleNamespace(
        result_path=run_dir / "result.json",
        visible_gate=SimpleNamespace(passed=True),
        hidden_gate=SimpleNamespace(passed=False),
        success=False,
    )

    def fake_finalize(selected: Path) -> object:
        assert selected == run_dir
        return fake_result

    monkeypatch.setattr(cli, "finalize_run", fake_finalize)
    _invoke(monkeypatch, ["finalize", str(run_dir)])
    assert "Visible=True hidden=False success=False" in caplog.text

    def fake_report(results: Path, destination: Path) -> dict[str, int]:
        assert results == tmp_path / "artifacts" / "runs"
        assert destination == tmp_path / "artifacts" / "report.json"
        return {"result_count": 4}

    monkeypatch.setattr(cli, "write_report", fake_report)
    _invoke(monkeypatch, ["--root", str(tmp_path), "report"])
    assert "Wrote 4 results" in caplog.text


def test_cli_reports_operator_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.ERROR)

    with pytest.raises(SystemExit) as caught:
        _invoke(monkeypatch, ["--root", str(tmp_path), "prepare", "not-a-run"])

    assert caught.value.code == 2
    assert "Unknown matrix run ID" in caplog.text


def test_package_main_module_delegates_to_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def fake_main() -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(cli, "main", fake_main)
    runpy.run_module("pi_harness_benchmark.__main__", run_name="__main__")

    assert called
