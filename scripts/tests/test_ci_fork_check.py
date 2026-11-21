"""Compare the Forks check CLI with its original workflow step.

References:
    https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_fork_check

SCRIPT = Path(ci_fork_check.__file__).resolve()
ORACLE = Path(__file__).resolve().parent / "fixtures/fork-check.bash.txt"
STUB = """\
import json
import os
import sys
from pathlib import Path

argv = [Path(sys.argv[0]).name, *sys.argv[1:]]
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
    """Install disposable Node command doubles, not the real fork toolchain."""
    stub = tmp_path / "stub"
    stub.write_text(f"#!{sys.executable}\n{STUB}")
    stub.chmod(0o755)
    for name in ("node", "npm", "npx"):
        (tmp_path / name).symlink_to(stub)
    return tmp_path


def execute(cmd: list[str], cwd: Path, fail: list[str]) -> tuple[int, bytes, bytes, str]:
    """Capture the status, both streams, and complete ordered argv trace."""
    trace = cwd / "calls.jsonl"
    trace.unlink(missing_ok=True)
    env = {key: value for key, value in os.environ.items() if key.startswith("COVERAGE_")}
    env |= {"PATH": str(cwd), "FAIL_ARGV": json.dumps(fail)}
    child = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, check=False, timeout=30)
    return child.returncode, child.stdout, child.stderr, trace.read_text()


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
    """Match check order, check-only Biome, drift refusal, and fail-fast behavior."""
    expected = next(
        line.split("'", 2)[1] for line in ORACLE.read_text().splitlines() if line.startswith("expected=")
    )
    (toolchain / "check.txt").write_text(expected + suffix + "\n\n")
    oracle = execute(["/bin/bash", "-e", str(ORACLE)], toolchain, fail)
    assert oracle[0] == status
    assert len(oracle[3].splitlines()) == count
    assert execute([sys.executable, str(SCRIPT)], toolchain, fail) == oracle


def test_missing_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Return shell status 127 when the toolchain cannot be started."""
    monkeypatch.setenv("PATH", str(tmp_path))
    assert ci_fork_check.main() == 127
    assert capsys.readouterr().err.startswith("node:")


def test_timeout(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Stop at a command deadline without waiting for wall time."""

    def expire(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        """Inject an elapsed subprocess deadline."""
        assert kwargs["timeout"] == 1200
        raise subprocess.TimeoutExpired(cmd, 1200)

    monkeypatch.setattr(ci_fork_check.subprocess, "run", expire)
    assert ci_fork_check.main() == 124
    assert "timed out" in capsys.readouterr().err


def test_signal() -> None:
    """Report a terminated child using the same status as Bash."""
    cmd = [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"]
    assert ci_fork_check.run(cmd) == (128 + signal.SIGTERM, b"")
