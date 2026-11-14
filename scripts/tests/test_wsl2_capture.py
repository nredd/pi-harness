"""Exercise `wsl2_capture.py` against disposable guest and host trees with real `cp` and PATH stubs."""

from __future__ import annotations

import os
import runpy
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path
from typing import Any, NamedTuple

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import wsl2_capture as capture

SCRIPT = Path(__file__).resolve().parents[1] / "wsl2_capture.py"
REPORT = "packages/example/coverage/primary/lcov.info"


class Tree(NamedTuple):
    """Disposable guest checkout, Windows-visible directories and the capture environment."""

    worktree: Path
    host: Path
    host_temp: Path
    env: dict[str, str]
    commands: Path


@pytest.fixture(autouse=True)
def _restore_sigterm() -> Iterator[None]:
    """`main` installs a SIGTERM handler; restore the previous one.

    Yields:
        None: Control to the test.
    """
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


def stub(tree: Tree, name: str, body: str) -> None:
    """Install an executable stub in the directory the guest `tool-path` receipt puts first.

    Parameters:
        tree (Tree): The disposable tree.
        name (str): Command name to intercept.
        body (str): Shell body after the shebang.
    """
    path = tree.commands / name
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def tree(tmp_path: Path) -> Tree:
    """Build a guest HOME with a checkout, a host workspace and temp, and a stub `timeout`.

    Parameters:
        tmp_path (Path): Disposable root.

    Returns:
        Tree: The paths and the capture environment.
    """
    worktree = tmp_path / "home" / "pi-harness-ci"
    (worktree / ".ci-temp").mkdir(parents=True)
    (worktree / "integration").mkdir()
    host = tmp_path / "host"
    host_temp = host / "temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    commands = tmp_path / "commands"
    commands.mkdir()
    path = f"{commands}{os.pathsep}{os.environ['PATH']}"
    (worktree / ".ci-temp/tool-path").write_text(path + "\n", encoding="utf-8")
    env = {
        "HOME": str(tmp_path / "home"),
        "PATH": os.environ["PATH"],
        "WSL_HOST_WORKSPACE": str(host),
        "WSL_HOST_TEMP": str(host_temp),
        "WSL_JOB_STATUS": "success",
        "SECRET": "synthetic-sentinel",
    }
    made = Tree(worktree, host, host_temp, env, commands)
    # GitHub's macos-14 image has no coreutils `timeout`; the guest's bounds are not under test here.
    stub(made, "timeout", 'shift\nexec "$@"')
    return made


def context(tree: Tree) -> capture.Capture:
    """Resolve the capture context the way `main` does.

    Parameters:
        tree (Tree): The disposable tree.

    Returns:
        capture.Capture: The resolved context with the real `subprocess.run`.
    """
    return capture._context(tree.env, subprocess.run)


def write(path: Path, text: str = "x\n") -> Path:
    """Write a file, creating parents.

    Parameters:
        path (Path): Target.
        text (str): Contents.

    Returns:
        Path: The same path.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def hosted(tree: Tree) -> set[str]:
    """List every file under the host workspace.

    Parameters:
        tree (Tree): The disposable tree.

    Returns:
        set[str]: Workspace-relative POSIX paths.
    """
    return {p.relative_to(tree.host).as_posix() for p in tree.host.rglob("*") if p.is_file()}


def test_mirrors_only_declared_reports_and_clears_stale_ones(tree: Tree) -> None:
    """Declared artifacts and coverage cross; stale host files, hidden names and unrelated files do not."""
    write(tree.worktree / "integration/artifacts/node.xml", "node")
    write(tree.worktree / "integration/artifacts-personal/p.xml", "personal")
    write(tree.worktree / REPORT, "lcov")
    write(tree.worktree / "coverage/summary.json", "summary")
    write(tree.worktree / "coverage/unexpected.txt")
    write(tree.worktree / "packages/example/coverage/.hidden/lcov.info")
    (tree.worktree / "scripts/coverage/primary/lcov.info").mkdir(parents=True)  # a directory is no report
    write(tree.host / "integration/artifacts-node/stale.xml")
    write(tree.host / "packages/old/coverage/primary/lcov.info")
    assert capture.main(environ=tree.env, argv=[]) == 0
    assert hosted(tree) == {
        "integration/artifacts/node.xml",
        "integration/artifacts-personal/p.xml",
        REPORT,
        "coverage/summary.json",
    }
    assert (tree.host / REPORT).read_text() == "lcov"
    (tree.worktree / REPORT).unlink()
    assert capture.main(environ=tree.env, argv=[]) == 0
    assert REPORT not in hosted(tree)


def test_artifact_snapshots_never_mix_after_a_guest_rename(tree: Tree) -> None:
    """A directory absent from the guest is removed from the host, symlinks included."""
    write(tree.worktree / "integration/artifacts/standalone.xml", "standalone")
    write(tree.host / "integration/artifacts/node.xml", "stale")
    (tree.host / "integration/artifacts-node").symlink_to(tree.host_temp, target_is_directory=True)
    assert capture.main(environ=tree.env, argv=[]) == 0
    assert hosted(tree) == {"integration/artifacts/standalone.xml"}
    assert not (tree.host / "integration/artifacts-node").exists()


def test_a_stale_host_report_that_cannot_be_removed_fails_the_capture(
    tree: Tree, capsys: pytest.CaptureFixture[str]
) -> None:
    """`rm -f` of a directory fails, and `set -e` made that the script's status."""
    (tree.host / "coverage/summary.json").mkdir(parents=True)
    assert capture.main(environ=tree.env, argv=[]) == 1
    assert "cannot remove 'coverage/summary.json'" in capsys.readouterr().err


def test_a_failing_copy_keeps_its_own_status(tree: Tree, capsys: pytest.CaptureFixture[str]) -> None:
    """The failing `cp` status is the capture status, with no first-failure record."""
    write(tree.worktree / REPORT)
    stub(tree, "cp", "exit 92")
    assert capture.main(environ=tree.env, argv=[]) == 92
    assert "`cp` failed with status 92" in capsys.readouterr().err


def test_an_unremovable_artifact_target_fails_with_status_1(
    tree: Tree, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A tree the guest cannot delete is reported by name, not as a traceback."""
    write(tree.host / "integration/artifacts/node.xml")

    def refuse(path: Path) -> None:
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(capture.shutil, "rmtree", refuse)
    assert capture.main(environ=tree.env, argv=[]) == 1
    assert "Permission denied" in capsys.readouterr().err


@pytest.mark.parametrize("published", [False, True])
def test_startup_evidence_is_published_atomically_or_not_at_all(tree: Tree, published: bool) -> None:
    """A partial host copy is never announced, and a previous publication is replaced."""
    write(tree.worktree / ".ci-temp/standalone-startup-diagnostics/SHA256SUMS", "manifest")
    write(tree.host_temp / "standalone-startup-diagnostics/old", "old")
    if not published:
        stub(tree, "cp", 'printf partial > "$3/partial"\nexit 92')
    assert capture.main(environ=tree.env, argv=[]) == (0 if published else 1)
    final = tree.host_temp / "standalone-startup-diagnostics"
    assert (final / "SHA256SUMS").is_file() is published
    assert (final / "old").is_file() is not published
    assert not list(tree.host_temp.glob(".standalone-startup.*"))


def test_contract_reports_are_copied_beside_the_host_temp(tree: Tree) -> None:
    """Only `*contracts*.json` in the guest temp are exported; other files stay."""
    write(tree.worktree / ".ci-temp/package-contracts.json", "{}")
    write(tree.worktree / ".ci-temp/secret.txt")
    assert capture.main(environ=tree.env, argv=[]) == 0
    assert (tree.host_temp / "package-contracts.json").read_text() == "{}"
    assert not (tree.host_temp / "secret.txt").exists()


def test_identity_records_the_core_gitlink_and_the_pi_version(tree: Tree) -> None:
    """The gitlink comes from `git`, `pi --version` runs under a scratch HOME, and `.git` may be a file."""
    write(tree.worktree / "forks/pi/.git", "gitdir: elsewhere")
    stub(tree, "git", 'test "$1" = -C && echo 0123abc')
    pi = write(tree.commands / "pi", '#!/bin/sh\necho "pi $HOME $PI_CODING_AGENT_DIR"\n')
    pi.chmod(0o755)
    tree.env["PI_BIN"] = str(pi)
    assert capture.main(environ=tree.env, argv=[]) == 0
    runner_temp = tree.worktree / ".ci-temp"
    assert (tree.host_temp / "wsl2-diagnostics/identity.txt").read_text() == (
        f"Core Gitlink: 0123abc\npi {runner_temp}/version-home {runner_temp}/version-agent\n"
    )


def test_identity_tolerates_a_missing_core_and_an_unusable_pi_binary(tree: Tree) -> None:
    """No `forks/pi` and a non-executable `PI_BIN` record nothing and do not fail."""
    tree.env["PI_BIN"] = str(write(tree.commands / "not-executable"))
    assert capture.main(environ=tree.env, argv=[]) == 0
    assert not (tree.host_temp / "wsl2-diagnostics/identity.txt").exists()


@pytest.mark.parametrize("tool", ["git", "pi"])
def test_identity_failures_keep_the_tool_status(
    tree: Tree, tool: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """A failing `git rev-parse` or `pi --version` fails the capture with its own status."""
    write(tree.worktree / "forks/pi/.git")
    stub(tree, "git", "exit 5" if tool == "git" else "echo 0123abc")
    pi = write(tree.commands / "pi", "#!/bin/sh\necho partial\nexit 7\n")
    pi.chmod(0o755)
    tree.env["PI_BIN"] = str(pi)
    expected = 5 if tool == "git" else 7
    assert capture.main(environ=tree.env, argv=[]) == expected
    assert f"status {expected}" in capsys.readouterr().err
    if tool == "pi":
        assert "partial" in (tree.host_temp / "wsl2-diagnostics/identity.txt").read_text()


def test_an_unwritable_identity_report_is_an_os_error_status_1(
    tree: Tree, capsys: pytest.CaptureFixture[str]
) -> None:
    """A missing diagnostics directory surfaces as one line and status 1."""
    write(tree.worktree / "forks/pi/.git")
    stub(tree, "git", "echo 0123abc")
    (tree.host_temp / "wsl2-diagnostics").rmdir()
    assert capture.main(environ=tree.env, argv=[]) == 1
    assert "wsl2-capture:" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("missing", "message"),
    [
        ("WSL_HOST_WORKSPACE", "`WSL_HOST_WORKSPACE` is not set"),
        ("WSL_HOST_TEMP", "`WSL_HOST_TEMP` is not set"),
        ("HOME", "`HOME` is not set"),
    ],
)
def test_missing_inputs_are_refused(
    tree: Tree, missing: str, message: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """A missing input is a failure, never a default, and nothing is cleaned up."""
    del tree.env[missing]
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 1
    assert message in capsys.readouterr().err
    assert tree.worktree.is_dir()


def test_an_empty_host_path_is_refused_like_an_unset_one(tree: Tree) -> None:
    """Bash `${VAR:?}` rejects empty values too."""
    tree.env["WSL_HOST_TEMP"] = ""
    assert capture.main(environ=tree.env, argv=[]) == 1


def test_a_missing_tool_path_receipt_is_refused(tree: Tree, capsys: pytest.CaptureFixture[str]) -> None:
    """Without the receipt the guest tool `PATH` is unknown."""
    (tree.worktree / ".ci-temp/tool-path").unlink()
    assert capture.main(environ=tree.env, argv=[]) == 1
    assert "`tool-path` receipt" in capsys.readouterr().err


def test_main_defaults_to_the_process_environment_and_arguments(
    tree: Tree, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`main()` with no arguments reads `os.environ` and `sys.argv`."""
    monkeypatch.setattr(os, "environ", tree.env)
    monkeypatch.setattr(sys, "argv", ["wsl2_capture.py", "cleanup"])
    assert capture.main() == 0
    assert not tree.worktree.exists()


def test_running_the_file_exits_with_the_status_of_main(tree: Tree, monkeypatch: pytest.MonkeyPatch) -> None:
    """The `__main__` guard hands `main()`'s status to `sys.exit`."""
    del tree.env["WSL_HOST_TEMP"]
    monkeypatch.setattr(os, "environ", tree.env)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT)])
    with pytest.raises(SystemExit) as raised:
        runpy.run_path(str(SCRIPT), run_name="__main__")
    assert raised.value.code == 1


@pytest.mark.parametrize(
    ("recorded", "expected"),
    [("47\n", 47), ("0\n", 0), ("300\n", 44), ("256\n", 0), ("", 1), ("4\n7\n", 1), ("boom", 1)],
)
def test_cleanup_exits_with_the_first_failure_record(tree: Tree, recorded: str, expected: int) -> None:
    """The guest's first failure wins, an unparseable one is 1, and the status is taken modulo 256."""
    write(tree.worktree / ".ci-temp/first-failure", recorded)
    assert capture.main(environ=tree.env, argv=["cleanup"]) == expected
    assert not tree.worktree.exists()
    assert (tree.host_temp / "wsl2-diagnostics/capture-status.txt").read_text() == (
        f"WSL harness exited with status {expected}.\n"
    )


def test_an_unreadable_first_failure_record_counts_as_status_1(
    tree: Tree, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A record the guest cannot read is neither ignored nor trusted."""
    write(tree.worktree / ".ci-temp/first-failure", "47\n")
    real = Path.read_text

    def read(self: Path, *args: Any, **kwargs: Any) -> str:
        if self.name == "first-failure":
            raise PermissionError(13, "Permission denied")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 1


def test_an_export_failure_without_a_first_failure_record_is_the_exit_status(tree: Tree) -> None:
    """`cleanup` mode keeps the export's own failing status and still removes the checkout."""
    write(tree.worktree / "integration/artifacts/x.xml")
    stub(tree, "cp", "exit 92")
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 92
    assert not tree.worktree.exists()


@pytest.mark.parametrize("mode", ["cleanup", ""])
def test_sigterm_during_the_export_exits_143_and_cleanup_still_runs(
    tree: Tree, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    """A terminated export reports 143 like a Bash `trap ... EXIT`; `cleanup` mode also cleans up first."""

    def terminated(_ctx: capture.Capture) -> None:
        capture.terminate(signal.SIGTERM, None)

    stub(tree, "python3", "exit 0")
    monkeypatch.setattr(capture, "_export", terminated)
    assert capture.main(environ=tree.env, argv=[mode]) == 143
    assert tree.worktree.exists() is (mode == "")
    if mode:
        assert "guest status 143" in (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()


def test_a_real_sigterm_runs_the_cleanup(tree: Tree, tmp_path: Path) -> None:
    """Deliver SIGTERM to the bootstrap's Python while its first command hangs."""
    write(tree.worktree / "integration/artifacts/x.xml")
    started = tmp_path / "started"
    # Only the export hangs; the cleanup's own `cp` must return.
    stub(tree, "cp", f"test -e {started} && exit 0\ntouch {started}\nexec sleep 60")
    env = os.environ | tree.env | {"PATH": f"{tree.commands}{os.pathsep}{os.environ['PATH']}"}
    child = subprocess.Popen([sys.executable, str(SCRIPT), "cleanup"], env=env)
    while not started.exists():
        assert child.poll() is None, "the capture exited before its first command"
        time.sleep(0.05)
    child.terminate()
    assert child.wait(timeout=60) == 143
    assert not tree.worktree.exists()


def test_cleanup_preserves_failure_artifacts_before_deleting_the_worktree(tree: Tree) -> None:
    """Copy bounded artifacts, record the status, then remove the harness checkout."""
    write(tree.worktree / "integration/artifacts/wsl2-personal.xml", "<testsuite/>\n")
    write(tree.worktree / ".ci-temp/first-failure", "47\n")
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 47
    diagnostics = tree.host_temp / "wsl2-diagnostics"
    assert (diagnostics / "artifacts/wsl2-personal.xml").read_text() == "<testsuite/>\n"
    assert (diagnostics / "capture-status.txt").read_text() == "WSL harness exited with status 47.\n"
    assert not tree.worktree.exists()


def test_cleanup_keeps_the_harness_status_when_every_housekeeping_step_fails(
    tree: Tree, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Copying, recording and removing are best effort: each warns and none replaces the status."""
    write(tree.worktree / "integration/artifacts/x.xml")
    stub(tree, "cp", "exit 92")
    blocked = tree.host_temp / "blocked"
    blocked.write_text("a file, not a directory")
    # `mkdir` and the status write both fail beneath a file.
    ctx = replace(context(tree), host_temp=blocked)

    def refuse(path: Path) -> None:
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(capture.shutil, "rmtree", refuse)
    capture._cleanup(ctx, 47)
    err = capsys.readouterr().err
    for warning in (
        "preserve WSL failure artifacts",
        "record WSL capture status",
        "remove disposable WSL worktree",
    ):
        assert f"WARNING: could not {warning}" in err
    assert tree.worktree.is_dir()


@pytest.mark.parametrize("status", ["cancelled", "failure", "bogus"])
def test_job_status_alone_triggers_guest_state_without_changing_the_exit(tree: Tree, status: str) -> None:
    """A timeout or cancel kills the guest before `first-failure`; the job status still collects state."""
    stub(tree, "dmesg", "echo '[    2.0] unprivileged kernel line'")
    stub(tree, "python3", "exit 0")
    tree.env["WSL_JOB_STATUS"] = status
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 0
    state = (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert state.splitlines()[0].endswith(f" (UTC): guest status 0, job status {status}")
    assert "== dmesg unprivileged (last 400 lines) ==" in state
    assert "synthetic-sentinel" not in state


@pytest.mark.parametrize("job_status", ["success", ""])
def test_green_runs_collect_nothing(tree: Tree, job_status: str) -> None:
    """A green guest with a green (or unspecified) job never reads the kernel log."""
    tree.env["WSL_JOB_STATUS"] = job_status
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 0
    assert not (tree.host_temp / "wsl2-diagnostics/guest-state.txt").exists()


def test_an_unset_job_status_is_unknown_in_the_report(tree: Tree) -> None:
    """The header names the job status as `unknown` when the caller passed none, e.g. on failure."""
    stub(tree, "python3", "exit 0")
    del tree.env["WSL_JOB_STATUS"]
    write(tree.worktree / ".ci-temp/first-failure", "47\n")
    assert capture.main(environ=tree.env, argv=["cleanup"]) == 47
    state = (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert state.splitlines()[0].endswith(" (UTC): guest status 47, job status unknown")


def fake_proc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the collector at a synthetic `/proc` with a few readable files.

    Parameters:
        tmp_path (Path): Disposable root.
        monkeypatch (pytest.MonkeyPatch): Redirects `wsl2_capture.PROC`.

    Returns:
        Path: The synthetic root.
    """
    proc = tmp_path / "proc"
    write(proc / "meminfo", "MemTotal: 1 kB\n")
    write(proc / "swaps", "Filename\n")
    write(proc / "vmstat", "nr_free_pages 1\npswpin 3\noom_kill 0\nallocstall_normal 2\npgmajfault 4\nx 9\n")
    monkeypatch.setattr(capture, "PROC", proc)
    return proc


def test_guest_state_reports_readable_and_unreadable_proc_files_and_the_kernel_log(
    tree: Tree, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Readable files are copied verbatim, others say so, and only the vmstat counters are kept."""
    fake_proc(tmp_path, monkeypatch)
    stub(tree, "dmesg", "echo '[    2.0] unprivileged kernel line'\necho no-newline-tail | tr -d '\\n'")
    stub(tree, "python3", "exit 0")
    capture._guest_state(context(tree), 47)
    state = (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert "== /proc/meminfo ==\nMemTotal: 1 kB\n" in state
    assert "== /proc/uptime ==\nUNAVAILABLE: not readable\n" in state
    assert "pswpin 3\noom_kill 0\nallocstall_normal 2\npgmajfault 4\n" in state
    assert "nr_free_pages" not in state
    assert state.endswith("unprivileged kernel line\nno-newline-tail")


def test_guest_state_marks_missing_vmstat_counters_and_an_unreadable_kernel_log(
    tree: Tree, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A `vmstat` with none of the counters, and a `dmesg` that fails, are explicit."""
    proc = fake_proc(tmp_path, monkeypatch)
    write(proc / "vmstat", "nr_free_pages 1\n")
    stub(tree, "dmesg", "echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2\nexit 1")
    stub(tree, "python3", "exit 0")
    capture._guest_state(context(tree), 1)
    state = (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert "(swap, reclaim, OOM) ==\nUNAVAILABLE: not readable\n" in state
    assert "UNAVAILABLE: unprivileged dmesg failed (see dmesg_restrict above)" in state
    assert "Operation not permitted" not in state


def test_guest_state_without_a_vmstat_file(
    tree: Tree, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An absent `/proc/vmstat` is the same explicit UNAVAILABLE."""
    (fake_proc(tmp_path, monkeypatch) / "vmstat").unlink()
    stub(tree, "python3", "exit 0")
    capture._guest_state(context(tree), 1)
    assert (
        "(swap, reclaim, OOM) ==\nUNAVAILABLE"
        in (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    )


def test_a_report_the_scanner_refuses_is_withheld(tree: Tree) -> None:
    """A credential finding, or a scanner that cannot run, exports only the notice."""
    stub(tree, "dmesg", "echo ghp_secret")
    stub(tree, "python3", "exit 1")
    capture._guest_state(context(tree), 47)
    exported = (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()
    assert exported == "WSL guest state withheld: the shared credential scan refused it or could not run.\n"
    assert "ghp_secret" not in exported


def test_the_scanner_runs_the_shared_credential_policy_from_the_integration_directory(tree: Tree) -> None:
    """`python3 -m harness.credentials <report>` runs in `integration/`, bounded by `timeout 60`."""
    log = tree.worktree.parent / "scan.log"
    stub(tree, "timeout", f'echo "$PWD $*" > {log}')
    capture._guest_state(context(tree), 1)
    assert log.read_text() == (
        f"{tree.worktree.resolve() / 'integration'} 60 python3 -m harness.credentials "
        f"{tree.worktree / '.ci-temp/guest-state.txt'}\n"
    )


def test_a_missing_scanner_command_is_withheld_not_a_traceback(tree: Tree) -> None:
    """With no `timeout`, no `python3` and no `integration/` the report is withheld quietly."""
    (tree.commands / "timeout").unlink()
    (tree.worktree / "integration").rmdir()
    ctx = context(tree)
    ctx.env["PATH"] = str(tree.commands)
    capture._guest_state(ctx, 1)
    assert "withheld" in (tree.host_temp / "wsl2-diagnostics/guest-state.txt").read_text()


def test_guest_state_export_failures_only_warn(tree: Tree, capsys: pytest.CaptureFixture[str]) -> None:
    """An unwritable report, export target or withheld notice never raises."""
    stub(tree, "python3", "exit 0")
    ctx = context(tree)
    (tree.worktree / ".ci-temp/guest-state.txt").mkdir()  # the report cannot be written or read
    (tree.host_temp / "wsl2-diagnostics/guest-state.txt").mkdir()
    capture._guest_state(ctx, 1)
    stub(tree, "python3", "exit 1")
    capture._guest_state(ctx, 1)
    err = capsys.readouterr().err
    assert "WARNING: could not export WSL guest state" in err
    assert "WARNING: could not record withheld guest state" in err


@pytest.mark.parametrize(
    ("text", "count", "expected"),
    [
        ("", 3, ""),
        ("a\nb\nc\nd\n", 2, "c\nd\n"),
        ("a\nb\nc\nd", 2, "c\nd"),
        ("a\n", 5, "a\n"),
        ("\n", 5, "\n"),
    ],
)
def test_tail_matches_the_tail_command(text: str, count: int, expected: str) -> None:
    """Keep the last lines, preserving whether the output ended in a newline."""
    assert capture._tail(text, count) == expected


def test_the_kernel_log_is_cut_to_its_last_400_lines(tree: Tree) -> None:
    """Older kernel lines are dropped."""
    stub(tree, "dmesg", "seq 1 1000")
    section = capture._kernel_section(context(tree))
    assert section.startswith("\n== dmesg unprivileged (last 400 lines) ==\n601\n")
    assert section.endswith("\n1000\n")
