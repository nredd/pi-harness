"""Bootstrap WSL tools after apt has installed system Python, without running gates.

Hosted checkouts are copied from Windows to ext4. In-guest runners reuse matching baked tools.
Commands deliberately resolve through PATH, as in the other measured WSL adapters and fixtures.
No GH_TOKEN is forwarded to any child. The shell entry remains for existing workflow callers.

References:
    https://github.com/nredd/pi-harness/issues/695
    https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from install_gh_linux import GH_VERSION
from wsl2_exec import Runner, run_command

UV_VERSION = "0.13.1"


class SetupFailure(Exception):
    """Carry the original command status out of bootstrap."""

    def __init__(self, status: int) -> None:
        """Retain the shell-compatible status.

        Parameters:
            status (int): Failing command status.
        """
        self.status = status
        super().__init__(status)


def command(
    cmd: Sequence[str],
    run: Runner,
    env: dict[str, str],
    cwd: Path | None = None,
    *,
    label: str = "",
    seconds: int = 60,
    capture: bool = False,
) -> str:
    """Execute a command, retaining its status and bounded-command diagnostics.

    Parameters:
        cmd (Sequence[str]): Original argv.
        run (Runner): Process boundary.
        env (dict[str, str]): Credential-free environment.
        cwd (Path | None): Guest working directory.
        label (str): Nonempty for a bounded command.
        seconds (int): Timeout bound.
        capture (bool): Capture stdout.

    Returns:
        str: Captured stdout.

    Raises:
        SetupFailure: On a nonzero command status.
    """
    argv = ["timeout", "--kill-after=10", str(seconds), *cmd] if label else list(cmd)
    status, output = run_command(argv, run, env=env, cwd=cwd, capture=capture)
    if status:
        if label:
            if status in (124, 137):
                sys.stderr.write(f"wsl2-setup: TIMEOUT: {label} exceeded {seconds}s: {' '.join(cmd)}\n")
                sys.stderr.write("wsl2-setup: guest processes, newest first:\n")
                _, processes = run_command(
                    ["ps", "-eo", "pid,ppid,etime,stat,args", "--sort=etime"],
                    run,
                    env=env,
                    capture=True,
                )
                sys.stderr.write("\n".join(processes.splitlines()[:40]) + "\n")
            else:
                sys.stderr.write(f"wsl2-setup: FAILED: {label} (status {status}): {' '.join(cmd)}\n")
        raise SetupFailure(status)
    return output


def baked(expected: str, cmd: Sequence[str], run: Runner, env: dict[str, str], cwd: Path) -> bool:
    """Probe a baked tool only in guest mode, accepting an optional version suffix.

    Parameters:
        expected (str): Exact version prefix.
        cmd (Sequence[str]): Probe argv.
        run (Runner): Process boundary.
        env (dict[str, str]): Guest environment.
        cwd (Path): Checkout.

    Returns:
        bool: Whether the first line matches.
    """
    if env.get("PI_WSL2_IN_GUEST") != "1":
        return False
    status, output = run_command(cmd, run, env=env, cwd=cwd, capture=True, quiet=True)
    first = output.splitlines()[0] if output.splitlines() else ""
    return status == 0 and (first == expected or first.startswith(expected + " "))


def execute(env: dict[str, str], run: Runner) -> None:
    """Prepare the checkout, install mismatched tools and publish path/identity receipts.

    Parameters:
        env (dict[str, str]): Mutable credential-free guest environment.
        run (Runner): Process boundary.

    Raises:
        ValueError: On a refused precondition or mismatched installed version.
        SetupFailure: On an external command failure.
        OSError: On filesystem failure.
        KeyError: On a missing required environment value.
    """
    if command(["id", "-u"], run, env, capture=True).strip() == "0":
        raise ValueError("WSL gates require an unprivileged Linux user")
    arch = command(["uname", "-m"], run, env, capture=True).strip()
    if arch not in ("x86_64", "aarch64", "arm64"):
        raise ValueError(f"wsl2-setup: unsupported architecture {arch}")
    node_arch = "x64" if arch == "x86_64" else "arm64"
    guest = env.get("PI_WSL2_IN_GUEST") == "1"
    home = Path(env["HOME"])
    if guest:
        worktree = Path(env["GITHUB_WORKSPACE"])
        if not (worktree / ".git").exists():
            raise ValueError("Guest checkout has no `.git`")
    else:
        source = env["WSL_HOST_WORKSPACE"]
        if not source.startswith("/mnt/"):
            raise ValueError("Expected Windows source below /mnt")
        worktree = home / "pi-harness-ci"
        worktree.mkdir(parents=True, exist_ok=False)
        command(["cp", "-a", f"{source}/.", str(worktree)], run, env, label="copy checkout")
    filesystem = "".join(
        command(
            ["findmnt", "--noheadings", "--output", "FSTYPE", "--target", str(worktree)],
            run,
            env,
            capture=True,
        ).split()
    )
    if filesystem in ("drvfs", ""):
        raise ValueError("Harness worktree is not on a Linux filesystem")
    tool_dir = home / ".cache/pi-harness-wsl2-tools"
    tool_dir.mkdir(parents=True, exist_ok=True)

    def prepend(directory: Path) -> None:
        """Prepend a tool directory to the child PATH.

        Parameters:
            directory (Path): Tool directory.
        """
        env["PATH"] = f"{directory}:{env['PATH']}"

    def call(cmd: Sequence[str], *, label: str = "", seconds: int = 60) -> str:
        """Execute an argv in the checkout.

        Parameters:
            cmd (Sequence[str]): Command argv.
            label (str): Bound label.
            seconds (int): Timeout.

        Returns:
            str: Captured stdout for probes.
        """
        return command(cmd, run, env, worktree, label=label, seconds=seconds, capture=not label)

    def fetch(url: str, target: Path) -> None:
        """Download with per-attempt and overall bounds.

        Parameters:
            url (str): Public download URL.
            target (Path): Output path.
        """
        call(
            [
                "curl",
                "--fail",
                "--location",
                "--retry",
                "3",
                "--connect-timeout",
                "15",
                "--max-time",
                "45",
                "--output",
                str(target),
                url,
            ],
            label=f"download {url}",
            seconds=180,
        )

    install_node(env, run, worktree, tool_dir, node_arch, call=call, fetch=fetch, prepend=prepend)
    install_other_tools(env, run, worktree, tool_dir, call=call, fetch=fetch, prepend=prepend)
    install_owned(env, run, worktree, tool_dir, call)
    prepend(tool_dir / "gh/bin")
    receipts(env, worktree, filesystem, call)


Call = Callable[..., str]
Fetch = Callable[[str, Path], None]
Prepend = Callable[[Path], None]


def install_node(
    env: dict[str, str],
    run: Runner,
    worktree: Path,
    tool_dir: Path,
    node_arch: str,
    *,
    call: Call,
    fetch: Fetch,
    prepend: Prepend,
) -> None:
    """Install Node and npm, preserving user-owned npm prefixes.

    Parameters:
        env (dict[str, str]): Guest environment.
        run (Runner): Process boundary.
        worktree (Path): Checkout.
        tool_dir (Path): Tool cache.
        node_arch (str): Node architecture.
        call (Call): Checkout command boundary.
        fetch (Fetch): Bounded downloader.
        prepend (Prepend): PATH mutator.
    """
    node_version = (worktree / ".node-version").read_text().replace("\r", "").replace("\n", "")
    node_dir = tool_dir / f"node-v{node_version}-linux-{node_arch}"
    archive = node_dir.with_name(node_dir.name + ".tar.xz")
    node = node_dir / "bin/node"
    if os.access(node, os.X_OK):
        prepend(node.parent)
    if not baked(f"v{node_version}", ["node", "--version"], run, env, worktree):
        fetch(f"https://nodejs.org/dist/v{node_version}/{archive.name}", archive)
        call(
            ["tar", "--extract", "--xz", "--file", str(archive), "--directory", str(tool_dir)],
            label="extract node",
        )
        prepend(node.parent)
    if call(["node", "--version"]).rstrip("\n") != f"v{node_version}":
        raise ValueError("Node version mismatch")
    package_manager = call(["node", "-p", 'require("./package.json").packageManager']).rstrip("\n")
    npm_version = package_manager.partition("@")[2].partition("+")[0]
    if not baked(npm_version, ["npm", "--version"], run, env, worktree):
        prefix = tool_dir / "npm"
        prefix.mkdir(exist_ok=True)
        call(
            ["env", f"npm_config_prefix={prefix}", "npm", "install", "--global", package_manager],
            label="install npm",
        )
        prepend(prefix / "bin")


def install_other_tools(
    env: dict[str, str],
    run: Runner,
    worktree: Path,
    tool_dir: Path,
    *,
    call: Call,
    fetch: Fetch,
    prepend: Prepend,
) -> None:
    """Install Bun, uv and gh when baked versions do not match.

    Parameters:
        env (dict[str, str]): Guest environment.
        run (Runner): Process boundary.
        worktree (Path): Checkout.
        tool_dir (Path): Tool cache.
        call (Call): Checkout command boundary.
        fetch (Fetch): Bounded downloader.
        prepend (Prepend): PATH mutator.
    """
    home = Path(env["HOME"])
    bun_version = (worktree / ".bun-version").read_text().replace("\r", "").replace("\n", "")
    env["BUN_INSTALL"] = str(tool_dir / "bun")
    prepend(home / ".bun/bin")
    prepend(tool_dir / "bun/bin")
    if not baked(bun_version, ["bun", "--version"], run, env, worktree):
        fetch("https://bun.sh/install", tool_dir / "bun-install.sh")
        call(["bash", str(tool_dir / "bun-install.sh"), f"bun-v{bun_version}"], label="install bun")
    if call(["bun", "--version"]).rstrip("\n") != bun_version:
        raise ValueError("Bun version mismatch")
    prepend(home / ".local/bin")
    if not baked(f"uv {UV_VERSION}", ["uv", "--version"], run, env, worktree):
        fetch(f"https://astral.sh/uv/{UV_VERSION}/install.sh", tool_dir / "uv-install.sh")
        call(["sh", str(tool_dir / "uv-install.sh")], label="install uv")
    if not call(["uv", "--version"]).rstrip("\n").startswith(f"uv {UV_VERSION}"):
        raise ValueError("uv version mismatch")
    if not baked(f"gh version {GH_VERSION}", [str(tool_dir / "gh/bin/gh"), "--version"], run, env, worktree):
        call(["bash", "scripts/install_gh_linux.sh", str(tool_dir / "gh")], label="install gh")


def install_owned(env: dict[str, str], run: Runner, worktree: Path, tool_dir: Path, call: Call) -> None:
    """Reuse a working Rust toolchain or invoke the measured owned-tools installer.

    Parameters:
        env (dict[str, str]): Guest environment.
        run (Runner): Process boundary.
        worktree (Path): Checkout.
        tool_dir (Path): Tool cache.
        call (Call): Checkout command boundary.
    """
    home = Path(env["HOME"])
    guest = env.get("PI_WSL2_IN_GUEST") == "1"
    if env.get("WSL_OWNED", "false") == "true":
        probe_env = env | {"PATH": f"{home}/.cargo/bin:{env['PATH']}"}
        probe = [
            "timeout",
            "--kill-after=10",
            "300",
            "bash",
            "-c",
            "cargo fmt --version && cargo clippy --version && cargo nextest --version",
        ]
        if guest and run_command(probe, run, env=probe_env, cwd=worktree, capture=True, quiet=True)[0] == 0:
            env["PATH"] = probe_env["PATH"]
        else:
            call(
                ["bash", "scripts/install_wsl_owned_tools.sh", str(tool_dir)],
                label="install owned tools",
                seconds=90,
            )
            env["PATH"] = (tool_dir / "owned-tool-path").read_text().rstrip("\n")


def receipts(env: dict[str, str], worktree: Path, filesystem: str, call: Call) -> None:
    """Publish identity and PATH in the existing host/guest receipt locations.

    Parameters:
        env (dict[str, str]): Guest environment.
        worktree (Path): Checkout.
        filesystem (str): Linux filesystem type.
        call (Call): Checkout command boundary.
    """
    home = Path(env["HOME"])
    guest = env.get("PI_WSL2_IN_GUEST") == "1"
    diagnostics = Path(env["RUNNER_TEMP"] if guest else env["WSL_HOST_TEMP"]) / "wsl2-diagnostics"
    diagnostics.mkdir(parents=True, exist_ok=True)
    (worktree / ".ci-temp").mkdir(exist_ok=True)
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"] + "\n")
    user = call(["id", "-un"]).rstrip("\n")
    uid = call(["id", "-u"]).rstrip("\n")
    identity_arch = call(["uname", "-m"]).rstrip("\n")
    node_identity = call(["node", "--version"]).rstrip("\n")
    bun_identity = call(["bun", "--version"]).rstrip("\n")
    (diagnostics / "identity.txt").write_text(
        f"WSL2 {env.get('WSL_DISTRO_NAME', 'unknown')}, Linux filesystem: {filesystem}\n"
        f"User: {user} (uid {uid})\nArch: {identity_arch}\nNode: {node_identity}\nBun: {bun_identity}\n"
    )
    (diagnostics / "capture-status.txt").write_text("Guest setup complete; ordinary CI steps follow.\n")
    if guest:
        with Path(env["GITHUB_PATH"]).open("a") as handle:
            for directory in reversed(env["PATH"].split(":")):
                if directory.startswith(f"{home}/"):
                    handle.write(directory + "\n")


def main(run: Runner = subprocess.run, environ: Mapping[str, str] | None = None) -> int:
    """Run setup with a private, credential-free environment.

    Parameters:
        run (Runner): Injectable subprocess boundary.
        environ (Mapping[str, str] | None): Environment, defaulting to os.environ.

    Returns:
        int: Original command status, or 1 on a refusal/filesystem error.
    """
    env = dict(os.environ if environ is None else environ)
    env.pop("GH_TOKEN", None)
    try:
        execute(env, run)
    except SetupFailure as exc:
        return exc.status
    except (ValueError, OSError, KeyError) as exc:
        sys.stderr.write(f"wsl2-setup: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
