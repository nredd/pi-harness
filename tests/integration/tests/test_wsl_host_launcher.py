"""Execute the Git-Bash host adapter's refusal and forwarding contract.

References:
    https://github.com/nredd/pi-harness/issues/695
    https://www.msys2.org/docs/filesystem-paths/#environment-variables

The command fixtures do not execute PowerShell, MSYS conversion or WSL. Those
runtime boundaries remain the responsibility of the real hosted Windows cells.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / "scripts/wsl2_host.sh"
EXPECTED = r"C:\Program Files\Git\bin\bash.exe"


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[dict[str, str], Path]:
    """Build a closed PATH so missing commands cannot fall through to host tools.

    Parameters:
        tmp_path (Path): Disposable command and output directory.
    Returns:
        tuple[dict[str, str], Path]: Minimal environment and dispatch receipt.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    tr = shutil.which("tr")
    assert tr is not None
    (commands / "tr").symlink_to(tr)
    # command -v must find this fixture, but the launcher must never execute it.
    (commands / "bash").write_text("#!/bin/sh\nexit 91\n", encoding="utf-8")
    (commands / "cygpath").write_text(
        '#!/bin/sh\n[ "$1" = -w ] && [ "$2" = "$BASH_FIXTURE" ] || exit 92\n'
        'printf "%s" "$RESOLVED_BASH"\nexit "${CONVERSION_STATUS:-0}"\n',
        encoding="utf-8",
    )
    (commands / "pwsh").write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['CAPTURE']).write_text(json.dumps({\n"
        "    'argv': sys.argv[1:],\n"
        "    'exclusions': os.environ['MSYS2_ENV_CONV_EXCL'],\n"
        "    'pi_bin': os.environ['PI_BIN'],\n"
        "}))\n"
        "sys.exit(int(os.environ.get('DISPATCH_STATUS', '0')))\n",
        encoding="utf-8",
    )
    for name in ("bash", "cygpath", "pwsh"):
        (commands / name).chmod(0o755)
    capture = tmp_path / "capture.json"
    env = {
        "PATH": str(commands),
        "BASH_FIXTURE": str(commands / "bash"),
        "PI_CI_GIT_BASH": EXPECTED,
        "RESOLVED_BASH": EXPECTED,
        "GITHUB_WORKSPACE": str(tmp_path / "checkout with spaces"),
        "PI_BIN": "/opt/pi-fixture/bin/pi",
        "CAPTURE": str(capture),
    }
    return env, capture


def run_launcher(env: dict[str, str], step: Path) -> subprocess.CompletedProcess[str]:
    """Execute the unchanged adapter with an inert generated-step path.

    Parameters:
        env (dict[str, str]): Isolated command boundary.
        step (Path): Script argument forwarded without evaluation or modification.
    Returns:
        subprocess.CompletedProcess[str]: Captured adapter status and output.
    """
    return subprocess.run(
        ["/bin/bash", str(HOST), str(step)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )


@pytest.mark.parametrize(
    "resolved",
    [
        "c:/program files/git/bin/bash.exe",
        r"C:\PROGRAM FILES\Git\usr\bin\bash.exe",
        "C:/Program Files/Git/bin/bash",
    ],
)
@pytest.mark.parametrize("exclusions", [None, "", "EXISTING;/fixture"])
def test_selected_bash_normalization_preserves_dispatch(
    tmp_path: Path, launcher: tuple[dict[str, str], Path], resolved: str, exclusions: str | None
) -> None:
    """Accept normalized selection/launcher paths without losing existing exclusions.

    Parameters:
        tmp_path (Path): Disposable generated-step directory.
        launcher (tuple[dict[str, str], Path]): Closed command fixtures and receipt.
        resolved (str): Selected Git-Bash path returned by cygpath.
        exclusions (str | None): Existing MSYS exclusion list, including unset/empty.
    """
    env, capture = launcher
    env |= {"RESOLVED_BASH": resolved, "DISPATCH_STATUS": "49"}
    if exclusions is not None:
        env["MSYS2_ENV_CONV_EXCL"] = exclusions
    step = tmp_path / "step 'quoted' ; $unevaluated.sh"
    original = b"exit 95\n"
    step.write_bytes(original)
    result = run_launcher(env, step)
    assert result.returncode == 49, result.stderr
    assert result.stdout == result.stderr == ""
    assert json.loads(capture.read_text(encoding="utf-8")) == {
        "argv": ["-NoProfile", "-File", f"{env['GITHUB_WORKSPACE']}/scripts/wsl2_shell.ps1", str(step)],
        "exclusions": f"PI_BIN;{exclusions}" if exclusions else "PI_BIN",
        "pi_bin": "/opt/pi-fixture/bin/pi",
    }
    assert step.read_bytes() == original


@pytest.mark.parametrize("receipt", [None, ""])
def test_missing_selection_receipt_refuses_dispatch(
    tmp_path: Path, launcher: tuple[dict[str, str], Path], receipt: str | None
) -> None:
    """Fail before dispatch for both missing and empty pre-plan receipts.

    Parameters:
        tmp_path (Path): Disposable step directory.
        launcher (tuple[dict[str, str], Path]): Closed command fixtures and receipt.
        receipt (str | None): Empty receipt or absent environment entry.
    """
    env, capture = launcher
    env.pop("PI_CI_GIT_BASH")
    if receipt is not None:
        env["PI_CI_GIT_BASH"] = receipt
    result = run_launcher(env, tmp_path / "step.sh")
    assert result.returncode != 0
    assert "Git Bash selection receipt is missing" in result.stderr
    assert not capture.exists()


@pytest.mark.parametrize("resolved", [r"C:\Windows\System32\bash.exe", "C:/Other/Git/bin/bash.exe"])
def test_shadowing_bash_refuses_dispatch(
    tmp_path: Path, launcher: tuple[dict[str, str], Path], resolved: str
) -> None:
    """Reject both legacy Bash and a different Git installation.

    Parameters:
        tmp_path (Path): Disposable step directory.
        launcher (tuple[dict[str, str], Path]): Closed command fixtures and receipt.
        resolved (str): Unselected Windows Bash executable.
    """
    env, capture = launcher
    env["RESOLVED_BASH"] = resolved
    result = run_launcher(env, tmp_path / "step.sh")
    assert result.returncode == 1
    assert "Refusing ambiguous Bash" in result.stderr
    assert not capture.exists()


def test_failed_path_conversion_refuses_dispatch(
    tmp_path: Path, launcher: tuple[dict[str, str], Path]
) -> None:
    """Preserve a cygpath failure even when its stdout looks like the expected path.

    Parameters:
        tmp_path (Path): Disposable step directory.
        launcher (tuple[dict[str, str], Path]): Closed command fixtures and receipt.
    """
    env, capture = launcher
    env["CONVERSION_STATUS"] = "47"
    result = run_launcher(env, tmp_path / "step.sh")
    assert result.returncode == 47
    assert not capture.exists()


def test_missing_powershell_names_the_failed_hop(
    tmp_path: Path, launcher: tuple[dict[str, str], Path]
) -> None:
    """Return the shell's missing-command status rather than dispatching elsewhere.

    Parameters:
        tmp_path (Path): Disposable step directory.
        launcher (tuple[dict[str, str], Path]): Closed command fixtures and receipt.
    """
    env, capture = launcher
    (Path(env["PATH"]) / "pwsh").unlink()
    result = run_launcher(env, tmp_path / "step.sh")
    assert result.returncode == 127
    assert result.stderr == "wsl2-host: pwsh command not found\n"
    assert not capture.exists()
