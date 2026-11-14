"""Exercise the shared guest process plumbing in `wsl2_exec.py`."""

from __future__ import annotations

import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wsl2_exec import run_command, terminate


def test_run_command_passes_stdout_through_and_captures_on_request(tmp_path: Path) -> None:
    """`run_command` drives the real `subprocess.run`, with stdin and capture honoured."""
    assert run_command([sys.executable, "-c", "print('x')"], subprocess.run, capture=True) == (0, "x\n")
    assert run_command([sys.executable, "-c", "import sys; sys.exit(3)"], subprocess.run) == (3, "")
    marker = tmp_path / "in"
    code = f"import sys, pathlib; pathlib.Path({str(marker)!r}).write_text(sys.stdin.read())"
    assert run_command([sys.executable, "-c", code], subprocess.run, stdin="hi")[0] == 0
    assert marker.read_text() == "hi"


def test_run_command_gives_the_child_exactly_the_environment_it_is_handed() -> None:
    """An explicit `env` replaces the parent's; `None` inherits it."""
    code = "import os; print(os.environ.get('ONLY_HERE', 'unset'))"
    env = {"ONLY_HERE": "yes"}
    assert run_command([sys.executable, "-c", code], subprocess.run, capture=True, env=env) == (0, "yes\n")
    assert run_command([sys.executable, "-c", code], subprocess.run, capture=True) == (0, "unset\n")


def test_a_missing_tool_exits_127_like_a_shell(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """An unstartable command reports one line and status 127 instead of a traceback."""
    missing = str(tmp_path / "no-such-tool")
    assert run_command([missing], subprocess.run) == (127, "")
    assert "no-such-tool" in capsys.readouterr().err


def test_a_child_killed_by_a_signal_reports_128_plus_the_signal() -> None:
    """A negative `returncode` maps to the shell convention, so callers never see a negative status."""

    def killed(cmd: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, -signal.SIGKILL, "")

    assert run_command(["x"], killed) == (137, "")
    code = "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"
    assert run_command([sys.executable, "-c", code], subprocess.run) == (143, "")


def test_terminate_exits_with_the_shell_status_for_the_signal() -> None:
    """The handler turns SIGTERM into `SystemExit(143)` so `finally`/`with` cleanup runs."""
    with pytest.raises(SystemExit) as raised:
        terminate(signal.SIGTERM, None)
    assert raised.value.code == 143


def test_quiet_discards_stderr_and_start_failures_and_cwd_moves_the_child(
    tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    """`quiet` is `2>/dev/null` for both the child and the 127 message; `cwd` is the child's directory."""
    code = "import sys; sys.stderr.write('noise'); print('ok')"
    assert run_command([sys.executable, "-c", code], subprocess.run, capture=True, quiet=True) == (0, "ok\n")
    assert run_command([str(tmp_path / "no-such-tool")], subprocess.run, quiet=True) == (127, "")
    assert capfd.readouterr().err == ""
    pwd = "import os; print(os.getcwd())"
    status, out = run_command([sys.executable, "-c", pwd], subprocess.run, capture=True, cwd=tmp_path)
    assert (status, Path(out.strip()).resolve()) == (0, tmp_path.resolve())


def test_undecodable_output_is_kept_not_raised() -> None:
    """Kernel logs and `/proc` text can hold arbitrary bytes; they survive as surrogates."""
    code = "import sys; sys.stdout.buffer.write(b'a\\xffb')"
    assert run_command([sys.executable, "-c", code], subprocess.run, capture=True) == (0, "a\udcffb")
