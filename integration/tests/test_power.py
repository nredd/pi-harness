"""Regression coverage for command-scoped wake assertions and cleanup.

References:
- caffeinate(8): https://keith.github.io/xcode-man-pages/caffeinate.8.html
"""

from __future__ import annotations

import os
import subprocess
import sys
from unittest.mock import MagicMock

import pytest

from harness import power


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS wake assertions")
def test_runner_holds_assertion(awake_host: None) -> None:
    """Direct pytest invocations keep detached tmux benchmarks out of maintenance sleep.

    Parameters:
        awake_host (None): fixture holding this runner's wake assertion.
    """
    processes = subprocess.check_output(
        ["/bin/ps", "-axo", "pid,ppid,args"], text=True, stderr=subprocess.STDOUT
    )
    assert any(
        fields[1] == str(os.getpid()) and fields[2:] == [power.CAFFEINATE, "-disu", "-w", str(os.getpid())]
        for line in processes.splitlines()[1:]
        if len(fields := line.split()) >= 3
    ), "pytest owns no macOS wake assertion helper"


@pytest.mark.parametrize("failure", [False, True])
def test_scope_releases_assertions(monkeypatch: pytest.MonkeyPatch, failure: bool) -> None:
    """Both successful tests and failed tests release only their own assertion process."""
    process = MagicMock()
    spawn = MagicMock(return_value=process)
    monkeypatch.setattr(power.sys, "platform", "darwin")
    monkeypatch.setattr(power.subprocess, "Popen", spawn)
    if failure:
        with pytest.raises(RuntimeError, match="test failure"), power.keep_awake():
            raise RuntimeError("test failure")
    else:
        with power.keep_awake():
            process.terminate.assert_not_called()
    assert spawn.call_args.args[0] == [power.CAFFEINATE, "-disu", "-w", str(os.getpid())]
    process.terminate.assert_called_once()
    process.wait.assert_called_once_with(timeout=power.STOP_TIMEOUT_S)


def test_other_platform_never_spawns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Linux and WSL measurements do not depend on a macOS utility."""
    spawn = MagicMock()
    monkeypatch.setattr(power.sys, "platform", "linux")
    monkeypatch.setattr(power.subprocess, "Popen", spawn)
    with power.keep_awake():
        spawn.assert_not_called()


def test_stuck_helper_is_reaped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A helper that ignores termination is killed and waited for, never leaked."""
    process = MagicMock()
    process.wait.side_effect = [subprocess.TimeoutExpired("caffeinate", 5), 0]
    monkeypatch.setattr(power.sys, "platform", "darwin")
    monkeypatch.setattr(power.subprocess, "Popen", MagicMock(return_value=process))
    with power.keep_awake():
        pass
    process.kill.assert_called_once()
    assert process.wait.call_count == 2
