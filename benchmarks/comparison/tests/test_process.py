from __future__ import annotations

from pathlib import Path

import pytest

from pi_harness_benchmark.process import CommandError, executable, output


def test_executable_validates_name_and_missing_binary() -> None:
    assert executable("git").is_absolute()
    with pytest.raises(ValueError, match="must be a basename"):
        executable("/usr/bin/git")
    with pytest.raises(FileNotFoundError, match="not on PATH"):
        executable("benchmark-command-that-does-not-exist")


def test_output_validates_argv_and_wraps_command_failure(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="cannot be empty"):
        output([])
    with pytest.raises(ValueError, match="must be absolute"):
        output(["git", "status"])
    with pytest.raises(CommandError, match="exit code"):
        output(["/usr/bin/false"], cwd=tmp_path)
    assert output(["/bin/pwd"], cwd=tmp_path).strip() == str(tmp_path)
