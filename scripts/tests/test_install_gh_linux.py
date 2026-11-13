"""Exercise `install_gh_linux.py` in-process with an injected command runner.

References:
    https://cli.github.com/manual/gh_attestation_verify
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install_gh_linux as installer


@pytest.fixture(autouse=True)
def _restore_sigterm() -> Any:
    """`main` installs a SIGTERM handler; keep it from leaking into other tests."""
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


class Fake:
    """Scripted stand-in for `subprocess.run` that records every argv and stdin."""

    def __init__(
        self,
        *,
        system: str = "Linux",
        machine: str = "x86_64",
        failing: dict[str, int] | None = None,
        reported: str = f"gh version {installer.GH_VERSION} (2026-01-01)\nmore\n",
    ) -> None:
        """Script the host.

        Parameters:
            system (str): `uname -s` output.
            machine (str): `uname -m` output.
            failing (dict[str, int] | None): Exit status per command name (`curl`, `tar`, ...).
            reported (str): Standard output of `gh --version`.
        """
        self.fields = {"-s": system, "-m": machine}
        self.failing = failing or {}
        self.reported = reported
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, cmd: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Record one command and answer it.

        Parameters:
            cmd (Sequence[str]): Argument vector.
            **kwargs (Any): `subprocess.run` options; only `input` is recorded.

        Returns:
            subprocess.CompletedProcess[str]: Scripted result.
        """
        argv = list(cmd)
        self.calls.append((argv, kwargs.get("input")))
        name = Path(argv[0]).name
        if name == "uname":
            return subprocess.CompletedProcess(argv, 0, self.fields[argv[1]] + "\n")
        if name == "gh" and argv[1] == "--version":
            return subprocess.CompletedProcess(argv, self.failing.get("version", 0), self.reported)
        return subprocess.CompletedProcess(argv, self.failing.get(argv[0], self.failing.get(argv[1], 0)), "")

    def names(self) -> list[str]:
        """Return the executed command names in order, `uname` excluded.

        Returns:
            list[str]: Names such as `curl`, `sha256sum`, `tar`.
        """
        return [Path(argv[0]).name for argv, _ in self.calls if Path(argv[0]).name != "uname"]


@pytest.mark.parametrize("argv", [[], ["a", "b"], [""]])
def test_requires_exactly_one_non_empty_directory(
    argv: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    """Usage errors exit 2 before any command runs."""
    fake = Fake()
    assert installer.main(argv, fake) == 2
    assert "usage:" in capsys.readouterr().err
    assert not fake.calls


@pytest.mark.parametrize(("system", "machine"), [("Darwin", "arm64"), ("Linux", "riscv64")])
def test_refuses_unsupported_platforms_before_downloading(
    tmp_path: Path, system: str, machine: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Off linux/x86_64 and linux/aarch64 the installer names the platform and touches nothing."""
    fake = Fake(system=system, machine=machine)
    assert installer.main([str(tmp_path / "gh")], fake) == 1
    assert f"got {system}/{machine}" in capsys.readouterr().err
    assert fake.names() == []
    assert not (tmp_path / "gh").exists()


@pytest.mark.parametrize(
    ("machine", "arch", "digest"),
    [
        ("x86_64", "amd64", installer.GH_SHA256_AMD64),
        ("aarch64", "arm64", installer.GH_SHA256_ARM64),
        ("arm64", "arm64", installer.GH_SHA256_ARM64),
    ],
)
def test_installs_the_pinned_asset_of_the_architecture(
    tmp_path: Path, machine: str, arch: str, digest: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Download, verify the pinned digest, extract and check the installed version and `attestation`."""
    target = tmp_path / "gh"
    fake = Fake(machine=machine)
    assert installer.main([str(target)], fake) == 0
    assert fake.names() == ["curl", "sha256sum", "tar", "gh", "gh"]
    curl = fake.calls[2][0]
    archive = f"gh_{installer.GH_VERSION}_linux_{arch}.tar.gz"
    assert curl[-1] == f"https://github.com/cli/cli/releases/download/v{installer.GH_VERSION}/{archive}"
    assert curl[curl.index("--output") + 1].endswith(archive)
    assert fake.calls[3][1] == f"{digest}  {curl[curl.index('--output') + 1]}\n"
    assert "--strip-components=1" in fake.calls[4][0]
    assert fake.calls[-1][0][1:] == ["attestation", "verify", "--help"]
    assert capsys.readouterr().out == f"Installed gh {installer.GH_VERSION} at {target}/bin/gh\n"


def test_refuses_a_digest_mismatch_without_extracting(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Never extract bytes whose digest differs from the pin."""
    fake = Fake(failing={"sha256sum": 1})
    assert installer.main([str(tmp_path / "gh")], fake) == 1
    assert "sha256 mismatch" in capsys.readouterr().err
    assert "tar" not in fake.names()


@pytest.mark.parametrize(("tool", "status"), [("curl", 22), ("tar", 2), ("attestation", 5)])
def test_propagates_the_failing_tool_status(tmp_path: Path, tool: str, status: int) -> None:
    """A failing download, extraction or `attestation` probe exits with that tool's status."""
    assert installer.main([str(tmp_path / "gh")], Fake(failing={tool: status})) == status


@pytest.mark.parametrize("reported", ["gh version 2.0.0 (x)\n", "", "gh\n"])
def test_refuses_a_wrong_or_unreadable_installed_version(tmp_path: Path, reported: str) -> None:
    """The installed binary must report exactly the pinned version."""
    fake = Fake(reported=reported)
    assert installer.main([str(tmp_path / "gh")], fake) == 1
    assert fake.calls[-1][0][1:] == ["--version"]


def test_default_runner_passes_stdout_through_and_captures_on_request(tmp_path: Path) -> None:
    """`_run` drives the real `subprocess.run`, with stdin and capture honoured."""
    assert installer._run([sys.executable, "-c", "print('x')"], subprocess.run, capture=True) == (0, "x\n")
    assert installer._run([sys.executable, "-c", "import sys; sys.exit(3)"], subprocess.run) == (3, "")
    marker = tmp_path / "in"
    code = f"import sys, pathlib; pathlib.Path({str(marker)!r}).write_text(sys.stdin.read())"
    assert installer._run([sys.executable, "-c", code], subprocess.run, stdin="hi")[0] == 0
    assert marker.read_text() == "hi"


def test_a_missing_tool_exits_127_like_a_shell(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """An unstartable command reports one line and status 127 instead of a traceback."""
    missing = str(tmp_path / "no-such-tool")
    assert installer._run([missing], subprocess.run) == (127, "")
    assert "no-such-tool" in capsys.readouterr().err


def test_sigterm_handler_exits_143_like_a_shell() -> None:
    """The handler turns SIGTERM into `SystemExit(143)` so `finally`/`with` cleanup runs."""
    with pytest.raises(SystemExit) as raised:
        installer._terminate(signal.SIGTERM, None)
    assert raised.value.code == 143


def test_main_installs_the_sigterm_handler(tmp_path: Path) -> None:
    """`main` routes SIGTERM to `_terminate` before it does anything else."""
    installer.main([str(tmp_path / "gh")], Fake())
    assert signal.getsignal(signal.SIGTERM) is installer._terminate


def test_sigterm_during_download_removes_the_scratch_dir(tmp_path: Path) -> None:
    """SIGTERM mid-download (`bounded`/`timeout`) exits 143 and leaves no scratch dir, like the old trap."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    tmp_root = tmp_path / "tmp"
    tmp_root.mkdir()
    started = tmp_path / "curl.started"
    pidfile = tmp_path / "curl.pid"
    stubs = {
        "uname": '#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n',
        "curl": f"#!/bin/sh\necho $$ > {pidfile}\n: > {started}\nexec sleep 60\n",
    }
    for name, body in stubs.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "TMPDIR": str(tmp_root)}
    script = Path(installer.__file__)
    proc = subprocess.Popen([sys.executable, str(script), str(tmp_path / "gh")], env=env)
    try:
        deadline = time.monotonic() + 30
        while not started.exists():
            assert time.monotonic() < deadline, "stub curl never started"
            assert proc.poll() is None
            time.sleep(0.05)
        assert list(tmp_root.iterdir()), "scratch dir should exist while downloading"
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=30) == 143
    finally:
        proc.kill()
        proc.wait()
        with contextlib.suppress(FileNotFoundError, ProcessLookupError):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)
    assert list(tmp_root.iterdir()) == []
