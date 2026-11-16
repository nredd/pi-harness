"""Check disposable ARM64 WSL isolation as the unprivileged job user.

System Python is already required by the original policy check. PATH resolution and SMOKE_ROOT
remain fixture boundaries, as in the other measured WSL adapters. No token is inspected.
TCP probes run in a separate Python process under the original four-second timeout: DNS,
connect and process startup are all bounded. Only known network refusals/drops count as blocked;
probe execution errors do not. Public HTTP and TCP controls must succeed first.

References:
    https://github.com/nredd/pi-harness/issues/695
    https://docs.python.org/3/library/configparser.html
    https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html
"""

from __future__ import annotations

import configparser
import errno
import os
import re
import shutil
import socket
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from wsl2_exec import Runner, run_command

PRIVATE_TARGETS = (
    ("192.168.1.1", "80"),
    ("10.0.0.1", "80"),
    ("172.16.0.1", "80"),
    ("100.64.0.1", "22"),
    ("100.100.100.100", "80"),
    ("169.254.169.254", "80"),
)
MODE = re.compile(r"[0-7]{3,4}")
BLOCKED_ERRORS = {
    errno.ECONNREFUSED,
    errno.ETIMEDOUT,
    errno.ENETUNREACH,
    errno.EHOSTUNREACH,
    errno.EACCES,
    errno.EPERM,
}


def tcp(host: str, port: str) -> int:
    """Return connected (0), refused/dropped (10), or broken probe (2).

    Parameters:
        host (str): Probe address.
        port (str): Decimal TCP port.

    Returns:
        int: Classified connection outcome; the parent timeout also bounds DNS resolution.
    """
    try:
        number = int(port)
        if not 1 <= number <= 65535:
            return 2
        with socket.create_connection((host, number), timeout=4):
            return 0
    except TimeoutError:
        return 10
    except OSError as exc:
        return 10 if exc.errno in BLOCKED_ERRORS else 2
    except ValueError:
        return 2


def read(path: Path) -> str:
    """Read a kernel/policy fixture, treating missing or undecodable files as unreadable.

    Parameters:
        path (Path): Guest path.

    Returns:
        str: Contents, or an empty string on read failure.
    """
    try:
        with path.open(encoding="utf-8", newline="") as source:
            return source.read()
    except (OSError, UnicodeError):
        return ""


def disabled_policy(path: Path) -> bool:
    """Require all four explicit false settings without defaults or interpolation.

    Parameters:
        path (Path): Guest policy path.

    Returns:
        bool: Whether the strict policy parser accepts the configuration.
    """
    cfg = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=("#", ";"))
    try:
        with path.open(encoding="utf-8") as source:
            cfg.read_file(source)
        required = {"interop": ("enabled", "appendWindowsPath"), "automount": ("enabled", "mountFsTab")}
        return not cfg.defaults() and all(
            cfg.get(section, key, fallback="").strip().lower() == "false"
            for section, keys in required.items()
            for key in keys
        )
    except (OSError, UnicodeError, configparser.Error):
        return False


class Smoke:
    """Accumulate violations while preserving the original diagnostic receipt format."""

    def __init__(self, env: Mapping[str, str], run: Runner) -> None:
        """Bind only the external process and guest filesystem boundaries.

        Parameters:
            env (Mapping[str, str]): Original guest environment.
            run (Runner): Process boundary.
        """
        self.env = env
        self.run = run
        self.root = Path(env.get("SMOKE_ROOT") or "/")
        self.failed = False

    def check(self, allowed: bool, good: str, bad: str) -> None:
        """Write one receipt and accumulate failure.

        Parameters:
            allowed (bool): Whether the control passed.
            good (str): Success receipt.
            bad (str): Failure receipt.
        """
        sys.stdout.write(f"ok: {good}\n" if allowed else f"::error::{bad}\n")
        self.failed |= not allowed

    def command(self, cmd: Sequence[str]) -> tuple[int, str]:
        """Run a literal argv without exposing stderr, retaining status and output.

        Parameters:
            cmd (Sequence[str]): External command argv.

        Returns:
            tuple[int, str]: Shell-compatible status and captured stdout.
        """
        return run_command(cmd, self.run, env=self.env, capture=True, quiet=True)

    def available(self, name: str) -> bool:
        """Resolve a command using the guest PATH, including fixture stubs.

        Parameters:
            name (str): Executable name.

        Returns:
            bool: Whether the command is executable.
        """
        return shutil.which(name, path=self.env.get("PATH", "")) is not None

    def identity(self) -> None:
        """Check unprivileged ARM64 identity and both user namespace protections."""
        user = self.command(["id", "-un"])[1].strip()
        uid_status, uid = self.command(["id", "-u"])
        arch_status, arch = self.command(["uname", "-m"])
        uid, arch = uid.strip(), arch.strip()
        kernel = self.command(["uname", "-r"])[1].strip()
        sys.stdout.write(f"runner: {user} uid={uid} arch={arch} kernel={kernel}\n")
        self.check(uid_status == 0 and uid.isdecimal() and int(uid) != 0, "non-root", "running as root")
        self.check(arch_status == 0 and arch == "aarch64", "aarch64", f"not aarch64: {arch}")
        self.check(self.command(["sudo", "-n", "true"])[0] != 0, "no sudo", "sudo works")
        limit = read(self.root / "proc/sys/user/max_user_namespaces").rstrip("\n") or "unreadable"
        self.check(
            limit == "0", "user.max_user_namespaces is 0", f"user.max_user_namespaces is {limit}, not 0"
        )
        if not self.available("unshare"):
            self.check(False, "", "unshare is missing, so user namespaces cannot be checked")
        else:
            status = self.command(["unshare", "-Urn", "true"])[0]
            self.check(
                status == 1,
                "no unprivileged user namespaces",
                "unprivileged user namespaces are enabled or probe failed",
            )

    def probe(self, host: str, port: str) -> int:
        """Bound every TCP probe, including DNS and interpreter startup, to four seconds.

        Parameters:
            host (str): Target address.
            port (str): Target TCP port.

        Returns:
            int: Connected, known blocked, timeout or execution error status.
        """
        return self.command(
            ["timeout", "4", sys.executable, str(Path(__file__).resolve()), "--tcp", host, port]
        )[0]

    def network(self) -> None:
        """Calibrate public HTTP/TCP before accepting any negative reachability result."""
        public = True
        for url in ("https://api.github.com", "https://registry.npmjs.org/"):
            status = self.command(["curl", "-fsS", "--max-time", "10", "-o", "/dev/null", url])[0]
            self.check(status == 0, f"reachable: {url}", f"unreachable: {url}")
            public &= status == 0
        route_status, route = self.command(["ip", "-4", "route", "show", "default"])
        fields = route.splitlines()[0].split() if route.splitlines() else []
        gateway = fields[2] if len(fields) >= 3 and fields[:2] == ["default", "via"] else ""
        self.check(
            route_status == 0 and bool(gateway),
            "default gateway discovered",
            "default gateway cannot be checked",
        )
        targets = list(PRIVATE_TARGETS)
        if gateway:
            targets.extend((gateway, port) for port in ("445", "135", "53"))
        if host := self.env.get("SMOKE_HOST_IP"):
            targets.extend((host, port) for port in ("445", "3389", "5985"))
        ports = self.env.get("SMOKE_DEV_PORTS", "").split()
        if not ports:
            sys.stdout.write(
                "note: SMOKE_DEV_PORTS is not set on this runner, "
                "so no dev loopback or dev address ports were probed\n"
            )
        if dev := self.env.get("SMOKE_DEV_IP"):
            targets.extend((dev, port) for port in ports)
        if not self.available("timeout"):
            self.check(False, "", "timeout is missing, so no probe can prove anything")
            return
        calibrated = self.probe("api.github.com", "443") == 0
        self.check(
            calibrated,
            "public positive control connected",
            "probe machinery cannot open a public connection, so the blocked results below prove nothing",
        )
        for host, port in targets:
            status = self.probe(host, port)
            allowed = public and calibrated and status in (10, 124)
            bad = (
                f"reachable: {host}:{port}"
                if status == 0
                else f"probe failed or uncalibrated: {host}:{port} (status {status})"
            )
            self.check(allowed, f"blocked: {host}:{port}", bad)
        for port in ports:
            status = self.probe("127.0.0.1", port)
            self.check(
                public and calibrated and status in (10, 124),
                f"loopback:{port} closed",
                f"loopback:{port} answers or probe failed",
            )

    def windows(self) -> None:
        """Check IPv6, protected policy, interop residue, mounts, PATH and Windows tools."""
        self.check(
            read(self.root / "proc/sys/net/ipv6/conf/all/disable_ipv6").rstrip("\n") == "1",
            "ipv6 off",
            "ipv6 on",
        )
        self.check(
            not any((self.root / f"mnt/{drive}").exists() for drive in ("c", "d")),
            "no /mnt/c",
            "/mnt/c or /mnt/d exists",
        )
        policy = self.root / "etc/wsl.conf"
        status, output = self.command(["stat", "-c", "%u %a", str(policy)])
        fields = output.split()
        protected = (
            status == 0
            and len(fields) == 2
            and fields[0] == "0"
            and MODE.fullmatch(fields[1]) is not None
            and int(fields[1], 8) & 0o022 == 0
        )
        self.check(
            protected,
            "wsl.conf is root-owned and not group/world writable",
            "wsl.conf is missing or not protected",
        )
        self.check(
            disabled_policy(policy),
            "interop and automount are explicitly disabled",
            "wsl.conf does not explicitly disable interop and automount",
        )
        residue = False
        for name in ("WSLInterop", "WSLInterop-late"):
            entry = self.root / f"proc/sys/fs/binfmt_misc/{name}"
            if not entry.exists():
                continue
            state = read(entry).partition("\n")[0]
            if state == "disabled":
                residue = True
            else:
                self.check(False, "", f"{name} interop registration is not disabled")
        if residue:
            sys.stdout.write(
                "note: WSLInterop registration present but disabled; "
                "presence alone does not prove execution capability\n"
            )
        if list((self.root / "run/WSL").glob("*interop*")):
            sys.stdout.write(
                "note: WSL broker paths present; presence alone does not prove execution capability\n"
            )
        self.check(
            not any(part.startswith("/mnt/") for part in self.env.get("PATH", "").split(":")),
            "no Windows PATH",
            "Windows path on PATH",
        )
        for exe in ("cmd.exe", "powershell.exe", "wsl.exe", "explorer.exe"):
            self.check(not self.available(exe), f"no {exe}", f"can find {exe}")
        mount_status, mounts = self.command(["findmnt", "-t", "drvfs,9p,virtiofs"])
        self.check(
            mount_status in (0, 1) and not mounts.strip(),
            "no drvfs/9p mounts",
            "drvfs/9p mount present or probe failed",
        )


def main(
    run: Runner = subprocess.run, environ: Mapping[str, str] | None = None, argv: Sequence[str] | None = None
) -> int:
    """Run the smoke or its bounded TCP child, returning the original zero/one smoke status.

    Parameters:
        run (Runner): Injectable process boundary.
        environ (Mapping[str, str] | None): Guest environment, inherited when omitted.
        argv (Sequence[str] | None): TCP child arguments; ordinary bootstrap args remain ignored.

    Returns:
        int: Zero for passing smoke, one for violations, or classified TCP child status.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["--tcp"]:
        return tcp(args[1], args[2]) if len(args) == 3 else 2
    smoke = Smoke(dict(os.environ if environ is None else environ), run)
    smoke.identity()
    smoke.network()
    smoke.windows()
    return int(smoke.failed)


if __name__ == "__main__":
    sys.exit(main())
