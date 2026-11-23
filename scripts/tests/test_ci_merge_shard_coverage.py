"""Compare the owned fan-in's shard coverage merge CLI with its original Bash step.

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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_merge_shard_coverage

SCRIPT = Path(ci_merge_shard_coverage.__file__).resolve()
# Original `Merge the shards' coverage reports` run block from ci.yml.
ORACLE = Path(__file__).resolve().parent / "fixtures/merge-shard-coverage.bash.txt"
LINK = "->"

# Each layout maps a path under `shard-coverage` (or `workspace/` for prior checkout state) to file
# content, or to `(LINK, target)` for a symlink.
Layout = dict[str, str | tuple[str, str]]

LAYOUTS: dict[str, Layout] = {
    "distinct shards merge in byte order": {
        "coverage-ubuntu-24.04-python/scripts/coverage/primary/lcov.info": "python\n",
        "coverage-ubuntu-24.04-python/tests/integration/coverage/python/lcov.info": "integration\n",
        "coverage-ubuntu-24.04-Subagents/packages/subagents/coverage/primary/lcov.info": "subagents\n",
        "coverage-ubuntu-24.04-python/.nyc/hidden.json": "hidden inside a shard\n",
        "coverage-ubuntu-24.04-python/top.info": "shard root file\n",
        "stray.txt": "top-level file, neither checked nor merged\n",
        "workspace/scripts/coverage/primary/lcov.info": "stale checkout copy\n",
    },
    "duplicates are sorted, unique and space joined": {
        "a/z/lcov.info": "a\n",
        "b/z/lcov.info": "b\n",
        "c/z/lcov.info": "c\n",
        "a/m n\\o/r\u00e9sum\u00e9.info": "a\n",
        "b/m n\\o/r\u00e9sum\u00e9.info": "b\n",
        "a/A/lcov.info": "a\n",
        "c/A/lcov.info": "c\n",
        "a/only-a.info": "a\n",
    },
    "hidden top-level directory counts but is not merged": {
        ".hidden/report.info": "hidden\n",
        "visible/report.info": "visible\n",
    },
    "hidden top-level directory alone leaves the glob unmatched": {
        ".hidden/report.info": "hidden\n",
    },
    "nothing downloaded leaves the glob unmatched": {},
    "symlinked shard merges but is not searched": {
        "real/report.info": "real\n",
        "linked": (LINK, "../outside"),
        "../outside/report.info": "outside\n",
    },
    "symlinked report is not a duplicate": {
        "a/report.info": "a\n",
        "b/report.info": (LINK, "../a/report.info"),
    },
    "newline names split like find and cut": {
        "a/x\ny": "a\n",
        "b/x\ny": "b\n",
    },
    "leading newline duplicate is dropped by command substitution": {
        "a/\nz": "a\n",
        "b/\nz": "b\n",
    },
    "leading newline duplicate before another is printed": {
        "a/\nz": "a\n",
        "b/\nz": "b\n",
        "a/report.info": "a\n",
        "b/report.info": "b\n",
    },
    "top-level files are outside find's mindepth": {
        "stray.txt": "top\n",
        "a/\nz": "a\n",
        "a/report.info": "a\n",
        "b/report.info": "b\n",
    },
    "cp failure stops the merge with its status": {
        "a/first/report.info": "a\n",
        "b/blocked/report.info": "b\n",
        "workspace/blocked": "a file where the shard needs a directory\n",
    },
}


def build(root: Path, layout: Layout) -> None:
    """Create a downloaded-artifact tree and its checkout under `root`.

    Parameters:
        root (Path): Empty runner directory holding `temp/shard-coverage` and `workspace`.
        layout (Layout): Paths relative to `temp/shard-coverage` and their content or link target.
    """
    downloads = root / "temp/shard-coverage"
    downloads.mkdir(parents=True)
    (root / "workspace").mkdir()
    for relative, content in layout.items():
        path = root / relative if relative.startswith("workspace/") else downloads / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, tuple):
            path.symlink_to(content[1])
        else:
            path.write_text(content)


def snapshot(workspace: Path) -> dict[str, tuple[str, int, str]]:
    """Record every merged entry's type, mode and content or link target.

    Parameters:
        workspace (Path): Checkout the step merged into.

    Returns:
        dict[str, tuple[str, int, str]]: Relative path to kind, permission bits and payload.
    """
    entries: dict[str, tuple[str, int, str]] = {}
    for path in sorted(workspace.rglob("*")):
        info = path.lstat()
        relative = path.relative_to(workspace).as_posix()
        if stat.S_ISLNK(info.st_mode):
            entries[relative] = ("link", 0, str(path.readlink()))
        elif stat.S_ISDIR(info.st_mode):
            entries[relative] = ("dir", stat.S_IMODE(info.st_mode), "")
        else:
            entries[relative] = ("file", stat.S_IMODE(info.st_mode), path.read_text())
    return entries


def execute(cmd: list[str], root: Path, env: dict[str, str]) -> tuple[int, bytes, bytes]:
    """Run one merge with only the runner inputs it reads.

    Parameters:
        cmd (list[str]): Absolute interpreter path and script.
        root (Path): Runner directory; also the working directory, like the checkout.
        env (dict[str, str]): Synthetic `RUNNER_TEMP` / `GITHUB_WORKSPACE`.

    Returns:
        tuple[int, bytes, bytes]: Exit status, stdout (including annotations) and stderr.
    """
    # Preserve pytest-cov's subprocess environment, not the host's runner inputs. `LC_ALL=C` is the
    # hosted runner's `C.UTF-8` byte order on hosts that lack that locale.
    inherited = {key: value for key, value in os.environ.items() if key.startswith("COVERAGE_")}
    base = inherited | {"PATH": os.environ["PATH"], "LC_ALL": "C"}
    completed = subprocess.run(cmd, cwd=root, env=base | env, capture_output=True, check=False, timeout=30)
    return completed.returncode, completed.stdout, completed.stderr


def run_both(
    tmp_path: Path, layout: Layout
) -> list[tuple[int, bytes, bytes, dict[str, tuple[str, int, str]]]]:
    """Run the Bash oracle and the Python CLI over identical fresh trees at the same path.

    Parameters:
        tmp_path (Path): Disposable directory.
        layout (Layout): Downloaded artifacts and prior checkout state.

    Returns:
        list[tuple[int, bytes, bytes, dict[str, tuple[str, int, str]]]]: Oracle then CLI results.
    """
    root = tmp_path / "runner"
    env = {"RUNNER_TEMP": str(root / "temp"), "GITHUB_WORKSPACE": str(root / "workspace")}
    results = []
    for cmd in (["/bin/bash", "-e", str(ORACLE)], [sys.executable, str(SCRIPT)]):
        build(root, layout)
        results.append((*execute(cmd, root, env), snapshot(root / "workspace")))
        shutil.rmtree(root)
    return results


@pytest.mark.parametrize("layout", LAYOUTS.values(), ids=LAYOUTS.keys())
def test_bash_parity(tmp_path: Path, layout: Layout) -> None:
    """Keep the exact status, streams and merged checkout of the original step."""
    oracle, cli = run_both(tmp_path, layout)
    assert cli == oracle


def test_parity_layouts_reach_every_outcome(tmp_path: Path) -> None:
    """Keep the parity table honest: it must merge, refuse duplicates and propagate `cp` failure."""
    merged, _ = run_both(tmp_path, LAYOUTS["distinct shards merge in byte order"])
    assert merged[:2] == (
        0,
        b"Merging coverage-ubuntu-24.04-Subagents\nMerging coverage-ubuntu-24.04-python\n",
    )
    assert merged[3]["scripts/coverage/primary/lcov.info"][2] == "python\n"
    assert ".nyc/hidden.json" in merged[3]
    assert "stray.txt" not in merged[3]
    refused, _ = run_both(tmp_path, LAYOUTS["duplicates are sorted, unique and space joined"])
    assert refused[:2] == (
        1,
        b"::error title=duplicate shard coverage::More than one shard produced: "
        b"A/lcov.info m n\\o/r\xc3\xa9sum\xc3\xa9.info z/lcov.info\n",
    )
    assert refused[3] == {}
    newline, _ = run_both(tmp_path, LAYOUTS["newline names split like find and cut"])
    assert newline[:2] == (1, b"::error title=duplicate shard coverage::More than one shard produced: x y\n")
    blank, _ = run_both(tmp_path, LAYOUTS["leading newline duplicate before another is printed"])
    assert blank[:2] == (
        1,
        b"::error title=duplicate shard coverage::More than one shard produced:  report.info z\n",
    )
    stray, _ = run_both(tmp_path, LAYOUTS["top-level files are outside find's mindepth"])
    assert stray[:2] == (
        1,
        b"::error title=duplicate shard coverage::More than one shard produced: report.info\n",
    )
    unmatched, _ = run_both(tmp_path, LAYOUTS["nothing downloaded leaves the glob unmatched"])
    assert unmatched[:2] == (1, b"Merging *\n")
    assert b"*/." in unmatched[2]
    blocked, _ = run_both(tmp_path, LAYOUTS["cp failure stops the merge with its status"])
    assert blocked[0] != 0
    assert blocked[1] == b"Merging a\nMerging b\n"
    assert "first/report.info" in blocked[3]


@pytest.mark.parametrize("runner_temp", [None, "file"])
def test_unusable_download_directory_fails_like_cd(tmp_path: Path, runner_temp: str | None) -> None:
    """Fail with status one and no stdout when the download directory is missing or not a directory.

    Bash prefixes its own `cd` diagnostic with the script location, so only the CLI's is pinned.
    """
    (tmp_path / "file").write_text("")
    env = {"GITHUB_WORKSPACE": str(tmp_path / "workspace")}
    if runner_temp is not None:
        env["RUNNER_TEMP"] = str(tmp_path / runner_temp)
    oracle = execute(["/bin/bash", "-e", str(ORACLE)], tmp_path, env)
    status, stdout, stderr = execute([sys.executable, str(SCRIPT)], tmp_path, env)
    assert (status, stdout) == oracle[:2] == (1, b"")
    source = env.get("RUNNER_TEMP", "") + "/shard-coverage"
    assert stderr.decode().startswith(f"cd: {source}: ")
    assert b"cd:" in oracle[2]
    assert not (tmp_path / "workspace").exists()
