"""Exercise the Forks apt script with real process deadlines and disposable sources.

References:
    https://github.com/nredd/pi-harness/issues/1067
    https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
"""

from __future__ import annotations

import contextlib
import os
import shlex
import shutil
import signal
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = "libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep"
AZURE = "http://azure.archive.ubuntu.com/ubuntu/"
TIMEOUT_FIXTURE = Path(__file__).with_name("fixtures") / "apt_timeout.py"


@pytest.fixture
def command_path(tmp_path: Path) -> str:
    """Expose only the script's required tools, excluding any host timeout.

    Parameters:
        tmp_path (Path): Disposable command directory.

    Returns:
        str: PATH for the script under test.
    """
    timeout = tmp_path / "timeout"
    command = shlex.join([sys.executable, str(TIMEOUT_FIXTURE)])
    timeout.write_text(f'#!/bin/sh\nexec {command} "$@"\n')
    timeout.chmod(0o755)
    for name in ("dirname", "env", "grep", "mktemp", "rm", "sed", "tee"):
        command_path = shutil.which(name, path=os.defpath)
        assert command_path is not None
        (tmp_path / name).symlink_to(command_path)
    return str(tmp_path)


def test_forks_apt_step_runs_unconditionally_with_budget_for_fallback() -> None:
    """Keep the shell entry point, path triggers and kill grace inside the job contract."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["core"]["steps"]
        if step.get("name", "").startswith("System dependencies")
    )
    assert "if" not in step
    assert "env" not in step
    assert step["working-directory"] == "."
    command = next(line for line in step["run"].splitlines() if line.startswith("sudo bash "))
    sudo, bash, script, source, log, update, download, install = shlex.split(command)
    assert (sudo, bash, script) == ("sudo", "bash", "scripts/forks_apt.sh")
    assert source == "/etc/apt/sources.list.d/ubuntu.sources"
    assert log == "$RUNNER_TEMP/forks-apt.log"
    assert 0 < 2 * (int(update) + int(download)) + int(install) + 50 < step["timeout-minutes"] * 60
    for event in ("push", "pull_request"):
        assert {script, "scripts/ubuntu_apt.sh"}.issubset(workflow[True][event]["paths"])


@pytest.mark.parametrize(
    ("mode", "status", "attempts", "diagnostic"),
    [
        ("success", 0, ["azure-update", "azure-download", "azure-install"], ""),
        (
            "update-error",
            0,
            ["azure-update", "stock-update", "stock-download", "stock-install"],
            f"FAILED: apt-get update ({AZURE.rstrip('/')}) (status 100)",
        ),
        (
            "download-hang",
            0,
            ["azure-update", "azure-download", "stock-update", "stock-download", "stock-install"],
            f"TIMEOUT: apt-get download ({AZURE.rstrip('/')})",
        ),
        ("both-hang", 1, ["azure-update", "stock-update"], "every mirror failed"),
        (
            "orphaned-child",
            0,
            ["azure-update", "stock-update", "stock-download", "stock-install"],
            f"FAILED: apt-get update ({AZURE.rstrip('/')}) (status 100)",
        ),
        (
            "install-error",
            47,
            ["azure-update", "azure-download", "azure-install"],
            f"FAILED: apt-get install ({AZURE.rstrip('/')}) (status 47)",
        ),
        (
            "install-hang",
            124,
            ["azure-update", "azure-download", "azure-install"],
            "TIMEOUT: apt-get install",
        ),
        (
            "install-kill",
            137,
            ["azure-update", "azure-download", "azure-install"],
            "TIMEOUT: apt-get install",
        ),
    ],
)
@pytest.mark.parametrize(
    "ubuntu_uris",
    [
        ("https://azure.archive.ubuntu.com/ubuntu", "http://security.ubuntu.com/ubuntu/"),
        ("mirror+file:/etc/apt/apt-mirrors.txt", "mirror+file:/etc/apt/apt-mirrors.txt"),
    ],
    ids=["direct", "runner-mirror-list"],
)
def test_forks_apt_retries_only_mirror_work_and_replays_output(
    tmp_path: Path,
    mode: str,
    status: int,
    attempts: list[str],
    diagnostic: str,
    *,
    command_path: str,
    ubuntu_uris: tuple[str, str],
) -> None:
    """Exercise exit propagation and enforce real deadlines with a portable timeout fixture.

    Parameters:
        tmp_path (Path): Disposable apt sources, commands and logs.
        mode (str): Stub apt behavior, including real sleeping processes.
        status (int): Expected script exit status.
        attempts (list[str]): Expected command order and selected mirrors.
        diagnostic (str): Expected failure or timeout explanation, if any.
        command_path (str): PATH with the deadline fixture.
        ubuntu_uris (tuple[str, str]): Original archive and security URIs.
    """
    sources = tmp_path / "ubuntu.sources"
    original = (
        f"Types: deb\nURIs: {ubuntu_uris[0]}\nSuites: noble noble-updates\n\n"
        f"Types: deb\nURIs: {ubuntu_uris[1]}\nSuites: noble-security\n"
    )
    sources.write_text(original)
    log = tmp_path / "apt.log"
    stub = tmp_path / "apt-get"
    stub.write_text(
        textwrap.dedent(
            """\
            #!/bin/sh
            set -eu
            selected=
            keep_lists=
            while [ "$1" = -o ]; do
                case "$2" in
                    Dir::Etc::sourcelist=*) selected=${2#*=} ;;
                    APT::Get::List-Cleanup=0) keep_lists=1 ;;
                esac
                shift 2
            done
            [ "$keep_lists" = 1 ] || exit 93
            case "$(grep -m1 '^URIs:' "$selected")" in
                'URIs: http://azure.archive.ubuntu.com/ubuntu/') mirror=azure ;;
                'URIs: http://archive.ubuntu.com/ubuntu/') mirror=stock ;;
                *) exit 90 ;;
            esac
            uri=$(grep -m1 '^URIs:' "$selected")
            [ "$(grep -Fxc "$uri" "$selected")" = 2 ] || exit 91
            grep -qx 'Suites: noble noble-updates' "$selected"
            grep -qx 'Suites: noble-security' "$selected"
            case "$*" in
                'update --error-on=any') phase=update ;;
                "install --yes --download-only $PACKAGES") phase=download ;;
                "install --yes --no-download $PACKAGES") phase=install ;;
                *) exit 92 ;;
            esac
            printf 'apt stdout: %s-%s\\n' "$mirror" "$phase"
            printf 'apt stderr: %s-%s\\n' "$mirror" "$phase" >&2
            case "$MODE:$mirror:$phase" in
                update-error:azure:update) exit 100 ;;
                orphaned-child:azure:update)
                    /bin/sleep 30 &
                    echo "$!" > "$CHILD_PID_FILE"
                    exit 100
                    ;;
                download-hang:azure:download|both-hang:*:update|install-hang:*:install) exec /bin/sleep 30 ;;
                install-error:*:install) exit 47 ;;
                install-kill:*:install) trap '' TERM; exec /bin/sleep 30 ;;
            esac
            """
        )
    )
    stub.chmod(0o755)
    child_pid_file = tmp_path / "child.pid"
    try:
        result = subprocess.run(
            ["/bin/bash", str(ROOT / "scripts/forks_apt.sh"), str(sources), str(log), "1", "1", "1"],
            capture_output=True,
            check=False,
            text=True,
            env=os.environ
            | {
                "PATH": command_path,
                "MODE": mode,
                "PACKAGES": PACKAGES,
                "CHILD_PID_FILE": str(child_pid_file),
            },
            timeout=5 if mode == "orphaned-child" else 20,
        )
        if mode == "orphaned-child":
            # The step returned while the inherited output descriptor was still open.
            os.kill(int(child_pid_file.read_text()), 0)
    finally:
        if child_pid_file.is_file():
            os.kill(int(child_pid_file.read_text()), signal.SIGKILL)
    assert result.returncode == status, result.stdout + result.stderr
    assert diagnostic in result.stderr
    if mode == "both-hang":
        assert result.stderr.count("TIMEOUT: apt-get update") == 2
    expected = [f"apt {stream}: {attempt}" for attempt in attempts for stream in ("stdout", "stderr")]
    assert log.read_text().splitlines() == expected
    assert [line for line in result.stdout.splitlines() if line.startswith("apt ")] == expected
    assert sources.read_text() == original


def test_apt_replays_after_kill_with_capture_still_open(tmp_path: Path, command_path: str) -> None:
    """Replay both streams without waiting for EOF from a surviving writer.

    Parameters:
        tmp_path (Path): Disposable files and executable shims.
        command_path (str): PATH with the deadline fixture.
    """
    pid_file = tmp_path / "holder.pid"
    log = tmp_path / "apt.log"
    capture = tmp_path / "apt-output"
    tee = tmp_path / "tee"
    tee.unlink()
    command = shlex.join([sys.executable, str(TIMEOUT_FIXTURE), "replay"])
    tee.write_text(f'#!/bin/sh\nexec {command} "$@"\n')
    tee.chmod(0o755)

    apt = tmp_path / "apt-get"
    holder = shlex.join([sys.executable, str(TIMEOUT_FIXTURE), "hold-capture"])
    apt.write_text(
        '#!/bin/bash\nset -eu\ntrap "" TERM\nprintf "apt stdout\\n"\nprintf "apt stderr\\n" >&2\n'
        f'{holder}\neval "exec $APT_FIXTURE_READY_FD>&-"\nexec /bin/sleep 86400\n'
    )
    apt.chmod(0o755)

    # Let tee try to drain only after the deadline has killed apt. A pipe then
    # reports would-block if the holder is still alive, rather than hanging.
    reader, writer = os.pipe()
    try:
        result = subprocess.run(
            [
                "/bin/bash",
                "-c",
                'set -o pipefail; source "$1"; apt_log=$2; apt_capture=$3; shift 3; '
                'apt_bounded install 1 "$@"',
                "bash",
                str(ROOT / "scripts/ubuntu_apt.sh"),
                str(log),
                str(capture),
                str(apt),
            ],
            capture_output=True,
            check=False,
            text=True,
            # The run takes ~11s (1s deadline + the 10s kill grace); bound it so a broken handshake fails.
            timeout=30,
            pass_fds=(reader, writer),
            env=os.environ
            | {
                "PATH": command_path,
                "APT_FIXTURE_CHILD_PID": str(pid_file),
                "APT_FIXTURE_REPLAY_FD": str(reader),
                "APT_FIXTURE_SIGNAL_FD": str(writer),
            },
        )
        os.kill(int(pid_file.read_text()), 0)
    finally:
        os.close(reader)
        os.close(writer)
        with contextlib.suppress(FileNotFoundError, ProcessLookupError):
            os.kill(int(pid_file.read_text()), signal.SIGKILL)
    assert result.returncode == 137, result.stderr
    assert result.stderr.splitlines() == [f"ubuntu-apt: TIMEOUT: install exceeded 1s: {apt}"]
    assert result.stdout == log.read_text() == "apt stdout\napt stderr\n"


@pytest.mark.parametrize(
    ("mode", "diagnostic"),
    [
        ("unreadable", "cannot read apt sources"),
        ("unsupported", "no supported Ubuntu mirror URI"),
        ("write-failed", "could not write apt sources"),
        ("append-failed", "could not append to"),
    ],
)
def test_forks_apt_reports_setup_and_log_io_failures(
    tmp_path: Path, command_path: str, mode: str, diagnostic: str
) -> None:
    """Fail on real filesystem errors or unknown sources; do not accept a successful apt with a broken log.

    Parameters:
        tmp_path (Path): Disposable sources, subprocess stubs, and log destination.
        command_path (str): PATH with the deadline fixture.
        mode (str): Filesystem or source failure to exercise.
        diagnostic (str): Expected explanation for the nonzero status.
    """
    sources = tmp_path / "ubuntu.sources"
    log = tmp_path / "apt.log"
    marker = tmp_path / "apt-called"
    scratch = tmp_path / "scratch"
    if mode != "unreadable":
        uri = "https://unsupported.invalid/ubuntu" if mode == "unsupported" else AZURE
        sources.write_text(f"URIs: {uri}\n")
    if mode == "append-failed":
        log.mkdir()
    if mode == "write-failed":
        (scratch / "ubuntu.sources").mkdir(parents=True)
        mktemp = tmp_path / "mktemp"
        mktemp.unlink()
        mktemp.write_text('#!/bin/sh\nprintf "%s\\n" "$FIXTURE_SCRATCH"\n')
        mktemp.chmod(0o755)
    apt = tmp_path / "apt-get"
    apt.write_text('#!/bin/sh\nprintf "apt ran\\n" >> "$FIXTURE_MARKER"\n')
    apt.chmod(0o755)
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/forks_apt.sh"), str(sources), str(log), "1", "1", "1"],
        capture_output=True,
        check=False,
        text=True,
        env=os.environ
        | {
            "PATH": command_path,
            "FIXTURE_SCRATCH": str(scratch),
            "FIXTURE_MARKER": str(marker),
        },
        timeout=15,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert diagnostic in result.stderr
    if mode == "append-failed":
        assert marker.read_text().splitlines() == ["apt ran"] * 2
        assert "FAILED: apt-get update" in result.stderr
    else:
        assert not marker.exists()
