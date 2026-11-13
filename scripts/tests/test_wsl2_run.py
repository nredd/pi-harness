"""Exercise `wsl2_run.py`, the guest execution boundary, with real Bash steps in disposable checkouts."""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import time
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import wsl2_run as adapter


@pytest.fixture(autouse=True)
def _isolate_process_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """`main` installs a SIGTERM handler and the adapter changes directory; restore both."""
    monkeypatch.chdir(Path.cwd())
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


class Host:
    """Scripted `subprocess.run` that answers `id -u` and delegates everything else to the real one."""

    def __init__(self, uid: str = "1000") -> None:
        """Script the user id.

        Parameters:
            uid (str): `id -u` output.
        """
        self.uid = uid

    def __call__(self, cmd: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Answer `id` and run any other command for real.

        Parameters:
            cmd (Sequence[str]): Argument vector.
            **kwargs (Any): `subprocess.run` options.

        Returns:
            subprocess.CompletedProcess[str]: The scripted or real result.
        """
        if cmd[0] == "id":
            return subprocess.CompletedProcess(list(cmd), 0, f"{self.uid}\n")
        return subprocess.run(list(cmd), check=False, **{k: v for k, v in kwargs.items() if k != "check"})


@pytest.fixture
def guest(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """Build a guest checkout under a HOME containing a space, plus the adapter environment."""
    home = tmp_path / "guest home"
    worktree = home / "pi-harness-ci"
    (worktree / "integration").mkdir(parents=True)
    (worktree / ".ci-temp").mkdir()
    (worktree / ".ci-temp/tool-path").write_text(os.environ["PATH"] + "\n")
    step = tmp_path / "github-step"
    step.write_text("true\n")
    env = {
        "HOME": str(home),
        "PATH": os.environ["PATH"],
        "WSL_STEP_SCRIPT": str(step),
        "WSL_STEP_DIRECTORY": "integration",
        "GH_TOKEN": "synthetic-sentinel",
    }
    return worktree, env


def first_failure(worktree: Path) -> str | None:
    """Return the recorded first-failure status text.

    Parameters:
        worktree (Path): Guest checkout containing `.ci-temp`.

    Returns:
        str | None: The text, or `None` when none was written.
    """
    path = worktree / ".ci-temp/first-failure"
    return path.read_text() if path.exists() else None


@pytest.mark.parametrize("status", [0, 47])
def test_runs_the_step_in_the_guest_checkout_and_retains_failures(
    guest: tuple[Path, dict[str, str]], status: int, capfd: pytest.CaptureFixture[str]
) -> None:
    """CRLF, guest cwd and temp, forwarded environment, first-failure record and step cleanup."""
    worktree, env = guest
    out = worktree.parent / "out"
    env["OUT"] = str(out)
    Path(env["WSL_STEP_SCRIPT"]).write_bytes(
        (
            'test "$PWD" = "$GITHUB_WORKSPACE/integration"\r\n'
            'test "$RUNNER_TEMP" = "$GITHUB_WORKSPACE/.ci-temp"\r\n'
            'echo "$GH_TOKEN" > "$OUT"\r\n'
            f"exit {status}\r\n"
        ).encode()
    )
    original = Path(env["WSL_STEP_SCRIPT"]).read_bytes()
    assert adapter.main(Host(), env) == status
    assert out.read_text() == "synthetic-sentinel\n"
    assert Path(env["WSL_STEP_SCRIPT"]).read_bytes() == original
    assert first_failure(worktree) == (f"{status}\n" if status else None)
    assert list((worktree / ".ci-temp").glob("step.*")) == []
    err = capfd.readouterr().err
    assert (f"wsl2-run: guest-step failed with status {status}" in err) is bool(status)


def test_the_first_failure_is_never_overwritten(guest: tuple[Path, dict[str, str]]) -> None:
    """A later failing step must not replace the status of the first one."""
    worktree, env = guest
    (worktree / ".ci-temp/first-failure").write_text("11\n")
    Path(env["WSL_STEP_SCRIPT"]).write_text("exit 3\n")
    assert adapter.main(Host(), env) == 3
    assert first_failure(worktree) == "11\n"


def test_the_step_runs_with_the_receipt_path_not_the_adapters(guest: tuple[Path, dict[str, str]]) -> None:
    """`PATH` for the step is the `tool-path` receipt, trailing newline stripped."""
    worktree, env = guest
    out = worktree.parent / "path"
    env["OUT"] = str(out)
    (worktree / ".ci-temp/tool-path").write_text(f"{Path('/bin')}:{os.environ['PATH']}\n\n")
    Path(env["WSL_STEP_SCRIPT"]).write_text('printf %s "$PATH" > "$OUT"\n')
    assert adapter.main(Host(), env) == 0
    assert out.read_text() == f"/bin:{os.environ['PATH']}"


def test_a_step_killed_by_a_signal_reports_the_shell_status(guest: tuple[Path, dict[str, str]]) -> None:
    """Death by SIGTERM is 143 in the first-failure record, not a negative number."""
    worktree, env = guest
    Path(env["WSL_STEP_SCRIPT"]).write_text("kill -TERM $$\n")
    assert adapter.main(Host(), env) == 143
    assert first_failure(worktree) == "143\n"


@pytest.mark.parametrize("directory", ["..", "../escape", "integration/../..", "escape-link"])
def test_refuses_an_escaping_directory(
    guest: tuple[Path, dict[str, str]], directory: str, capfd: pytest.CaptureFixture[str]
) -> None:
    """`..`, nested traversal and a symlink out of the checkout all fail before the step runs."""
    worktree, env = guest
    (worktree / "escape-link").symlink_to(worktree.parent.parent, target_is_directory=True)
    env["WSL_STEP_DIRECTORY"] = directory
    Path(env["WSL_STEP_SCRIPT"]).write_text("echo unexpected-gate\n")
    assert adapter.main(Host(), env) == 1
    captured = capfd.readouterr()
    assert "escapes guest checkout" in captured.err
    assert "unexpected-gate" not in captured.out
    assert first_failure(worktree) == "1\n"


def test_refuses_an_unavailable_directory(
    guest: tuple[Path, dict[str, str]], capfd: pytest.CaptureFixture[str]
) -> None:
    """A directory that does not exist is refused with the same boundary message."""
    _, env = guest
    env["WSL_STEP_DIRECTORY"] = "no-such-directory"
    assert adapter.main(Host(), env) == 1
    assert "escapes guest checkout or is unavailable" in capfd.readouterr().err


def test_the_checkout_root_itself_is_a_valid_step_directory(guest: tuple[Path, dict[str, str]]) -> None:
    """`.` stays inside the checkout."""
    _, env = guest
    env["WSL_STEP_DIRECTORY"] = "."
    assert adapter.main(Host(), env) == 0


def test_refuses_root_before_the_step_runs(
    guest: tuple[Path, dict[str, str]], capfd: pytest.CaptureFixture[str]
) -> None:
    """Privileged execution is refused, and the refusal is itself the first failure."""
    worktree, env = guest
    Path(env["WSL_STEP_SCRIPT"]).write_text("echo unexpected-gate\n")
    assert adapter.main(Host(uid="0"), env) == 1
    captured = capfd.readouterr()
    assert "unprivileged Linux user" in captured.err
    assert "unexpected-gate" not in captured.out
    assert first_failure(worktree) == "1\n"


@pytest.mark.parametrize("content", [None, ""])
def test_a_missing_or_empty_tool_receipt_is_recorded(
    guest: tuple[Path, dict[str, str]], content: str | None
) -> None:
    """Preflight failure of the toolchain receipt is retained as the first failure."""
    worktree, env = guest
    receipt = worktree / ".ci-temp/tool-path"
    if content is None:
        receipt.unlink()
    else:
        receipt.write_text(content)
    assert adapter.main(Host(), env) == 1
    assert first_failure(worktree) == "1\n"


@pytest.mark.parametrize("name", ["HOME", "WSL_STEP_DIRECTORY", "WSL_STEP_SCRIPT"])
def test_a_missing_input_is_a_failure_not_a_default(
    guest: tuple[Path, dict[str, str]], name: str, capfd: pytest.CaptureFixture[str]
) -> None:
    """Unset inputs fail closed with a message naming the variable."""
    worktree, env = guest
    del env[name]
    assert adapter.main(Host(), env) == 1
    assert f"`{name}` is not set" in capfd.readouterr().err
    assert first_failure(worktree) == (None if name == "HOME" else "1\n")


def test_an_unreadable_step_is_one_line_and_status_1(
    guest: tuple[Path, dict[str, str]], capfd: pytest.CaptureFixture[str]
) -> None:
    """A step file that cannot be read reports the OS error instead of a traceback."""
    worktree, env = guest
    env["WSL_STEP_SCRIPT"] = str(worktree.parent / "missing-step")
    assert adapter.main(Host(), env) == 1
    assert "wsl2-run:" in capfd.readouterr().err


def test_a_missing_runner_temp_cannot_mask_the_failure(tmp_path: Path) -> None:
    """Recording the first failure is best effort: no `.ci-temp` still yields the preflight status."""
    env = {"HOME": str(tmp_path), "PATH": os.environ["PATH"]}
    assert adapter.main(Host(), env) == 1
    assert list(tmp_path.iterdir()) == []


def test_main_reads_the_process_environment_by_default(
    guest: tuple[Path, dict[str, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without an injected environment `os.environ` is used."""
    _, env = guest
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert adapter.main(Host()) == 0


def test_an_unstartable_bash_exits_127_and_is_recorded(guest: tuple[Path, dict[str, str]]) -> None:
    """A receipt PATH without Bash is a clear failure, not a traceback."""
    worktree, env = guest
    (worktree / ".ci-temp/tool-path").write_text(str(worktree.parent / "empty"))
    assert adapter.main(Host(), env) == 127
    assert first_failure(worktree) == "127\n"


def test_sigterm_records_the_failure_and_removes_the_step(guest: tuple[Path, dict[str, str]]) -> None:
    """SIGTERM mid-step (`timeout`, cancel) exits 143, keeps first-failure, leaves no step file."""
    worktree, env = guest
    stubs = worktree.parent / "bin"
    stubs.mkdir()
    (stubs / "id").write_text("#!/bin/sh\necho 1000\n")
    (stubs / "id").chmod(0o755)
    pidfile = worktree.parent / "step.pid"
    started = worktree.parent / "step.started"
    Path(env["WSL_STEP_SCRIPT"]).write_text(f'echo $$ > "{pidfile}"\n: > "{started}"\nexec sleep 60\n')
    env["PATH"] = f"{stubs}{os.pathsep}{os.environ['PATH']}"
    proc = subprocess.Popen([sys.executable, adapter.__file__], env={**os.environ, **env})
    try:
        deadline = time.monotonic() + 30
        while not started.exists():
            assert time.monotonic() < deadline, "step never started"
            assert proc.poll() is None
            time.sleep(0.05)
        assert list((worktree / ".ci-temp").glob("step.*")), "step copy should exist while running"
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=30) == 143
    finally:
        proc.kill()
        proc.wait()
        with contextlib.suppress(FileNotFoundError, ProcessLookupError, ValueError):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)
    assert first_failure(worktree) == "143\n"
    assert list((worktree / ".ci-temp").glob("step.*")) == []
