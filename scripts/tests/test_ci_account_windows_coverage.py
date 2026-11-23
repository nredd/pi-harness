"""Compare the Windows x64 coverage accounting CLI with its original Bash step.

References:
- https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_account_windows_coverage

SCRIPT = Path(ci_account_windows_coverage.__file__).resolve()
WORKFLOW = SCRIPT.parents[1] / ".github/workflows/ci.yml"
STEP = "Account for Windows x64 coverage separately"
# Original `Account for Windows x64 coverage separately` run block from ci.yml.
ORACLE = Path(__file__).resolve().parent / "fixtures/account-windows-coverage.bash.txt"
LINK = "->"
NATIVE = "packages/computer-use/coverage/native-windows"
# Stands in for `uv`: records its argv and working directory, then exits with `FAKE_UV_STATUS`.
FAKE_UV = """#!/bin/sh
printf 'uv cwd=%s\\n' "$PWD"
for arg in "$@"; do printf 'arg=[%s]\\n' "$arg"; done
echo 'uv stderr' >&2
exit "${FAKE_UV_STATUS:-0}"
"""

REPORTS = {
    "lcov.info": "TN:\nend_of_record\n",
    "coverage.json": '{"data": []}\n',
    "metadata.json": '{"os": "win32"}\n',
}

# Each layout maps a path under `windows-coverage` to file content, `(LINK, target)` for a
# symlink, or `None` for an empty directory. Paths under `NATIVE` are prior state.
Layout = dict[str, str | tuple[str, str] | None]


def producer(name: str, reports: dict[str, str] = REPORTS) -> Layout:
    """Return one downloaded producer directory's reports.

    Parameters:
        name (str): Producer directory name.
        reports (dict[str, str]): Report file name to content.

    Returns:
        Layout: Layout entries for the producer.
    """
    return {f"{name}/{report}": content for report, content in reports.items()}


LAYOUTS: dict[str, Layout] = {
    "one producer is staged and accounted": producer("windows-x64-1")
    | {"windows-x64-1/extra.txt": "not staged\n", "other/lcov.info": "ignored\n"},
    "staging overwrites prior reports and keeps others": producer("windows-x64-1")
    | {f"{NATIVE}/lcov.info": "stale\n", f"{NATIVE}/compiler.log": "kept\n"},
    "nothing downloaded leaves the glob unmatched": {},
    "an empty download directory leaves the glob unmatched": {"unrelated": None},
    "two producers refuse": producer("windows-a") | producer("windows-b"),
    "a producer and a matching file refuse": producer("windows-a") | {"windows-b.txt": "file\n"},
    "hidden and differently cased names do not match": producer("windows-a")
    | producer(".windows-b")
    | producer("Windows-c"),
    "a symlinked producer is staged": {"windows-link": (LINK, "../outside")}
    | {f"../outside/{report}": content for report, content in REPORTS.items()},
    "a dangling symlink counts as the producer": {"windows-gone": (LINK, "../missing")},
    "a matching file counts as the producer": {"windows-file": "not a directory\n"},
    "a missing report copies the rest and fails": producer(
        "windows-x64-1", {"lcov.info": "TN:\n", "coverage.json": "{}\n"}
    ),
    "glob characters in the producer name are literal": producer("windows-[x]*"),
    "a file where the destination belongs fails mkdir": producer("windows-x64-1")
    | {"packages/computer-use/coverage": "a file\n"},
}


def build(root: Path, layout: Layout) -> None:
    """Create a downloaded-artifact tree and checkout under `root`.

    Parameters:
        root (Path): Empty runner directory holding `temp/windows-coverage` and `workspace`.
        layout (Layout): Paths relative to `temp/windows-coverage`.
    """
    downloads = root / "temp/windows-coverage"
    downloads.mkdir(parents=True)
    (root / "workspace").mkdir()
    bin_dir = root / "bin"
    bin_dir.mkdir()
    (bin_dir / "uv").write_text(FAKE_UV)
    (bin_dir / "uv").chmod(0o755)
    for relative, content in layout.items():
        path = downloads / relative
        if content is None:
            path.mkdir(parents=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, tuple):
            path.symlink_to(content[1])
        else:
            path.write_text(content)


def snapshot(top: Path) -> dict[str, tuple[str, int, str]]:
    """Record every entry's type, mode and content or link target.

    Parameters:
        top (Path): Directory to record.

    Returns:
        dict[str, tuple[str, int, str]]: Relative path to kind, permission bits and payload.
    """
    entries: dict[str, tuple[str, int, str]] = {}
    for path in sorted(top.rglob("*")):
        info = path.lstat()
        relative = path.relative_to(top).as_posix()
        if stat.S_ISLNK(info.st_mode):
            entries[relative] = ("link", 0, str(path.readlink()))
        elif stat.S_ISDIR(info.st_mode):
            entries[relative] = ("dir", stat.S_IMODE(info.st_mode), "")
        else:
            entries[relative] = ("file", stat.S_IMODE(info.st_mode), path.read_text())
    return entries


def execute(cmd: list[str], cwd: Path, env: dict[str, str]) -> tuple[int, bytes, bytes]:
    """Run one accounting step with only the runner inputs it reads.

    Parameters:
        cmd (list[str]): Interpreter and script.
        cwd (Path): Working directory, like the checkout.
        env (dict[str, str]): Synthetic runner inputs, including `PATH`.

    Returns:
        tuple[int, bytes, bytes]: Exit status, stdout (including annotations) and stderr.
    """
    # Preserve pytest-cov's subprocess environment, not the host's runner inputs.
    inherited = {key: value for key, value in os.environ.items() if key.startswith("COVERAGE_")}
    base = inherited | {"LC_ALL": "C"}
    completed = subprocess.run(cmd, cwd=cwd, env=base | env, capture_output=True, check=False, timeout=30)
    return completed.returncode, completed.stdout, completed.stderr


def run_both(
    tmp_path: Path, layout: Layout, extra: dict[str, str] | None = None, mode: int | None = None
) -> list[tuple[int, bytes, bytes, dict[str, tuple[str, int, str]]]]:
    """Run the Bash oracle and the Python CLI over identical fresh trees at the same path.

    Parameters:
        tmp_path (Path): Disposable directory.
        layout (Layout): Downloaded artifacts and prior report state.
        extra (dict[str, str] | None): Additional environment, e.g. `FAKE_UV_STATUS`.
        mode (int | None): Permission bits for the download directory while the step runs.

    Returns:
        list[tuple[int, bytes, bytes, dict[str, tuple[str, int, str]]]]: Oracle then CLI results,
        each with a snapshot of the runner temp directory.
    """
    root = tmp_path / "runner"
    env = {
        "RUNNER_TEMP": str(root / "temp"),
        "BASE": "0123abc",
        "PATH": f"{root / 'bin'}{os.pathsep}{os.environ['PATH']}",
    } | (extra or {})
    results = []
    for cmd in (["/bin/bash", "-e", str(ORACLE)], [sys.executable, str(SCRIPT)]):
        build(root, layout)
        downloads = root / "temp/windows-coverage"
        if mode is not None:
            downloads.chmod(mode)
        outcome = execute(cmd, root / "workspace", env)
        downloads.chmod(0o755)
        results.append((*outcome, snapshot(root / "temp")))
        shutil.rmtree(root)
        shutil.rmtree(tmp_path / "outside", ignore_errors=True)
    return results


@pytest.mark.parametrize("layout", LAYOUTS.values(), ids=LAYOUTS.keys())
def test_bash_parity(tmp_path: Path, layout: Layout) -> None:
    """Keep the exact status, streams and staged reports of the original step."""
    oracle, cli = run_both(tmp_path, layout)
    assert cli == oracle


@pytest.mark.parametrize("status", ["0", "3"])
def test_accounting_status_is_the_step_status(tmp_path: Path, status: str) -> None:
    """Return `coverage_accounting.py`'s status after staging, like the step's last command."""
    oracle, cli = run_both(
        tmp_path, LAYOUTS["one producer is staged and accounted"], {"FAKE_UV_STATUS": status}
    )
    assert cli == oracle
    assert cli[0] == int(status)


def test_parity_layouts_reach_every_outcome(tmp_path: Path) -> None:
    """Keep the parity table honest: it must stage and account, refuse, and stop on each failure."""
    root = tmp_path / "runner"
    staged, _ = run_both(tmp_path, LAYOUTS["one producer is staged and accounted"])
    args = [
        "run",
        "--locked",
        "--project",
        "tests/integration",
        "python",
        "scripts/coverage_accounting.py",
        "--os",
        "win32",
        "--base",
        "0123abc",
        "--reports-root",
        f"{root}/temp/windows-coverage",
        "--summary",
        "coverage/windows-x64-summary.json",
    ]
    expected = f"uv cwd={root}/workspace\n" + "".join(f"arg=[{arg}]\n" for arg in args)
    assert staged[:3] == (0, expected.encode(), b"uv stderr\n")
    for report, content in REPORTS.items():
        assert staged[3][f"windows-coverage/{NATIVE}/{report}"][2] == content
    assert f"windows-coverage/{NATIVE}/extra.txt" not in staged[3]
    kept, _ = run_both(tmp_path, LAYOUTS["staging overwrites prior reports and keeps others"])
    assert kept[3][f"windows-coverage/{NATIVE}/lcov.info"][2] == REPORTS["lcov.info"]
    assert kept[3][f"windows-coverage/{NATIVE}/compiler.log"][2] == "kept\n"
    for name in ("two producers refuse", "a producer and a matching file refuse"):
        refused, _ = run_both(tmp_path, LAYOUTS[name])
        assert refused[:3] == (1, ci_account_windows_coverage.COUNT_ERROR, b"")
    hidden, _ = run_both(tmp_path, LAYOUTS["hidden and differently cased names do not match"])
    assert hidden[0] == 0
    for name in (
        "nothing downloaded leaves the glob unmatched",
        "a dangling symlink counts as the producer",
        "a matching file counts as the producer",
        "a missing report copies the rest and fails",
        "a file where the destination belongs fails mkdir",
    ):
        failed, _ = run_both(tmp_path, LAYOUTS[name])
        assert failed[0] != 0
        assert b"uv cwd=" not in failed[1]
        assert failed[2]
    unmatched, _ = run_both(tmp_path, LAYOUTS["nothing downloaded leaves the glob unmatched"])
    assert b"windows-*/lcov.info" in unmatched[2]
    partial, _ = run_both(tmp_path, LAYOUTS["a missing report copies the rest and fails"])
    assert f"windows-coverage/{NATIVE}/coverage.json" in partial[3]
    literal, _ = run_both(tmp_path, LAYOUTS["glob characters in the producer name are literal"])
    assert literal[0] == 0


def test_glob_characters_in_runner_temp_are_literal(tmp_path: Path) -> None:
    """Match only below the literal download directory, like Bash's quoted `"$reports"` prefix."""
    oracle, cli = run_both(tmp_path / "te[m]p*", LAYOUTS["one producer is staged and accounted"])
    assert cli == oracle
    assert cli[0] == 0


def test_runner_temp_is_used_byte_for_byte(tmp_path: Path) -> None:
    """Keep a trailing slash in `RUNNER_TEMP` in every path, like Bash's string concatenation."""
    temp = f"{tmp_path / 'runner/temp'}/"
    oracle, cli = run_both(tmp_path, LAYOUTS["one producer is staged and accounted"], {"RUNNER_TEMP": temp})
    assert cli == oracle
    assert f"arg=[{temp}/windows-coverage]".encode() in cli[1]


@pytest.mark.skipif(os.geteuid() == 0, reason="root can list a directory whose mode forbids reading")
def test_unreadable_download_directory_leaves_the_glob_unmatched(tmp_path: Path) -> None:
    """Fall back to the literal pattern when the download directory cannot be listed (non-root)."""
    oracle, cli = run_both(tmp_path, LAYOUTS["one producer is staged and accounted"], mode=0o300)
    assert cli == oracle
    assert cli[0] != 0
    assert b"windows-*/lcov.info" in cli[2]


@pytest.mark.skipif(
    os.geteuid() == 0 or os.access("/", os.W_OK),
    reason="the oracle would create real directories under / when the caller can write there",
)
def test_unset_runner_inputs_read_as_empty(tmp_path: Path) -> None:
    """Read unset `RUNNER_TEMP` and `BASE` as empty, like Bash without `-u`.

    `mkdir -p /windows-coverage/...` fails without root, so both stop at `mkdir` with its status.
    The test is skipped for root or a writable `/`, where both would create real directories.
    """
    env = {"PATH": os.environ["PATH"]}
    oracle = execute(["/bin/bash", "-e", str(ORACLE)], tmp_path, env)
    cli = execute([sys.executable, str(SCRIPT)], tmp_path, env)
    assert cli == oracle


def test_fixture_is_the_current_workflow_step() -> None:
    """Pin the oracle to the step it ports until the workflow invokes the CLI instead.

    Once `run:` becomes `python3 scripts/ci_account_windows_coverage.py`, this assertion flips to
    that line and the fixture stays as the frozen original.
    """
    jobs = yaml.safe_load(WORKFLOW.read_text())["jobs"]
    step = next(step for step in jobs["owned-ubuntu"]["steps"] if step.get("name") == STEP)
    assert step["run"] == ORACLE.read_text()
    assert not set(step) & {"shell", "working-directory", "continue-on-error"}
