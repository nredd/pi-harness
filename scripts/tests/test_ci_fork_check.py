"""Compare the Forks check CLI with its original workflow step.

References:
    https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_fork_check

BASH = str(Path(shutil.which("bash") or "/bin/bash").absolute())
SCRIPT = Path(ci_fork_check.__file__).resolve()
ORACLE = Path(__file__).resolve().parent / "fixtures/fork-check.bash.txt"
STUB = """\
import json
import os
import sys
from pathlib import Path

argv = sys.argv[1:]
with Path('calls.jsonl').open('a') as stream:
    stream.write(json.dumps(argv) + '\\n')
if argv[:2] == ['node', '-p']:
    sys.stdout.write(Path('check.txt').read_text(newline=''))
else:
    sys.stdout.write(json.dumps(argv) + '\\n')
if argv == json.loads(os.environ['FAIL_ARGV']):
    sys.stderr.write('synthetic failure\\n')
    sys.exit(9)
"""


@pytest.fixture
def toolchain(tmp_path: Path) -> Path:
    """Install command doubles with an interpreter path containing spaces.

    Parameters:
        tmp_path (Path): Disposable checkout and PATH directory.

    Returns:
        Path: Checkout containing the command doubles and unchanged oracle.
    """
    interpreter = tmp_path / "python with spaces"
    interpreter.symlink_to(sys.executable)
    stub = tmp_path / "stub.py"
    stub.write_text(STUB)
    for name in ("node", "npm", "npx"):
        launcher = tmp_path / name
        launcher.write_text(f'#!/bin/sh\nexec {shlex.join([str(interpreter), str(stub), name])} "$@"\n')
        launcher.chmod(0o755)
    (tmp_path / "fork-check").write_bytes(ORACLE.read_bytes())
    return tmp_path


def execute(cmd: list[str], cwd: Path, fail: list[str]) -> tuple[int, bytes, bytes, str]:
    """Capture the status, both streams, and complete ordered argv trace.

    Parameters:
        cmd (list[str]): Bash oracle or Python CLI invocation.
        cwd (Path): Disposable checkout and PATH directory.
        fail (list[str]): Stub argv that should fail, or an empty list.

    Returns:
        tuple[int, bytes, bytes, str]: Exit status, stdout, stderr, and argv trace.

    Raises:
        subprocess.TimeoutExpired: The fixture invocation exceeded its test deadline.
    """
    trace = cwd / "calls.jsonl"
    trace.unlink(missing_ok=True)
    env = {key: value for key, value in os.environ.items() if key.startswith("COVERAGE_")}
    env |= {"PATH": str(cwd), "FAIL_ARGV": json.dumps(fail), "LC_ALL": "C"}
    child = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, check=False, timeout=30)
    return child.returncode, child.stdout, child.stderr, trace.read_text() if trace.is_file() else ""


def write_probe(cwd: Path, suffix: str) -> None:
    """Use the oracle's expected check list as the stub probe's output.

    Parameters:
        cwd (Path): Disposable checkout containing the stubs.
        suffix (str): Text to append before the trailing newlines.
    """
    expected = next(
        line.split("'", 2)[1] for line in ORACLE.read_text().splitlines() if line.startswith("expected=")
    )
    (cwd / "check.txt").write_text(expected + suffix + "\n\n")


@pytest.mark.parametrize(
    ("suffix", "fail", "status", "count"),
    [
        ("", [], 0, 12),
        ("\r", [], 1, 1),
        (" && npm run new-check", [], 1, 1),
        ("", ["node", "-p", 'require("./package.json").scripts.check'], 9, 1),
        ("", ["npm", "run", "check:fork-audit"], 9, 5),
        ("", ["npm", "run", "check:browser-smoke"], 9, 12),
    ],
)
def test_bash_parity(toolchain: Path, suffix: str, fail: list[str], status: int, count: int) -> None:
    """Match check order, check-only Biome, drift refusal, and fail-fast behavior.

    Parameters:
        toolchain (Path): Stub toolchain and checkout.
        suffix (str): Extra probe output before trailing newlines.
        fail (list[str]): Stub argv that should fail, or an empty list.
        status (int): Expected exit status.
        count (int): Expected number of tool invocations.
    """
    write_probe(toolchain, suffix)
    oracle = execute([BASH, "-e", "fork-check"], toolchain, fail)
    assert oracle[0] == status
    assert len(oracle[3].splitlines()) == count
    assert execute([sys.executable, str(SCRIPT)], toolchain, fail) == oracle


@pytest.mark.parametrize(("name", "status", "count"), [("node", 127, 0), ("npm", 126, 3)])
def test_tool_lookup_failure(toolchain: Path, name: str, status: int, count: int) -> None:
    """Match the oracle's exact launch diagnostic, exit, and preceding commands.

    Parameters:
        toolchain (Path): Stub toolchain and checkout.
        name (str): Tool whose launch should fail.
        status (int): Expected shell exit status.
        count (int): Expected number of invocations before failure.
    """
    tool = toolchain / name
    if name == "node":
        tool.unlink()
    else:
        tool.chmod(0o644)
    write_probe(toolchain, "")
    oracle = execute([BASH, "-e", "fork-check"], toolchain, [])
    # macOS system Bash 3.2 exits 1 for EACCES; the hosted Bash exits 126.
    if sys.platform == "darwin" and BASH == "/bin/bash" and name == "npm":
        assert oracle[0] == 1
    else:
        assert oracle[0] == status
    assert len(oracle[3].splitlines()) == count
    assert execute([sys.executable, str(SCRIPT)], toolchain, []) == (status, *oracle[1:])


def test_nul_rejected(toolchain: Path) -> None:
    """Reject a NUL rather than mimicking Bash's version-dependent warning.

    Parameters:
        toolchain (Path): Stub toolchain and checkout.
    """
    write_probe(toolchain, "\0")
    oracle = execute([BASH, "-e", "fork-check"], toolchain, [])
    assert oracle[0] == 0
    status, stdout, stderr, trace = execute([sys.executable, str(SCRIPT)], toolchain, [])
    assert (status, stdout, stderr) == (1, b"::error::forks/pi check script contains a NUL byte\n", b"")
    assert trace.splitlines() == oracle[3].splitlines()[:1]


def test_resolve_once_without_command_timeout(toolchain: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Snapshot the toolchain before the probe and pass no subprocess deadline.

    Parameters:
        toolchain (Path): Stub toolchain and checkout.
        monkeypatch (pytest.MonkeyPatch): Isolate PATH and intercept launches.
    """
    monkeypatch.chdir(toolchain)
    monkeypatch.setenv("PATH", ".")
    calls: list[str] = []

    def launch(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        """Check the resolved argv and change PATH after the first launch.

        Parameters:
            cmd (list[str]): Actual subprocess argv.
            **kwargs (object): Subprocess options.

        Returns:
            subprocess.CompletedProcess[bytes]: Successful synthetic subprocess result.
        """
        calls.append(Path(cmd[0]).name)
        assert Path(cmd[0]) == toolchain / calls[-1]
        assert kwargs.get("timeout") is None
        monkeypatch.setenv("PATH", str(toolchain / "missing"))
        return subprocess.CompletedProcess(cmd, 0, stdout=ci_fork_check.EXPECTED_CHECK.encode())

    monkeypatch.setattr(ci_fork_check.subprocess, "run", launch)
    assert ci_fork_check.main() == 0
    assert set(calls) == {"node", "npm", "npx"}


@pytest.mark.parametrize(("executable_exists", "status"), [(False, 127), (True, 126)])
def test_resolved_tool_cannot_launch(toolchain: Path, executable_exists: bool, status: int) -> None:
    """Fail closed if a resolved file disappears or loses execute permission.

    Parameters:
        toolchain (Path): Stub toolchain and checkout.
        executable_exists (bool): Keep the resolved file but make it non-executable.
        status (int): Expected shell exit status.
    """
    tools = {"node": ci_fork_check.resolve_tool("node", str(toolchain))}
    tool = toolchain / "node"
    if executable_exists:
        tool.chmod(0o644)
    else:
        tool.unlink()
    assert ci_fork_check.run(["node"], tools, 4) == (status, b"")


def test_signal() -> None:
    """Report a terminated child using the same status as Bash."""
    tools = {"python": (Path(sys.executable), None)}
    cmd = ["python", "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"]
    assert ci_fork_check.run(cmd, tools, 4) == (128 + signal.SIGTERM, b"")
