"""Exercise isolation receipts through the smoke entry with disposable OS boundaries.

References:
    https://github.com/nredd/pi-harness/issues/695
    https://docs.python.org/3/library/socket.html
"""

from __future__ import annotations

import errno
import json
import runpy
import socket
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import wsl2_smoke as smoke
from wsl2_smoke import main

POLICY = "[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n"


class Guest:
    """Disposable guest files and recording process boundary, never a live probe."""

    def __init__(self, root: Path) -> None:
        """Create a synthetic isolated guest.

        Parameters:
            root (Path): Disposable guest filesystem root.
        """
        self.root = root
        self.env = {"SMOKE_ROOT": str(root), "PATH": str(root / "commands")}
        self.commands: list[list[str]] = []
        self.results: dict[str, tuple[int, str]] = {}
        for relative, text in {
            "etc/wsl.conf": POLICY,
            "proc/sys/user/max_user_namespaces": "0\n",
            "proc/sys/net/ipv6/conf/all/disable_ipv6": "1\n",
        }.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        for name in ("unshare", "timeout"):
            executable = root / "commands" / name
            executable.parent.mkdir(exist_ok=True)
            executable.touch(mode=0o755)

    def run(self, cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        """Return synthetic process results and retain the actual argv.

        Parameters:
            cmd (list[str]): Literal external command argv.
            _kwargs (object): Unused subprocess keyword arguments.

        Returns:
            subprocess.CompletedProcess[str]: Injected process status and stdout.
        """
        self.commands.append(cmd)
        defaults = {
            "id -un": (0, "runner\n"),
            "id -u": (0, "1001\n"),
            "uname -m": (0, "aarch64\n"),
            "uname -r": (0, "fixture\n"),
            "sudo -n true": (1, ""),
            "unshare -Urn true": (1, ""),
            "ip -4 route show default": (0, "default via 192.0.2.1 dev eth0\n"),
            f"stat -c %u %a {self.root}/etc/wsl.conf": (0, "0 644\n"),
            "findmnt -t drvfs,9p,virtiofs": (1, ""),
        }
        key = " ".join(cmd)
        if cmd[0] == "timeout":
            key = " ".join(cmd[-2:])
            default = (0 if cmd[-2] == "api.github.com" else 10, "")
        else:
            default = defaults.get(key, (0, ""))
        status, output = self.results.get(key, default)
        return subprocess.CompletedProcess(cmd, status, output)


def test_isolated_guest_passes_with_calibrated_negative_probes(tmp_path: Path) -> None:
    """All original private classes and the gateway are probed after calibration.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
    """
    guest = Guest(tmp_path)
    assert main(run=guest.run, environ=guest.env) == 0
    probes = [cmd[-2:] for cmd in guest.commands if cmd[0] == "timeout"]
    assert probes == [
        ["api.github.com", "443"],
        ["192.168.1.1", "80"],
        ["10.0.0.1", "80"],
        ["172.16.0.1", "80"],
        ["100.64.0.1", "22"],
        ["100.100.100.100", "80"],
        ["169.254.169.254", "80"],
        ["192.0.2.1", "445"],
        ["192.0.2.1", "135"],
        ["192.0.2.1", "53"],
    ]


@pytest.mark.parametrize("status", [0, 1, 2, 125, 126, 127, 137, 143])
def test_unexecuted_broken_or_reachable_negative_never_counts_as_blocked(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], status: int
) -> None:
    """Generic interpreter failures are not the distinct network-denial exit code.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        capsys (pytest.CaptureFixture[str]): Captured diagnostic receipts.
        status (int): Injected negative-probe status.
    """
    guest = Guest(tmp_path)
    guest.results["192.0.2.1 445"] = (status, "")
    assert main(run=guest.run, environ=guest.env) == 1
    assert "ok: blocked: 192.0.2.1:445" not in capsys.readouterr().out


@pytest.mark.parametrize("status", [10, 124])
def test_classified_denial_or_bounded_drop_counts_after_calibration(tmp_path: Path, status: int) -> None:
    """A calibrated engine may report network denial or the original four-second drop.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        status (int): Classified denial or timeout status.
    """
    guest = Guest(tmp_path)
    guest.results["192.0.2.1 445"] = (status, "")
    assert main(run=guest.run, environ=guest.env) == 0
    assert all(cmd[1] == "4" for cmd in guest.commands if cmd[0] == "timeout")


@pytest.mark.parametrize(
    "failure",
    [
        "api.github.com 443",
        "curl -fsS --max-time 10 -o /dev/null https://api.github.com",
        "curl -fsS --max-time 10 -o /dev/null https://registry.npmjs.org/",
    ],
)
def test_failed_public_control_invalidates_all_negative_receipts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], failure: str
) -> None:
    """Failed public HTTP or TCP makes blocked results meaningless without skipping targets.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        capsys (pytest.CaptureFixture[str]): Captured diagnostic receipts.
        failure (str): Public control command whose execution fails.
    """
    guest = Guest(tmp_path)
    guest.env |= {
        "SMOKE_HOST_IP": "198.51.100.2",
        "SMOKE_DEV_IP": "198.51.100.3",
        "SMOKE_DEV_PORTS": "22 8080",
    }
    guest.results[failure] = (2, "")
    assert main(run=guest.run, environ=guest.env) == 1
    output = capsys.readouterr().out
    assert "ok: blocked:" not in output
    assert "loopback:8080 closed" not in output
    probes = [cmd[-2:] for cmd in guest.commands if cmd[0] == "timeout"]
    assert ["198.51.100.2", "5985"] in probes
    assert ["198.51.100.3", "8080"] in probes
    assert probes[-2:] == [["127.0.0.1", "22"], ["127.0.0.1", "8080"]]


@pytest.mark.parametrize("missing", ["timeout", "unshare"])
def test_missing_control_command_refuses(tmp_path: Path, missing: str) -> None:
    """Missing executables cannot masquerade as denied network or namespaces.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        missing (str): Executable to remove from the fixture PATH.
    """
    guest = Guest(tmp_path)
    (tmp_path / "commands" / missing).unlink()
    assert main(run=guest.run, environ=guest.env) == 1
    if missing == "timeout":
        assert not any(cmd[0] == "timeout" for cmd in guest.commands)


@pytest.mark.parametrize(
    ("cmd", "status", "output"),
    [
        ("id -u", 0, "0\n"),
        ("id -u", 127, ""),
        ("id -u", 0, "not-a-uid"),
        ("uname -m", 0, "x86_64\n"),
        ("uname -m", 127, "aarch64\n"),
        ("sudo -n true", 0, ""),
        ("unshare -Urn true", 0, ""),
        ("unshare -Urn true", 127, ""),
        ("ip -4 route show default", 127, ""),
        ("ip -4 route show default", 0, "default dev eth0\n"),
        ("findmnt -t drvfs,9p,virtiofs", 0, "mount\n"),
        ("findmnt -t drvfs,9p,virtiofs", 127, ""),
    ],
)
def test_identity_namespace_route_and_mount_failures_refuse(
    tmp_path: Path, cmd: str, status: int, output: str
) -> None:
    """Run every denial/control through the whole smoke without any real command.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        cmd (str): Control command to override.
        status (int): Injected process exit status.
        output (str): Injected process stdout.
    """
    guest = Guest(tmp_path)
    guest.results[cmd] = (status, output)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize("mode", ["", "1001 644", "0 664", "0 646", "0 invalid", "0 10000", "0 644 extra"])
def test_unprotected_policy_refuses(tmp_path: Path, mode: str) -> None:
    """Protection evidence must be complete, octal, root-owned and non-writable.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        mode (str): Injected stat ownership and permission evidence.
    """
    guest = Guest(tmp_path)
    guest.results[f"stat -c %u %a {tmp_path}/etc/wsl.conf"] = (0, mode)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize(
    "policy",
    [
        "not ini",
        "[interop]\nenabled=false\n",
        POLICY.replace("enabled=false", "enabled=true"),
        POLICY.replace("appendWindowsPath=false", "appendWindowsPath=true"),
        POLICY.replace("mountFsTab=false", "mountFsTab=true"),
        POLICY.replace("enabled=false", "enabled=off"),
        POLICY.replace("enabled=false", "enabled=no"),
        POLICY.replace("enabled=false", "enabled=0"),
        POLICY + "[interop]\nenabled=false\n",
        POLICY + "[DEFAULT]\nunused=false\n",
        "[DEFAULT]\nenabled=false\nappendWindowsPath=false\nmountFsTab=false\n[interop]\n[automount]\n",
        POLICY.replace("enabled=false", "enabled=%(disabled)s"),
    ],
)
def test_strict_policy_denials_through_entry(tmp_path: Path, policy: str) -> None:
    """No inherited, interpolated, malformed or alternate boolean policy passes.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        policy (str): Invalid or enabled WSL policy contents.
    """
    guest = Guest(tmp_path)
    (tmp_path / "etc/wsl.conf").write_text(policy)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize("policy", [None, b"\xff"])
def test_missing_or_undecodable_policy_refuses(tmp_path: Path, policy: bytes | None) -> None:
    """File errors do not bypass the protected policy requirement.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        policy (bytes | None): Invalid bytes, or None for a missing policy.
    """
    guest = Guest(tmp_path)
    path = tmp_path / "etc/wsl.conf"
    if policy is None:
        path.unlink()
    else:
        path.write_bytes(policy)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize(
    "entry", ["proc/sys/user/max_user_namespaces", "proc/sys/net/ipv6/conf/all/disable_ipv6"]
)
@pytest.mark.parametrize("content", [None, b"\xff", b"2\n"])
def test_unreadable_or_wrong_sysctl_refuses(tmp_path: Path, entry: str, content: bytes | None) -> None:
    """Missing, undecodable and unexpected sysctl values fail closed.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        entry (str): Relative sysctl file to alter.
        content (bytes | None): Replacement bytes, or None to remove the entry.
    """
    guest = Guest(tmp_path)
    path = tmp_path / entry
    if content is None:
        path.unlink()
    else:
        path.write_bytes(content)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize("content", [b"enabled\n", b"", b"disabled \n", b"disabled\r\n", b"\xff"])
def test_exact_disabled_first_line_required(tmp_path: Path, content: bytes) -> None:
    """Preserve the shell's exact first-line semantics, including carriage returns.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        content (bytes): Registration bytes that must not count as disabled.
    """
    guest = Guest(tmp_path)
    entry = tmp_path / "proc/sys/fs/binfmt_misc/WSLInterop"
    entry.parent.mkdir(parents=True)
    entry.write_bytes(content)
    assert main(run=guest.run, environ=guest.env) == 1


def test_residual_disabled_plumbing_is_only_a_note(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Both disabled registrations and broker sockets stay nonblocking diagnostics.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        capsys (pytest.CaptureFixture[str]): Captured diagnostic receipts.
    """
    guest = Guest(tmp_path)
    for name in ("WSLInterop", "WSLInterop-late"):
        entry = tmp_path / "proc/sys/fs/binfmt_misc" / name
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("disabled\ninterpreter /init\n")
    broker = tmp_path / "run/WSL/17_interop"
    broker.parent.mkdir(parents=True)
    broker.touch()
    assert main(run=guest.run, environ=guest.env) == 0
    assert "note: WSL broker paths present" in capsys.readouterr().out


@pytest.mark.parametrize("leak", ["c", "d", "PATH", "cmd.exe", "powershell.exe", "wsl.exe", "explorer.exe"])
def test_windows_reachability_refuses(tmp_path: Path, leak: str) -> None:
    """All original Windows mount, executable and PATH checks remain blocking.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        leak (str): Windows mount, path or executable to expose in the fixture.
    """
    guest = Guest(tmp_path)
    if leak in ("c", "d"):
        (tmp_path / f"mnt/{leak}").mkdir(parents=True)
    elif leak == "PATH":
        guest.env["PATH"] += ":/mnt/c/Windows"
    else:
        (tmp_path / "commands" / leak).touch(mode=0o755)
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize("status", [0, 2, 127])
def test_loopback_connection_or_engine_failure_refuses(tmp_path: Path, status: int) -> None:
    """Dev ports always include loopback even with no dev address configured.

    Parameters:
        tmp_path (Path): Disposable guest filesystem root.
        status (int): Reachable or broken loopback-probe status.
    """
    guest = Guest(tmp_path)
    guest.env["SMOKE_DEV_PORTS"] = "8080"
    guest.results["127.0.0.1 8080"] = (status, "")
    assert main(run=guest.run, environ=guest.env) == 1


@pytest.mark.parametrize("port", ["0", "65536", "bad"])
def test_invalid_tcp_port_is_engine_failure(port: str) -> None:
    """Invalid targets refuse before calling the socket boundary.

    Parameters:
        port (str): Invalid TCP port supplied to the child entry.
    """
    assert main(argv=["--tcp", "192.0.2.1", port]) == 2


@pytest.mark.parametrize("args", [["--tcp"], ["--tcp", "192.0.2.1"], ["--tcp", "192.0.2.1", "80", "extra"]])
def test_tcp_child_arity_refuses(args: list[str]) -> None:
    """Malformed internal argv cannot trigger a complete smoke or a network call.

    Parameters:
        args (list[str]): Incomplete or overlong child argv.
    """
    assert main(argv=args) == 2


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (TimeoutError(), 10),
        (ConnectionRefusedError(errno.ECONNREFUSED, "fixture"), 10),
        (OSError(errno.ENETUNREACH, "fixture"), 10),
        (OSError(errno.EHOSTUNREACH, "fixture"), 10),
        (OSError(errno.ETIMEDOUT, "fixture"), 10),
        (PermissionError(errno.EACCES, "fixture"), 10),
        (PermissionError(errno.EPERM, "fixture"), 10),
        (socket.gaierror(-2, "fixture"), 2),
        (OSError(errno.EMFILE, "fixture"), 2),
        (ValueError("fixture"), 2),
    ],
)
def test_socket_denial_is_distinct_from_execution_failure(
    monkeypatch: pytest.MonkeyPatch, error: Exception, status: int
) -> None:
    """Only a known network outcome is accepted as denial; no real socket is opened.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Socket boundary replacement.
        error (Exception): Injected socket failure.
        status (int): Expected classified child status.
    """

    def connect(_address: tuple[str, int], *, timeout: int) -> None:
        """Raise the injected socket error instead of connecting.

        Parameters:
            _address (tuple[str, int]): Unused synthetic target.
            timeout (int): Required socket timeout.

        Raises:
            Exception: The parametrized boundary error.
        """
        assert timeout == 4
        raise error

    monkeypatch.setattr(socket, "create_connection", connect)
    assert main(argv=["--tcp", "192.0.2.1", "80"]) == status


def test_tcp_success_and_executable_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the actual module entry with a disposable socket boundary and exact argv.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Socket and process argv replacement.
    """

    class Connection:
        """Model an open connection without creating a socket."""

        def __enter__(self) -> Connection:
            """Enter the synthetic connection context.

            Returns:
                Connection: This disposable context.
            """
            return self

        def __exit__(self, *_args: object) -> None:
            """Leave the synthetic context without suppressing errors.

            Parameters:
                _args (object): Unused context-manager exception arguments.
            """

    def connect(address: tuple[str, int], *, timeout: int) -> Connection:
        """Verify the socket boundary and return a synthetic open connection.

        Parameters:
            address (tuple[str, int]): Expected synthetic address and port.
            timeout (int): Required socket timeout.

        Returns:
            Connection: Synthetic open connection context.
        """
        assert address == ("192.0.2.1", 80)
        assert timeout == 4
        return Connection()

    monkeypatch.setattr(socket, "create_connection", connect)
    monkeypatch.setattr(sys, "argv", ["wsl2_smoke.py", "--tcp", "192.0.2.1", "80"])
    with pytest.raises(SystemExit) as result:
        runpy.run_path(str(Path(smoke.__file__)), run_name="__main__")
    assert result.value.code == 0


def test_bootstrap_preserves_argv_environment_and_exit_status(tmp_path: Path) -> None:
    """Execute the real shell entry with an injected interpreter, never any guest probe.

    Parameters:
        tmp_path (Path): Disposable interpreter directory.
    """
    interpreter = tmp_path / "python3"
    interpreter.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "print(json.dumps([sys.argv[1:], os.environ['SMOKE_FIXTURE']]))\n"
        "sys.exit(37)\n"
    )
    interpreter.chmod(0o755)
    args = ["space argument", "; never execute", "--flag"]
    result = subprocess.run(
        ["/bin/bash", str(Path(smoke.__file__).with_suffix(".sh")), *args],
        env={"PATH": f"{tmp_path}:/usr/bin:/bin", "SMOKE_FIXTURE": "preserved"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 37
    actual_argv, marker = json.loads(result.stdout)
    assert Path(actual_argv[0]).resolve() == Path(smoke.__file__).resolve()
    assert actual_argv[1:] == args
    assert marker == "preserved"
