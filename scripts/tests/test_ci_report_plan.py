"""Exercise report-plan's CLI and exact runner-file writes.

References:
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_report_plan

SCRIPT = Path(ci_report_plan.__file__).resolve()


@pytest.mark.parametrize(
    ("decision", "status", "outputs", "stdout", "summary"),
    [
        pytest.param(
            {"classify-result": "failure", "blocked": "true", "reason": "not reached"},
            1,
            "",
            "::error title=cell has no plan::classify finished with 'failure', "
            "so no cell may report a pass\n",
            "### cell: no plan (classify failure)\n",
            id="classify-failed-before-blocked",
        ),
        pytest.param(
            {"blocked": "true", "run": "", "reason": "Invalid PR title"},
            1,
            "",
            "::error title=cell blocked::Invalid PR title\n",
            "### cell: blocked\nInvalid PR title\n",
            id="blocked-before-invalid-run",
        ),
        pytest.param(
            {"blocked": "true", "reason": "-n"},
            1,
            "",
            "::error title=cell blocked::-n\n",
            "### cell: blocked\n-n\n",
            id="echo-option-is-literal",
        ),
        pytest.param(
            {"run": "True"},
            1,
            "",
            "::error title=cell has no plan::classify published no run decision for this cell\n",
            "",
            id="malformed-run",
        ),
        pytest.param(
            {}, 0, "run=true\nscenarios=true\ngates=check-ts check-scripts\n", "cell will run\n", "", id="run"
        ),
        pytest.param(
            {"scenarios": "false", "gates": "", "reason": "Scenarios not selected"},
            0,
            "run=true\nscenarios=false\ngates=\n",
            "::notice title=cell scenarios NOT RUN::Scenarios not selected\n",
            "### cell scenarios NOT RUN\nScenarios not selected This is not a pass.\n",
            id="run-without-scenarios",
        ),
        pytest.param(
            {"run": "false", "scenarios": "false", "gates": "", "reason": "--docs only"},
            0,
            "run=false\nscenarios=false\ngates=\n",
            "::notice title=cell NOT RUN::--docs only\n",
            "### cell NOT RUN\n--docs only This is not a pass.\n```text\n-n\ndocs/café `x`.md\n\n```\n",
            id="skip-with-literal-paths",
        ),
    ],
)
def test_report_preserves_runner_protocol(
    tmp_path: Path, *, decision: dict[str, str], status: int, outputs: str, stdout: str, summary: str
) -> None:
    """Compare exit status, annotations and append order for each decision."""
    output_path, summary_path = tmp_path / "output", tmp_path / "summary"
    output_path.write_bytes(b"prior=keep\n")
    summary_path.write_bytes(b"Previous summary\n")
    args = {
        "cell": "cell",
        "classify-result": "success",
        "run": "true",
        "scenarios": "true",
        "gates": "check-ts check-scripts",
        "reason": "",
        "blocked": "false",
        "changed-files": "-n\ndocs/café `x`.md\n",
    } | decision
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *(f"--{key}={value}" for key, value in args.items())],
        env=os.environ | {"GITHUB_OUTPUT": str(output_path), "GITHUB_STEP_SUMMARY": str(summary_path)},
        capture_output=True,
        check=False,
    )
    assert result.returncode == status
    assert result.stdout == stdout.encode()
    assert result.stderr == b""
    assert output_path.read_bytes() == f"prior=keep\nrun=false\n{outputs}".encode()
    assert summary_path.read_bytes() == f"Previous summary\n{summary}".encode()


def test_output_write_failure_stops_before_any_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Fail before announcing a decision if the initial fallback cannot be written."""
    summary = tmp_path / "summary"
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "missing-parent" / "output"))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    with pytest.raises(FileNotFoundError):
        ci_report_plan.report(
            cell="cell",
            classify_result="success",
            run="false",
            scenarios="false",
            gates="",
            reason="Docs only",
            blocked="false",
            changed_files="docs/x.md",
        )
    assert capsys.readouterr().out == ""
    assert not summary.exists()
