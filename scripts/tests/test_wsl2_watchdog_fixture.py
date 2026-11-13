"""Keep the hosted watchdog fixture bound to real production shell blocks.

References:
    https://github.com/nredd/pi-harness/issues/753
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wsl2_watchdog_fixture import extract_step, generate

ROOT = Path(__file__).resolve().parents[2]
ACTION = ROOT / ".github/actions/setup-ci-wsl/action.yml"
MODULE = ROOT / "scripts/wsl2_watchdog_fixture.py"


@pytest.mark.parametrize("name", ["Start WSL setup watchdog", "Stop WSL setup watchdog and report"])
def test_extraction_matches_yaml_parser(name: str) -> None:
    """The dependency-free hosted extractor must return the actual production script.

    Parameters:
        name (str): Exact production step name to compare with the YAML parser.
    """
    source = ACTION.read_text(encoding="utf-8")
    step = next(step for step in yaml.safe_load(source)["runs"]["steps"] if step.get("name") == name)
    assert extract_step(source, name) == step["run"]


@pytest.mark.parametrize(
    "source", ["", "    - name: Missing\n    - name: Missing\n", "    - name: Missing\n"]
)
def test_extraction_rejects_missing_ambiguous_or_nonliteral_steps(source: str) -> None:
    """Schema drift fails closed instead of testing a stale snapshot.

    Parameters:
        source (str): Absent, ambiguous or malformed composite step fixture.
    """
    with pytest.raises(ValueError, match=r"Expected one step named|Missing literal shell block"):
        extract_step(source, "Missing")


def test_generate_changes_only_fixture_deadline(tmp_path: Path) -> None:
    """Keep launch/stop ownership, detached creation, heartbeat and backstop unmodified.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    generate(ACTION, tmp_path / "fixture")
    source = ACTION.read_text(encoding="utf-8")
    assert (tmp_path / "fixture/launch.ps1").read_text() == extract_step(
        source, "Start WSL setup watchdog"
    ).replace("$seconds = 300", "$seconds = 12")
    assert (tmp_path / "fixture/report.ps1").read_text() == extract_step(
        source, "Stop WSL setup watchdog and report"
    )


def test_generate_rejects_changed_production_deadline(tmp_path: Path) -> None:
    """Production timeout changes need an explicit fixture update, not a silent replacement.

    Parameters:
        tmp_path (Path): Disposable action and output directory.
    """
    action = tmp_path / "action.yml"
    action.write_text(ACTION.read_text().replace("$seconds = 300", "$seconds = 500"))
    with pytest.raises(ValueError, match="Expected one production watchdog deadline"):
        generate(action, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_generate_validates_report_before_writing(tmp_path: Path) -> None:
    """An absent report step must not leave a partial generated launch script.

    Parameters:
        tmp_path (Path): Disposable malformed action and output directory.
    """
    action = tmp_path / "action.yml"
    action.write_text(ACTION.read_text().replace("Stop WSL setup watchdog and report", "Missing report"))
    destination = tmp_path / "output"
    with pytest.raises(ValueError, match="Expected one step named"):
        generate(action, destination)
    assert not destination.exists()


def test_command_line_generates_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise the same explicit-path CLI used on Windows, without invoking PowerShell locally.

    Parameters:
        tmp_path (Path): Disposable CLI output directory.
        monkeypatch (pytest.MonkeyPatch): Restored command-line argument override.
    """
    monkeypatch.setattr(sys, "argv", [str(MODULE), str(ACTION), str(tmp_path)])
    runpy.run_path(str(MODULE), run_name="__main__")
    assert (tmp_path / "launch.ps1").is_file()
    assert (tmp_path / "report.ps1").is_file()


def test_hosted_fixture_is_isolated_bounded_and_retains_only_receipts() -> None:
    """Static wiring is not a Windows pass; the native workflow executes every control case."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/wsl-watchdog.yml").read_text())
    job = workflow["jobs"]["controls"]
    assert job["runs-on"] == "windows-2025"
    assert job["timeout-minutes"] == 5
    assert workflow["permissions"] == {"contents": "read"}
    steps = job["steps"]
    assert steps[0]["with"]["persist-credentials"] is False
    cases = [step["run"].split()[-1] for step in steps if "run" in step]
    assert cases == ["Arm", "Trip", "Done", "Cancelled", "Unarmed", "Posthoc"]
    assert all(step["timeout-minutes"] <= 2 for step in steps if "run" in step)
    assert steps[-1]["if"] == "always()"
    assert steps[-1]["with"]["path"].endswith("/receipts/")
    assert steps[-1]["with"]["if-no-files-found"] == "error"
    fixture = (ROOT / "scripts/wsl2_watchdog_fixture.ps1").read_text()
    assert "CimCmdlets\\Get-CimInstance -ClassName $ClassName -Filter" in fixture
    assert "$PSBoundParameters.FilePath = $shim" in fixture
    assert "Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters" in fixture
    assert "Invoke-ExpectedReport $dir 'WSL setup was killed by its watchdog'" in fixture
    assert "Invoke-ExpectedReport $dir 'the watchdog did not trip'" in fixture
    assert "'The watchdog never armed'" in fixture
    assert "sentinelSurvived = $true" in fixture
    assert "ValueFromPipeline = $true, ValueFromRemainingArguments = $true" in fixture
    assert "Assert-WatchdogExited $dir" in fixture
