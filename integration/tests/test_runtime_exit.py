"""Assert exit status and synchronous exit events at the public engine boundary.

These small fixtures are contract coverage, not a reproduction of the native macOS
standalone crash in #155/#178. The unchanged stack/startup scenarios exercise real Pi.

References:
    https://nodejs.org/api/process.html#event-exit
    https://github.com/nredd/pi-harness/issues/100
    https://github.com/nredd/pi-harness/issues/108
"""

from __future__ import annotations

import shutil
import subprocess

import pytest


@pytest.mark.parametrize("engine", ["node", "bun"])
@pytest.mark.parametrize("mode", ["explicit", "natural", "eof", "listener"])
def test_exit_event_and_status(engine: str, mode: str) -> None:
    """Observe exact output, exit event count and status without retries or signal masking.

    Parameters:
        engine (str): Required development engine from PATH.
        mode (str): Explicit process.exit, natural drain, stdin EOF or exit-listener status override.
    """
    executable = shutil.which(engine)
    assert executable is not None, f"Required engine '{engine}' is absent"
    endings = {
        "explicit": "process.exit(7);",
        "listener": 'process.on("exit", () => { process.exitCode = 9; }); process.exit(7);',
        "natural": "process.exitCode = 7;",
        "eof": 'process.stdin.resume(); process.stdin.on("end", () => { process.exitCode = 7; });',
    }
    script = (
        'process.on("exit", code => { process.stdout.write(`exit:${code}\\n`); });'
        'process.stdout.write("ready\\n");' + endings[mode]
    )
    result = subprocess.run(
        [executable, "-e", script], input="", capture_output=True, text=True, timeout=10, check=False
    )
    assert result.returncode == (9 if mode == "listener" else 7), result
    assert result.stdout == "ready\nexit:7\n", result
    assert result.stderr == "", result
