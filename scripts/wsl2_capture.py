"""Export only explicit synthetic CI reports from the WSL guest to the Windows host, then clean up.

`capture-ci-wsl` starts `wsl2_capture.sh`, a compatibility bootstrap, which execs this file so
`python-scripts` measures it. It runs after `wsl2_apt.sh` has installed the guest's `python3`, on that
system interpreter (3.12), so it is standard library only. It never exports the guest HOME or the runner
environment, only the allowlisted paths below.

Inputs (a missing one is a failure, never a default):
    HOME: the guest user's home; the checkout is `$HOME/pi-harness-ci`.
    WSL_HOST_WORKSPACE: the Windows-visible workspace, as a `/mnt` path.
    WSL_HOST_TEMP: the Windows-visible runner temp, as a `/mnt` path.
    PI_BIN: optional guest `pi` binary whose `--version` is recorded.
    WSL_JOB_STATUS: optional caller `job.status`; anything but `success` also collects guest state.

Arguments:
    cleanup: after exporting, record the capture status, preserve failure artifacts, collect guest state
        for a failed or cancelled run, and remove the disposable checkout. The exit status is the guest's
        first-failure record when one exists, else the export's own status (143 after SIGTERM).

References:
    https://learn.microsoft.com/windows/wsl/filesystems
    https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#psi-pressure-stall-information
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from fnmatch import fnmatchcase
from pathlib import Path
from types import FrameType

from wsl2_exec import Runner, run_command, terminate

ARTIFACT_DIRECTORIES = ("artifacts", "artifacts-node", "artifacts-personal")
COVERAGE_LEAVES = ("lcov.info", "coverage-summary.json")
COVERAGE_ROOTS = (
    "packages/*",
    "integration/inprocess",
    "integration/probes",
    "integration/providers",
    "scripts",
)
# The exact report paths `ci.yml` uploads; nothing else under the guest checkout crosses the boundary.
COVERAGE_REPORTS = (
    *(f"{root}/coverage/*/{leaf}" for root in COVERAGE_ROOTS for leaf in COVERAGE_LEAVES),
    "coverage/summary.json",
)
# Failure-only guest evidence for whole-guest stalls (#445): fixed files only, no environment or HOME.
PROC = Path("/proc")
GUEST_STATE_FILES = (
    "uptime",
    "loadavg",
    "meminfo",
    "swaps",
    "pressure/cpu",
    "pressure/memory",
    "pressure/io",
    "sys/kernel/dmesg_restrict",
)
VMSTAT_COUNTER = re.compile(r"(pswpin|pswpout|pgmajfault|allocstall_[a-z0-9]+|oom_kill) ")
DMESG_LINES = 400
UNAVAILABLE = "UNAVAILABLE: not readable\n"


def _ignore(_signum: int, _frame: FrameType | None) -> None:
    """Swallow a signal in this process only; unlike `SIG_IGN`, children get the default disposition back.

    Parameters:
        _signum (int): The delivered signal number, unused.
        _frame (FrameType | None): Interrupted frame, unused.
    """


@contextlib.contextmanager
def _warn_on_error(warning: str) -> Iterator[None]:
    """Turn a failed best-effort step into one `WARNING:` line.

    Parameters:
        warning (str): What could not be done, without the prefix.

    Yields:
        None: Control to the guarded step.
    """
    try:
        yield
    except (OSError, CaptureError):
        sys.stderr.write(f"WARNING: could not {warning}\n")


class CaptureError(Exception):
    """A refusal or failed export step; `status` is the exit status the Bash `set -e` script produced."""

    def __init__(self, message: str, status: int = 1) -> None:
        """Record the diagnostic and the exit status.

        Parameters:
            message (str): The whole diagnostic.
            status (int): Exit status of the failed step.
        """
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Capture:
    """Resolved guest and host locations plus the child environment and runner.

    Attributes:
        worktree (Path): The disposable guest checkout.
        runner_temp (Path): The checkout's `.ci-temp`.
        host_workspace (Path): Windows-visible workspace.
        host_temp (Path): Windows-visible runner temp.
        env (dict[str, str]): Complete child environment, with the guest tool `PATH`.
        run (Runner): `subprocess.run`-compatible callable.
    """

    worktree: Path
    runner_temp: Path
    host_workspace: Path
    host_temp: Path
    env: dict[str, str]
    run: Runner

    @property
    def diagnostics(self) -> Path:
        """Locate the host directory holding bounded diagnostics.

        Returns:
            Path: `wsl2-diagnostics` under the host temp.
        """
        return self.host_temp / "wsl2-diagnostics"

    def command(
        self,
        cmd: Sequence[str],
        *,
        capture: bool = False,
        quiet: bool = False,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> tuple[int, str]:
        """Run one command without raising, resolved through the `tool-path` receipt's `PATH`.

        Bare names are deliberate: the receipt is the guest's trusted tool path, and the CI fixtures stub
        commands through it.

        Parameters:
            cmd (Sequence[str]): Argument vector.
            capture (bool): Return standard output.
            quiet (bool): Discard standard error.
            cwd (Path | None): Child working directory.
            env (Mapping[str, str] | None): Replacement environment; defaults to the guest one.

        Returns:
            tuple[int, str]: Exit status and captured standard output.
        """
        return run_command(
            cmd, self.run, capture=capture, quiet=quiet, cwd=cwd, env=self.env if env is None else env
        )


def _copy(ctx: Capture, args: Sequence[str]) -> None:
    """Run `cp` and fail with its status, like a Bash `set -e` command.

    Parameters:
        ctx (Capture): Locations and runner.
        args (Sequence[str]): Arguments after `cp`.

    Raises:
        CaptureError: When `cp` exits non-zero.
    """
    status = ctx.command(["cp", *args])[0]
    if status:
        raise CaptureError(f"wsl2-capture: `cp` failed with status {status}", status)


def _remove(path: Path, *, tree: bool = True) -> None:
    """Remove a file, link or (by default) tree like `rm -rf`, or `rm -f` without `tree`; missing is fine.

    A tree is removed as far as possible before the first failure is raised, like `rm -rf`.

    Parameters:
        path (Path): Path to remove.
        tree (bool): Remove a directory recursively; otherwise a directory is an error like `rm -f`.

    Raises:
        CaptureError: When it cannot be removed.
    """
    errors: list[BaseException] = []
    try:
        if tree and path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, onexc=lambda _function, _path, error: errors.append(error))
        else:
            path.unlink(missing_ok=True)
    except OSError as exc:
        errors.append(exc)
    if errors:
        reason = getattr(errors[0], "strerror", None) or errors[0]
        raise CaptureError(f"wsl2-capture: cannot remove '{path}': {reason}") from errors[0]


def _glob(base: Path, pattern: str) -> list[str]:
    """Expand one shell-style pattern under `base`, matching every entry like a shell does.

    `*` never matches hidden names, and an entry matches while it exists or is a link, dangling ones
    included (`Path.glob` follows links and would miss a stale dangling report).

    Parameters:
        base (Path): Directory the pattern is relative to.
        pattern (str): Relative pattern; only whole-component `*` wildcards are used.

    Returns:
        list[str]: Existing relative POSIX paths, sorted.
    """
    matches = [Path()]
    for part in pattern.split("/"):
        found: list[Path] = []
        for prefix in matches:
            directory = base / prefix
            if "*" not in part:
                candidate = directory / part
                if candidate.exists() or candidate.is_symlink():
                    found.append(prefix / part)
                continue
            try:
                names = [entry.name for entry in directory.iterdir()]
            except OSError:
                continue
            found.extend(
                prefix / name for name in names if not name.startswith(".") and fnmatchcase(name, part)
            )
        matches = found
    return sorted(match.as_posix() for match in matches)


def _matches(base: Path) -> list[str]:
    """Expand the report patterns under `base` in shell order.

    Parameters:
        base (Path): Directory the patterns are relative to.

    Returns:
        list[str]: Existing relative paths, sorted within each pattern.
    """
    return [relative for pattern in COVERAGE_REPORTS for relative in _glob(base, pattern)]


def _mirror_artifacts(ctx: Capture) -> None:
    """Mirror the explicit artifact directories, including their absence.

    Never mix stale Node files into a standalone snapshot after the guest renames it.

    Parameters:
        ctx (Capture): Locations and runner.

    Raises:
        CaptureError: When a stale tree cannot be removed or `cp` fails.
    """
    for name in ARTIFACT_DIRECTORIES:
        target = ctx.host_workspace / "integration" / name
        _remove(target)
        source = ctx.worktree / "integration" / name
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy(ctx, ["-RP", f"{source}/.", f"{target}/"])


def _mirror_coverage(ctx: Capture) -> None:
    """Replace the host's coverage reports with the guest's, at the exact paths `ci.yml` uploads.

    Owned coverage stays independent per runner; no guest source, dependency tree, HOME or environment
    crosses here.

    Parameters:
        ctx (Capture): Locations and runner.

    Raises:
        CaptureError: When a stale report cannot be removed or `cp` fails.
    """
    for relative in _matches(ctx.host_workspace):
        _remove(ctx.host_workspace / relative, tree=False)
    for relative in _matches(ctx.worktree):
        report = ctx.worktree / relative
        if not report.is_file():
            continue
        destination = ctx.host_workspace / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        _copy(ctx, ["-P", str(report), str(destination)])


def _publish_startup(ctx: Capture) -> None:
    """Publish the startup collector's already-scanned evidence atomically, never a partial copy.

    Parameters:
        ctx (Capture): Locations and runner.

    Raises:
        CaptureError: With status 1 when the copy fails (the staging directory is removed first).
    """
    source = ctx.runner_temp / "standalone-startup-diagnostics"
    if not source.is_dir():
        return
    staging = Path(tempfile.mkdtemp(prefix=".standalone-startup.", dir=ctx.host_temp))
    try:
        _copy(ctx, ["-RP", f"{source}/.", f"{staging}/"])
    except CaptureError as exc:
        _remove(staging)
        raise CaptureError(f"wsl2-capture: startup diagnostics not published: {exc}") from exc
    final = ctx.host_temp / "standalone-startup-diagnostics"
    _remove(final)
    staging.rename(final)


def _record_identity(ctx: Capture) -> None:
    """Append the core gitlink and `pi --version` to the host identity report.

    Parameters:
        ctx (Capture): Locations and runner.

    Raises:
        CaptureError: When `git` or `pi` fails.
    """
    identity = ctx.diagnostics / "identity.txt"
    core = ctx.worktree / "forks/pi"
    if (core / ".git").exists():
        status, head = ctx.command(["git", "-C", str(core), "rev-parse", "HEAD"], capture=True)
        if status:
            raise CaptureError(f"wsl2-capture: `git rev-parse` failed with status {status}", status)
        commit = head.rstrip("\n")
        with identity.open("a", encoding="utf-8", errors="surrogateescape") as handle:
            handle.write(f"Core Gitlink: {commit}\n")
    pi_bin = ctx.env.get("PI_BIN", "")
    if pi_bin and os.access(pi_bin, os.X_OK):
        home = ctx.runner_temp / "version-home"
        agent = ctx.runner_temp / "version-agent"
        home.mkdir(parents=True, exist_ok=True)
        agent.mkdir(parents=True, exist_ok=True)
        env = ctx.env | {"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent)}
        with identity.open("a", encoding="utf-8", errors="surrogateescape") as handle:
            status, version = ctx.command([pi_bin, "--version"], capture=True, env=env)
            handle.write(version)
        if status:
            raise CaptureError(f"wsl2-capture: `pi --version` failed with status {status}", status)


def _export(ctx: Capture) -> None:
    """Export every allowlisted report, in the order the Bash script did, stopping at the first failure.

    Parameters:
        ctx (Capture): Locations and runner.

    Raises:
        CaptureError: When a step fails; `status` is that step's status.
    """
    _mirror_artifacts(ctx)
    _mirror_coverage(ctx)
    _publish_startup(ctx)
    for report in _glob(ctx.runner_temp, "*contracts*.json"):
        _copy(ctx, [str(ctx.runner_temp / report), f"{ctx.host_temp}/"])
    _record_identity(ctx)


def _tail(text: str, count: int) -> str:
    """Return the last `count` newline-terminated lines of `text`, like `tail -n`.

    Parameters:
        text (str): Command output.
        count (int): Lines to keep.

    Returns:
        str: The kept lines, ending in a newline exactly when `text` did.
    """
    lines = text.split("\n")
    terminated = lines[-1] == ""
    if terminated:
        lines.pop()
    kept = lines[-count:]
    if not kept:
        return ""
    return "\n".join(kept) + ("\n" if terminated else "")


def _proc_section(name: str) -> str:
    """Return one `/proc` file as a report section, or an explicit UNAVAILABLE line.

    Parameters:
        name (str): Path under `/proc`.

    Returns:
        str: The heading plus the file's contents.
    """
    try:
        body = (PROC / name).read_text(encoding="utf-8", errors="surrogateescape")
    except OSError:
        body = UNAVAILABLE
    return f"\n== /proc/{name} ==\n{body}"


def _vmstat_section() -> str:
    """Return the swap, reclaim and OOM counters from `/proc/vmstat`.

    Returns:
        str: The heading plus the matching lines, or an explicit UNAVAILABLE line.
    """
    heading = "\n== /proc/vmstat (swap, reclaim, OOM) ==\n"
    try:
        lines = (PROC / "vmstat").read_text(encoding="utf-8", errors="surrogateescape").splitlines(True)
    except OSError:
        return heading + UNAVAILABLE
    kept = [line for line in lines if VMSTAT_COUNTER.match(line)]
    return heading + ("".join(kept) if kept else UNAVAILABLE)


def _kernel_section(ctx: Capture) -> str:
    """Return the unprivileged kernel log tail, or an explicit UNAVAILABLE line.

    Parameters:
        ctx (Capture): Locations and runner.

    Returns:
        str: The heading plus the log tail. No `sudo`: `kernel.dmesg_restrict` decides readability.
    """
    status, log = ctx.command(["timeout", "20", "dmesg"], capture=True, quiet=True)
    if status:
        return "\n== dmesg ==\nUNAVAILABLE: unprivileged dmesg failed (see dmesg_restrict above)\n"
    return f"\n== dmesg unprivileged (last {DMESG_LINES} lines) ==\n{_tail(log, DMESG_LINES)}"


def _guest_report(ctx: Capture, status: int) -> str:
    """Build the synthetic guest-state report.

    Parameters:
        ctx (Capture): Locations and runner.
        status (int): The guest status, recorded in the header.

    Returns:
        str: The unscanned report text.
    """
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    job = ctx.env.get("WSL_JOB_STATUS") or "unknown"
    text = f"WSL guest state at {stamp} (UTC): guest status {status}, job status {job}\n"
    text += "".join(_proc_section(name) for name in GUEST_STATE_FILES)
    return text + _vmstat_section() + _kernel_section(ctx)


def _guest_state(ctx: Capture, status: int) -> None:
    """Export a scanned report of guest memory, swap, pressure and kernel state for a failed job.

    The shared credential policy scans the synthetic report first; a refusal or a scanner that cannot run
    exports only a withheld notice. Nothing here alters the capture status.

    Parameters:
        ctx (Capture): Locations and runner.
        status (int): The guest status, recorded in the report header.
    """
    report = ctx.runner_temp / "guest-state.txt"
    with contextlib.suppress(OSError):
        report.write_text(_guest_report(ctx, status), encoding="utf-8", errors="surrogateescape")
    scanned = ctx.command(
        ["timeout", "60", "python3", "-m", "harness.credentials", str(report)],
        cwd=ctx.worktree / "integration",
    )[0]
    target = ctx.diagnostics / "guest-state.txt"
    if scanned == 0:
        with _warn_on_error("export WSL guest state"):
            exported = report.read_text(encoding="utf-8", errors="surrogateescape")
            target.write_text(exported, encoding="utf-8", errors="surrogateescape")
        return
    with _warn_on_error("record withheld guest state"):
        target.write_text(
            "WSL guest state withheld: the shared credential scan refused it or could not run.\n",
            encoding="utf-8",
        )


def _cleanup(ctx: Capture, status: int) -> None:
    """Preserve bounded diagnostics, then remove the disposable checkout; every step is best effort.

    Parameters:
        ctx (Capture): Locations and runner.
        status (int): The harness status recorded for the capture.
    """
    artifacts = ctx.worktree / "integration/artifacts"
    if artifacts.is_dir():
        preserved = ctx.diagnostics / "artifacts"
        with contextlib.suppress(OSError):
            preserved.mkdir(parents=True, exist_ok=True)
        if ctx.command(["cp", "-RP", f"{artifacts}/.", f"{preserved}/"])[0]:
            sys.stderr.write("WARNING: could not preserve WSL failure artifacts\n")
    with _warn_on_error("record WSL capture status"):
        (ctx.diagnostics / "capture-status.txt").write_text(
            f"WSL harness exited with status {status}.\n", encoding="utf-8"
        )
    with _warn_on_error("remove disposable WSL worktree"):
        _remove(ctx.worktree)


def _finish(ctx: Capture, status: int) -> int:
    """Settle the final status, collect failure-only state, clean up, and return the exit status.

    The guest's first-failure record wins. A timeout or cancel kills the guest step before it writes one,
    so the caller's job status also triggers guest-state collection, without changing the status.

    Parameters:
        ctx (Capture): Locations and runner.
        status (int): The export's own status.

    Returns:
        int: The exit status: first-failure (1 when unparseable), else `status`, modulo 256 like a shell.
    """
    # Cleanup is bounded work and must complete, as a Bash EXIT trap does; the caller's `timeout` escalates.
    signal.signal(signal.SIGTERM, _ignore)
    first = ctx.runner_temp / "first-failure"
    if first.is_file():
        try:
            recorded = first.read_text(encoding="utf-8", errors="surrogateescape").rstrip("\n")
        except OSError:
            recorded = ""
        status = int(recorded) if re.fullmatch("[0-9]+", recorded) else 1
    if status != 0 or (ctx.env.get("WSL_JOB_STATUS") or "success") != "success":
        _guest_state(ctx, status)
    _cleanup(ctx, status % 256)
    return status % 256


def _context(env: dict[str, str], run: Runner) -> Capture:
    """Resolve the locations and the guest tool `PATH` from the environment.

    Parameters:
        env (dict[str, str]): The adapter environment; the guest tool `PATH` replaces its `PATH`.
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        Capture: The resolved context.

    Raises:
        CaptureError: When an input is unset or the `tool-path` receipt is unreadable.
    """
    for name in ("WSL_HOST_WORKSPACE", "WSL_HOST_TEMP"):
        if not env.get(name):
            raise CaptureError(f"wsl2-capture: `{name}` is not set")
    if "HOME" not in env:
        raise CaptureError("wsl2-capture: `HOME` is not set")
    worktree = Path(env["HOME"], "pi-harness-ci")
    runner_temp = worktree / ".ci-temp"
    receipt = runner_temp / "tool-path"
    try:
        tool_path = receipt.read_text(encoding="utf-8", errors="surrogateescape").rstrip("\n")
    except OSError as exc:
        raise CaptureError(f"wsl2-capture: `tool-path` receipt '{receipt}' is unreadable") from exc
    env = env | {"PATH": tool_path, "RUNNER_TEMP": str(runner_temp)}
    return Capture(
        worktree, runner_temp, Path(env["WSL_HOST_WORKSPACE"]), Path(env["WSL_HOST_TEMP"]), env, run
    )


def main(
    run: Runner = subprocess.run, environ: Mapping[str, str] | None = None, argv: Sequence[str] | None = None
) -> int:
    """Export the allowlisted reports; in `cleanup` mode also settle the status and remove the checkout.

    Parameters:
        run (Runner): `subprocess.run`-compatible callable, injected by tests.
        environ (Mapping[str, str] | None): Adapter environment; defaults to `os.environ`.
        argv (Sequence[str] | None): Arguments after the program name; defaults to `sys.argv[1:]`.

    Returns:
        int: 0 on success, else the failing step's status (1 for a refusal). In `cleanup` mode the
            guest's first-failure record wins. SIGTERM runs the same cleanup and exits 143.
    """
    signal.signal(signal.SIGTERM, terminate)
    env = dict(os.environ if environ is None else environ)
    arguments = sys.argv[1:] if argv is None else list(argv)
    try:
        ctx = _context(env, run)
    except CaptureError as exc:
        sys.stderr.write(f"{exc}\n")
        return exc.status
    status = 0
    try:
        _export(ctx)
    except CaptureError as exc:
        sys.stderr.write(f"{exc}\n")
        status = exc.status
    except OSError as exc:
        sys.stderr.write(f"wsl2-capture: {exc}\n")
        status = 1
    except SystemExit as exc:
        status = int(exc.code or 0)
    return _finish(ctx, status) if arguments[:1] == ["cleanup"] else status


if __name__ == "__main__":
    sys.exit(main())
