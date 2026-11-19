"""Exercise the Forks apt script with real process deadlines and disposable sources.

References:
    https://github.com/nredd/pi-harness/issues/1067
    https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
"""

from __future__ import annotations

import os
import shlex
import subprocess
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = "libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep"
AZURE = "http://azure.archive.ubuntu.com/ubuntu/"


def test_forks_apt_step_runs_unconditionally_with_budget_for_fallback() -> None:
    """Keep the shell entry point, path triggers and kill grace inside the job contract."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    step = next(
        step
        for step in workflow["jobs"]["core"]["steps"]
        if step.get("name", "").startswith("System dependencies")
    )
    assert "if" not in step
    assert "env" not in step
    assert step["working-directory"] == "."
    sudo, bash, script, source, log, update, download, install = shlex.split(step["run"].splitlines()[1])
    assert (sudo, bash, script) == ("sudo", "bash", "scripts/forks_apt.sh")
    assert source == "/etc/apt/sources.list.d/ubuntu.sources"
    assert log == "$RUNNER_TEMP/forks-apt.log"
    assert 0 < 2 * (int(update) + int(download)) + int(install) + 50 < step["timeout-minutes"] * 60
    for event in ("push", "pull_request"):
        assert {script, "scripts/ubuntu_apt.sh"}.issubset(workflow[True][event]["paths"])


@pytest.mark.parametrize(
    ("mode", "status", "attempts", "diagnostic"),
    [
        ("success", 0, ["azure-update", "azure-download", "azure-install"], ""),
        (
            "update-error",
            0,
            ["azure-update", "stock-update", "stock-download", "stock-install"],
            f"FAILED: apt-get update ({AZURE.rstrip('/')}) (status 100)",
        ),
        (
            "download-hang",
            0,
            ["azure-update", "azure-download", "stock-update", "stock-download", "stock-install"],
            f"TIMEOUT: apt-get download ({AZURE.rstrip('/')})",
        ),
        ("both-hang", 1, ["azure-update", "stock-update"], "every mirror failed"),
        (
            "install-error",
            47,
            ["azure-update", "azure-download", "azure-install"],
            "FAILED: apt-get install (status 47)",
        ),
        (
            "install-hang",
            124,
            ["azure-update", "azure-download", "azure-install"],
            "TIMEOUT: apt-get install",
        ),
    ],
)
@pytest.mark.parametrize(
    "ubuntu_uris",
    [
        ("https://azure.archive.ubuntu.com/ubuntu", "http://security.ubuntu.com/ubuntu/"),
        ("mirror+file:/etc/apt/apt-mirrors.txt", "mirror+file:/etc/apt/apt-mirrors.txt"),
    ],
    ids=["direct", "runner-mirror-list"],
)
def test_forks_apt_retries_only_mirror_work_and_streams_output(
    tmp_path: Path,
    mode: str,
    status: int,
    attempts: list[str],
    diagnostic: str,
    *,
    ubuntu_uris: tuple[str, str],
) -> None:
    """Exercise actual apt exit propagation and real timeouts across the three command phases.

    Parameters:
        tmp_path (Path): Disposable apt sources, commands and logs.
        mode (str): Stub apt behavior, including real sleeping processes.
        status (int): Expected script exit status.
        attempts (list[str]): Expected command order and selected mirrors.
        diagnostic (str): Expected failure or timeout explanation, if any.
        ubuntu_uris (tuple[str, str]): Original archive and security URIs.
    """
    sources = tmp_path / "ubuntu.sources"
    original = (
        f"Types: deb\nURIs: {ubuntu_uris[0]}\nSuites: noble noble-updates\n\n"
        f"Types: deb\nURIs: {ubuntu_uris[1]}\nSuites: noble-security\n"
    )
    sources.write_text(original)
    log = tmp_path / "apt.log"
    stub = tmp_path / "apt-get"
    stub.write_text(
        textwrap.dedent(
            """\
            #!/bin/sh
            set -eu
            selected=
            while [ "$1" = -o ]; do
                case "$2" in Dir::Etc::sourcelist=*) selected=${2#*=} ;; esac
                shift 2
            done
            case "$(grep -m1 '^URIs:' "$selected")" in
                'URIs: http://azure.archive.ubuntu.com/ubuntu/') mirror=azure ;;
                'URIs: http://archive.ubuntu.com/ubuntu/') mirror=stock ;;
                *) exit 90 ;;
            esac
            uri=$(grep -m1 '^URIs:' "$selected")
            [ "$(grep -Fxc "$uri" "$selected")" = 2 ] || exit 91
            grep -qx 'Suites: noble noble-updates' "$selected"
            grep -qx 'Suites: noble-security' "$selected"
            case "$*" in
                'update --error-on=any') phase=update ;;
                "install --yes --download-only $PACKAGES") phase=download ;;
                "install --yes --no-download $PACKAGES") phase=install ;;
                *) exit 92 ;;
            esac
            printf 'apt stdout: %s-%s\\n' "$mirror" "$phase"
            printf 'apt stderr: %s-%s\\n' "$mirror" "$phase" >&2
            case "$MODE:$mirror:$phase" in
                update-error:azure:update) exit 100 ;;
                download-hang:azure:download|both-hang:*:update|install-hang:*:install) exec /bin/sleep 30 ;;
                install-error:*:install) exit 47 ;;
            esac
            """
        )
    )
    stub.chmod(0o755)
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/forks_apt.sh"), str(sources), str(log), "1", "1", "1"],
        capture_output=True,
        check=False,
        text=True,
        env=os.environ
        | {"PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}", "MODE": mode, "PACKAGES": PACKAGES},
        timeout=20,
    )
    assert result.returncode == status, result.stdout + result.stderr
    assert diagnostic in result.stderr
    if mode == "both-hang":
        assert result.stderr.count("TIMEOUT: apt-get update") == 2
    expected = [f"apt {stream}: {attempt}" for attempt in attempts for stream in ("stdout", "stderr")]
    assert log.read_text().splitlines() == expected
    assert [line for line in result.stdout.splitlines() if line.startswith("apt ")] == expected
    assert sources.read_text() == original
