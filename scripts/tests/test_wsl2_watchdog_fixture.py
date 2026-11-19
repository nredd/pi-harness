"""Keep the hosted watchdog fixture bound to real production shell blocks.

References:
    https://github.com/nredd/pi-harness/issues/753
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wsl2_watchdog_fixture import extract_step, generate

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "scripts/wsl2_watchdog_fixture.py"


@pytest.fixture
def fixture_action(tmp_path: Path) -> Path:
    """Supply a literal synthetic action now that no hosted WSL job uses this tool."""
    path = tmp_path / "fixture-action.yml"
    path.write_text(
        "    - name: Start WSL setup watchdog\n      shell: pwsh\n      run: |\n        $seconds = 300\n"
        "    - name: Stop WSL setup watchdog and report\n"
        "      shell: pwsh\n      run: |\n        Write-Output done\n"
    )
    return path


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


def test_generate_changes_only_fixture_deadline(tmp_path: Path, fixture_action: Path) -> None:
    """Keep launch/stop ownership, detached creation, heartbeat and backstop unmodified.

    Parameters:
        tmp_path (Path): Disposable output directory.
    """
    generate(fixture_action, tmp_path / "fixture")
    source = fixture_action.read_text(encoding="utf-8")
    assert (tmp_path / "fixture/launch.ps1").read_text() == extract_step(
        source, "Start WSL setup watchdog"
    ).replace("$seconds = 300", "$seconds = 12")
    assert (tmp_path / "fixture/report.ps1").read_text() == extract_step(
        source, "Stop WSL setup watchdog and report"
    )


def test_generate_rejects_changed_production_deadline(tmp_path: Path, fixture_action: Path) -> None:
    """Production timeout changes need an explicit fixture update, not a silent replacement.

    Parameters:
        tmp_path (Path): Disposable action and output directory.
    """
    action = tmp_path / "action.yml"
    action.write_text(fixture_action.read_text().replace("$seconds = 300", "$seconds = 500"))
    with pytest.raises(ValueError, match="Expected one production watchdog deadline"):
        generate(action, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_generate_validates_report_before_writing(tmp_path: Path, fixture_action: Path) -> None:
    """An absent report step must not leave a partial generated launch script.

    Parameters:
        tmp_path (Path): Disposable malformed action and output directory.
    """
    action = tmp_path / "action.yml"
    action.write_text(
        fixture_action.read_text().replace("Stop WSL setup watchdog and report", "Missing report")
    )
    destination = tmp_path / "output"
    with pytest.raises(ValueError, match="Expected one step named"):
        generate(action, destination)
    assert not destination.exists()


@pytest.mark.parametrize("directory_input", [False, True])
def test_generate_rejects_invalid_action_path(tmp_path: Path, *, directory_input: bool) -> None:
    """Reject missing or non-file inputs before creating any output.

    Parameters:
        tmp_path (Path): Disposable invalid action and destination directory.
        directory_input (bool): Whether the invalid input is an existing directory.
    """
    action = tmp_path / "action.yml"
    if directory_input:
        action.mkdir()
    with pytest.raises(FileNotFoundError, match="Action path is not a file"):
        generate(action, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_generate_rejects_non_directory_output(tmp_path: Path, fixture_action: Path) -> None:
    """Reject an existing file destination without overwriting it.

    Parameters:
        tmp_path (Path): Disposable file destination.
    """
    destination = tmp_path / "output"
    destination.write_text("preserve this fixture")
    with pytest.raises(NotADirectoryError, match="Destination is not a directory"):
        generate(fixture_action, destination)
    assert destination.read_text() == "preserve this fixture"


def test_command_line_generates_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fixture_action: Path
) -> None:
    """Exercise the same explicit-path CLI used on Windows, without invoking PowerShell locally.

    Parameters:
        tmp_path (Path): Disposable CLI output directory.
        monkeypatch (pytest.MonkeyPatch): Restored command-line argument override.
    """
    monkeypatch.setattr(sys, "argv", [str(MODULE), str(fixture_action), str(tmp_path)])
    runpy.run_path(str(MODULE), run_name="__main__")
    assert (tmp_path / "launch.ps1").is_file()
    assert (tmp_path / "report.ps1").is_file()
