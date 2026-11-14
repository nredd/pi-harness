"""Lock down the native WSL2 workflow's platform and harness boundaries.

References:
    https://learn.microsoft.com/windows/wsl/basic-commands
    https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
"""

from __future__ import annotations

import os
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import textwrap
from enum import StrEnum
from pathlib import Path
from typing import cast

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
SCRIPTS = ROOT / "scripts"


def workflow_text() -> str:
    """Return the native WSL2 workflow text.

    Returns:
        str: UTF-8 workflow contents.
    """
    return WORKFLOW.read_text(encoding="utf-8")


def test_wsl2_workflow_runs_for_pull_requests_and_main() -> None:
    """Keep the stable WSL2 check present on every review and merged tree."""
    workflow = workflow_text()
    assert "  pull_request:" in workflow
    assert "    branches: [main]" in workflow
    assert not (WORKFLOW.parent / "wsl2.yml").exists()
    # `contracts` and `stack` keep the three-OS matrix; `owned` is one fan-in per OS whose shards take their
    # runner from the plan (`ci_paths.RUNNERS`, pinned to the `contracts` matrix by a test).
    assert workflow.count("os: [ubuntu-24.04, macos-14, wsl2]") == 2
    assert workflow.count("runner: windows-2025") == 1
    assert "os: [wsl2]" in workflow
    assert "runs-on: &owned-shard-runner ${{ matrix.runner }}" in workflow
    assert "runs-on: wsl2" not in workflow
    assert "timeout-minutes: ${{ matrix.os == 'wsl2' && 45 || 30 }}" in workflow
    assert "timeout-minutes: 40" in workflow
    assert "contents: read" in workflow


def test_wsl2_workflow_fails_closed_on_platform_or_mount_mismatch() -> None:
    """Require explicit WSL2 proof and Linux-filesystem execution."""
    action = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    setup = (ROOT / "scripts/wsl2_setup.sh").read_text()
    assert "wsl-version: '2'" in action
    assert "wsl --list --verbose" in action
    assert "-replace ([char]0), ''" in (ROOT / "scripts/wsl2_bounded.ps1").read_text()
    assert "Ubuntu-24\\.04" in action
    assert "core.autocrlf false" in action
    assert "Expected Windows source below /mnt" in setup
    assert "Harness worktree is not on a Linux filesystem" in setup
    assert "findmnt --noheadings --output FSTYPE" in setup
    assert "drvfs|''" in setup


def test_wsl2_workflow_preserves_and_uploads_bounded_diagnostics() -> None:
    """Keep the executable cleanup and bounded upload attached to the native job."""
    workflow = workflow_text()
    assert "wsl2-diagnostics" in workflow
    assert not (SCRIPTS / "wsl2_cleanup.sh").exists()
    assert workflow.count("cleanup: cleanup") == 2
    # Both cleanup captures see timeouts and cancels, which leave no guest first-failure record.
    assert workflow.count("cleanup: cleanup\n          job-status: ${{ job.status }}\n") == 2
    action = (ROOT / ".github/actions/capture-ci-wsl/action.yml").read_text()
    assert "WSL_JOB_STATUS: ${{ inputs.job-status }}" in action
    assert ":WSL_JOB_STATUS'" in action
    assert workflow.count("path: ${{ runner.temp }}/wsl2-diagnostics/") == 2
    assert "if: always()" in workflow
    assert "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" in workflow
    assert "if-no-files-found: warn" in workflow
    assert "PI_BIN" in workflow


def test_wsl2_capture_mirrors_only_coverage_reports_and_clears_stale_files(tmp_path: Path) -> None:
    """Export independent guest LCOV/summary reports without copying source or stale evidence.

    Parameters:
        tmp_path (Path): Disposable guest home and Windows-visible workspace.
    Returns:
        None: Only declared reports cross the boundary; a second empty capture removes them.
    Raises:
        AssertionError: Reports disappear, unrelated content leaks or stale reports survive.
        subprocess.CalledProcessError: The real capture script fails.
    """
    home = tmp_path / "home"
    guest = home / "pi-harness-ci"
    host = tmp_path / "host"
    temporary = tmp_path / "temporary"
    host.mkdir()
    temporary.mkdir()
    (guest / ".ci-temp").mkdir(parents=True)
    (guest / ".ci-temp/tool-path").write_text(os.environ["PATH"])
    reports = [
        "packages/example/coverage/primary/lcov.info",
        "packages/example/coverage/primary/coverage-summary.json",
        "packages/example/coverage/bun/lcov.info",
        "packages/example/coverage/bun/coverage-summary.json",
        "integration/inprocess/coverage/primary/lcov.info",
        "integration/probes/coverage/primary/lcov.info",
        "integration/providers/coverage/primary/lcov.info",
        "scripts/coverage/primary/lcov.info",
        "coverage/summary.json",
    ]
    for relative in reports:
        path = guest / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"fixture {relative}\n")
    (guest / "coverage/unexpected.txt").write_text("not a report")
    capture = ROOT / "scripts/wsl2_capture.sh"
    env = os.environ | {
        "HOME": str(home),
        "WSL_HOST_WORKSPACE": str(host),
        "WSL_HOST_TEMP": str(temporary),
        "PI_BIN": "",
    }
    subprocess.run(["/bin/bash", str(capture)], env=env, check=True, capture_output=True)
    assert {path.relative_to(host).as_posix() for path in host.rglob("*") if path.is_file()} == set(reports)
    for relative in reports:
        assert (host / relative).read_text() == f"fixture {relative}\n"
        (guest / relative).unlink()
    subprocess.run(["/bin/bash", str(capture)], env=env, check=True, capture_output=True)
    assert not any(path.is_file() for path in host.rglob("*"))


def coverage_summary_step() -> dict[str, str]:
    """Return the unique production summary step, independent of YAML formatting.

    Returns:
        dict[str, str]: The actual workflow step's scalar settings and Bash body.
    """
    workflow = yaml.safe_load(workflow_text())
    steps = [
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])  # reusable-workflow jobs have no steps
        if step.get("name") == "Report coverage exclusions"
    ]
    assert len(steps) == 1
    return steps[0]


def run_host_summary(step: dict[str, str], tmp_path: Path) -> str:
    """Execute the real host Bash body and return its summary, failing on guest dispatch.

    Parameters:
        step (dict[str, str]): Summary step settings and actual Bash body.
        tmp_path (Path): Isolated directory with no guest worktree or tooling.
    Returns:
        str: UTF-8 summary written by the real step.
    Raises:
        AssertionError: The step selects a different shell or working directory.
        subprocess.CalledProcessError: The summary body fails under Bash.
        FileNotFoundError: The summary body does not write its declared output.
    """
    assert step["shell"] == "bash -e {0}"
    assert "working-directory" not in step
    summary = tmp_path / "summary.txt"
    script = tmp_path / "summary.sh"
    script.write_text(step["run"], encoding="utf-8")
    subprocess.run(
        ["/bin/bash", "-e", str(script)],
        cwd=tmp_path,
        env={"GITHUB_STEP_SUMMARY": str(summary)},
        check=True,
        capture_output=True,
        text=True,
    )
    return summary.read_text(encoding="utf-8")


def test_wsl2_coverage_summary_runs_on_the_host_with_native_bash_semantics(tmp_path: Path) -> None:
    """Write the summary with the test runner's Bash, without guest tools or environment."""
    summary = run_host_summary(coverage_summary_step(), tmp_path)
    assert summary.strip()


@pytest.mark.parametrize("shell", ["pwsh", "wsl-bash {0}", "bash {0}"])
def test_wsl2_coverage_summary_rejects_non_native_shell(shell: str, tmp_path: Path) -> None:
    """Reject guest dispatch and loss of the explicit Bash failure semantics."""
    step = coverage_summary_step() | {"shell": shell}
    with pytest.raises(AssertionError):
        run_host_summary(step, tmp_path)


def test_wsl2_coverage_summary_preserves_bash_failure_status(tmp_path: Path) -> None:
    """Control the runner's Bash semantics with a failure before a successful write."""
    step = coverage_summary_step() | {"run": '/bin/bash -c "exit 47"\necho masked >>"$GITHUB_STEP_SUMMARY"'}
    with pytest.raises(subprocess.CalledProcessError) as error:
        run_host_summary(step, tmp_path)
    assert error.value.returncode == 47


def test_wsl2_coverage_summary_propagates_production_output_failure(tmp_path: Path) -> None:
    """Require the actual production body to fail when its summary target is a directory."""
    (tmp_path / "summary.txt").mkdir()
    with pytest.raises(subprocess.CalledProcessError) as error:
        run_host_summary(coverage_summary_step(), tmp_path)
    assert error.value.returncode != 0


@pytest.mark.parametrize(
    ("scope", "disclosure"),
    [
        ("Bun standalone", r"no skips.*#14"),
        ("Bun standalone", r"step outcome and JUnit.*not this notice"),
        *[
            (scope, "NOT RUN")
            for scope in (
                "linux-arm64",
                "packed contracts under standalone",
                "bench",
                "live credentials",
                "desktop helpers",
            )
        ],
    ],
)
def test_coverage_summary_discloses_scope(scope: str, disclosure: str, tmp_path: Path) -> None:
    """Check scoped runtime limitations, not a complete friendly-prose sentence."""
    summary = run_host_summary(coverage_summary_step(), tmp_path)
    assert any(scope in line and re.search(disclosure, line) for line in summary.splitlines())
    # Each disclosure must fail closed if either its scope or its limitation disappears.
    for mutated in (summary.replace(scope, "omitted"), re.sub(disclosure, "omitted", summary)):
        assert not any(scope in line and re.search(disclosure, line) for line in mutated.splitlines())


def test_wsl2_workflow_reuses_the_release_and_stack_entrypoints() -> None:
    """Require actual Pi startup, RPC, extension, and stack process coverage."""
    workflow = workflow_text()
    assert "git submodule update --init forks/pi" in workflow
    setup = (ROOT / "scripts/wsl2_setup.sh").read_text()
    assert 'test "$(bun --version)" = "$bun_version"' in setup
    assert "bun-v$bun_version" in setup
    assert "uv_version=0.13.1" in setup
    assert '"uv $uv_version"*' in setup
    assert "uv run --locked python -m harness.release" in workflow
    assert "--gitlink ../forks/pi" in workflow
    assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in workflow
    assert '--stack "stacks/${{ matrix.stack }}.json" -m stack -n 2 --dist loadfile' in workflow
    assert "--stack stacks/personal.json --runtime bun-standalone" in workflow
    assert "--stack stacks/local.json --runtime bun-standalone" in workflow


INSTALL_GH = SCRIPTS / "install_gh_linux.sh"
INSTALL_GH_PY = INSTALL_GH.with_suffix(".py")


def test_wsl2_workflow_bootstraps_gh_and_verifies_overrides_before_npm_ci() -> None:
    """Install attestation-capable `gh`, forward the token via WSLENV, and gate `npm ci` on verification."""
    workflow = workflow_text()
    setup = (ROOT / "scripts/wsl2_setup.sh").read_text()
    wrapper = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    assert "GH_TOKEN: ${{ github.token }}" in workflow
    assert "GH_TOKEN/u" in wrapper
    assert "Core Gitlink:" in (ROOT / "scripts/wsl2_capture.py").read_text(encoding="utf-8")
    action = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    assert "additional-packages" not in action
    assert "python3" in (ROOT / "scripts/wsl2_apt.sh").read_text().split("packages=(")[1].splitlines()[0]
    assert "unset GH_TOKEN" in setup
    assert 'bash scripts/install_gh_linux.sh "$tool_dir/gh"' in setup
    makefile = (ROOT / "Makefile").read_text()
    assert "env -u GH_TOKEN npm ci --ignore-scripts" in makefile
    assert "env -u GH_TOKEN uv sync --locked" in makefile
    assert "cd integration && uv sync --locked --python" in workflow
    # Inspect the stack's guest commands, not an unrelated native Windows npm installation.
    commands = "\n".join(step.get("run", "") for step in yaml.safe_load(workflow)["jobs"]["stack"]["steps"])
    verify = commands.index("python3 -m harness.release --verify-root-overrides --root .")
    npm_ci = commands.index("npm ci --ignore-scripts")
    assert verify < npm_ci
    assert "echo $GH_TOKEN" not in workflow


def run_install_gh(tmp_path: Path, system: str, machine: str) -> subprocess.CompletedProcess[str]:
    """Run the real installer with `uname` and `curl` stubs, serving junk bytes as the tarball.

    Parameters:
        tmp_path (Path): Scratch directory.
        system (str): `uname -s` output.
        machine (str): `uname -m` output.

    Returns:
        subprocess.CompletedProcess[str]: Installer outcome.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "uname").write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import sys

            print({system!r} if sys.argv[1] == "-s" else {machine!r})
            """
        ),
        encoding="utf-8",
    )
    # macOS has no `sha256sum`: a portable stand-in that verifies the digest and path from stdin and
    # records that it ran, so a wrong pinned digest or archive fails the check for the right reason.
    (commands / "sha256sum").write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import hashlib
            import sys
            from pathlib import Path

            Path({str(tmp_path / "sha256sum-ran")!r}).touch()
            digest, _, path = sys.stdin.readline().rstrip("\\n").partition("  ")
            sys.exit(0 if hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest else 1)
            """
        ),
        encoding="utf-8",
    )
    (commands / "sha256sum").chmod(0o755)
    (commands / "curl").write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import sys
            from pathlib import Path

            argv = sys.argv[1:]
            Path(argv[argv.index("--output") + 1]).write_bytes(b"not a gh tarball")
            """
        ),
        encoding="utf-8",
    )
    for command in commands.iterdir():
        command.chmod(0o755)
    env = dict(os.environ) | {"PATH": f"{commands}{os.pathsep}{os.environ['PATH']}"}
    return subprocess.run(
        ["/bin/bash", str(INSTALL_GH), str(tmp_path / "gh")],
        capture_output=True,
        check=False,
        env=env,
        text=True,
    )


def test_install_gh_refuses_a_tarball_that_does_not_match_the_pinned_sha256(tmp_path: Path) -> None:
    """Never extract or run bytes whose digest differs from the pinned official release."""
    completed = run_install_gh(tmp_path, "Linux", "x86_64")
    assert completed.returncode == 1
    assert "sha256 mismatch" in completed.stderr
    assert not (tmp_path / "gh" / "bin").exists()


@pytest.mark.parametrize(("system", "machine"), [("Darwin", "arm64"), ("Linux", "riscv64")])
def test_install_gh_refuses_unsupported_platforms_before_downloading(
    tmp_path: Path, system: str, machine: str
) -> None:
    """Fail closed off linux/x86_64 and linux/aarch64 instead of installing the wrong binary."""
    completed = run_install_gh(tmp_path, system, machine)
    assert completed.returncode == 1
    assert "supports only linux/x86_64 and linux/aarch64" in completed.stderr
    assert not (tmp_path / "gh").exists()


@pytest.mark.parametrize(("machine", "asset"), [("x86_64", "linux_amd64"), ("aarch64", "linux_arm64")])
def test_install_gh_downloads_the_asset_of_its_architecture(tmp_path: Path, machine: str, asset: str) -> None:
    """Pick the amd64 or arm64 tarball by `uname -m` and pin a distinct digest for each."""
    completed = run_install_gh(tmp_path, "Linux", machine)
    assert completed.returncode == 1
    assert f"for gh_{GH_VERSION}_{asset}.tar.gz; refusing to install" in completed.stderr
    assert (tmp_path / "sha256sum-ran").is_file()
    pins = re.findall(
        r'^GH_SHA256_(AMD64|ARM64) = "([0-9a-f]{64})"$', INSTALL_GH_PY.read_text(), re.MULTILINE
    )
    assert sorted(name for name, _ in pins) == ["AMD64", "ARM64"]
    assert len({digest for _, digest in pins}) == 2


GH_VERSION = cast(
    "re.Match[str]", re.search(r'^GH_VERSION = "(\S+)"$', INSTALL_GH_PY.read_text(), re.MULTILINE)
)[1]


def test_install_gh_requires_one_directory_argument() -> None:
    """Reject a missing install directory with a usage error."""
    completed = subprocess.run(["/bin/bash", str(INSTALL_GH)], capture_output=True, check=False, text=True)
    assert completed.returncode == 2
    assert "usage:" in completed.stderr


SETUP = ROOT / "scripts" / "wsl2_setup.sh"
SETUP_ACTION = ROOT / ".github" / "actions" / "setup-ci-wsl" / "action.yml"


def setup_steps() -> list[dict[str, str]]:
    """Return the WSL setup composite action's steps.

    Returns:
        list[dict[str, str]]: Parsed steps, in order.
    """
    return yaml.safe_load(SETUP_ACTION.read_text(encoding="utf-8"))["runs"]["steps"]


def test_every_host_wsl_call_in_setup_is_bounded() -> None:
    """Route each `wsl` call in the guest-prepare step through `Invoke-Bounded` (#626)."""
    step = next(item for item in setup_steps() if item.get("name") == "Assert WSL2 and prepare guest")
    run = step["run"]
    assert ". (Join-Path $env:GITHUB_WORKSPACE 'scripts/wsl2_bounded.ps1')" in run
    commands = [
        line
        for line in run.splitlines()
        if not line.lstrip().startswith("#") and re.search(r"\swsl\s", f" {line} ")
    ]
    assert len(commands) == 5
    for line in commands:
        assert re.search(r"Invoke-Bounded(Capture)? '", line), f"unbounded wsl call: {line}"
    # A tripped capture may be empty or partial: check the status before trimming it.
    assert run.index("$scripts = Invoke-BoundedCapture") < run.index("$scripts = $scripts.Trim()")
    assert run.index("if ($LASTEXITCODE -ne 0)", run.index("$scripts = Invoke-BoundedCapture")) < run.index(
        "$scripts = $scripts.Trim()"
    )
    # Order only: the 1200s bound itself is pinned in `deadlines` below.
    assert run.index("wsl2_apt.sh") < run.index("useradd") < run.index("wsl2_setup.sh")
    deadlines = {
        match.group("label"): int(match.group("seconds"))
        for match in re.finditer(r"Invoke-Bounded(?:Capture)? '(?P<label>[^']+)' (?P<seconds>\d+)", run)
    }
    # Measured on hosted passes: under 1s per host command, 22s to 67s for the bootstrap script.
    assert deadlines == {
        "list WSL distributions": 30,
        "create the pi-ci user": 30,
        "translate the scripts directory": 30,
        "apt prerequisites (scripts/wsl2_apt.sh)": 1200,
        "guest bootstrap (scripts/wsl2_setup.sh)": 300,
    }


def test_setup_wsl_action_is_bounded_by_a_watchdog_that_always_reports() -> None:
    """Bound the third-party step, which takes no `timeout-minutes`, and fail with the watchdog's report."""
    steps = setup_steps()
    names = [step.get("name", step.get("uses", "")) for step in steps]
    start = names.index("Start WSL setup watchdog")
    action = next(i for i, step in enumerate(steps) if step.get("uses", "").startswith("Vampire/setup-wsl@"))
    stop = names.index("Stop WSL setup watchdog and report")
    assert start < action < stop < names.index("Assert WSL2 and prepare guest")
    assert re.fullmatch(r"Vampire/setup-wsl@[0-9a-f]{40}", steps[action]["uses"])
    assert all("timeout-minutes" not in step for step in steps), "composite steps reject timeout-minutes"
    launch = steps[start]["run"]
    assert "$seconds = 300" in launch
    # Start-Process children vanished with the step in run 42756515991: start outside the runner tree.
    assert "Win32_Process" in launch
    assert "Start-Process" not in launch
    assert "watchdog.started" in launch
    assert "never armed" in launch
    assert steps[stop]["if"] == "always()"
    stop_run = steps[stop]["run"]
    assert "watchdog.tripped" in stop_run
    assert "throw" in stop_run
    # Backstop: a watchdog that died unseen still fails an overlong step instead of passing it.
    assert "the watchdog did not trip" in stop_run
    assert "watchdog.started" in stop_run
    assert "additional-packages" not in steps[action].get("with", {})
    watchdog = (ROOT / "scripts/wsl2_watchdog.ps1").read_text()
    assert "watchdog.done" in watchdog
    assert "watchdog.alive" in watchdog
    assert "Write-StallReport" in watchdog
    assert "'wsl.exe', 'wslhost.exe'" in watchdog
    assert "setup-wsl" in watchdog


def test_bounded_helper_kills_the_tree_and_reports_the_stuck_command() -> None:
    """Pin the helper's trip behaviour: exit 124, tree kill, annotation, host and guest snapshots."""
    helper = (ROOT / "scripts/wsl2_bounded.ps1").read_text()
    # A leading `-d` must reach the wrapped command: advanced functions bind it as `-Debug`.
    assert "CmdletBinding" not in helper
    assert "[Parameter(" in helper.split("function Invoke-BoundedCore")[0]
    assert "[Parameter(" not in helper.split("function Invoke-BoundedCore")[1]
    assert "$process.Kill($true)" in helper
    assert "ExitCode = 124" in helper
    assert "::error title=WSL setup timed out::$Label exceeded ${Seconds}s: $($Command -join ' ')" in helper
    assert "Get-CimInstance Win32_Process" in helper
    assert "'--exec', 'ps'" in helper
    assert "$global:LASTEXITCODE = $result.ExitCode" in helper


def guest_setup_env(tmp_path: Path, stubs: dict[str, str]) -> tuple[dict[str, str], Path]:
    """Build a guest bootstrap fixture: stub commands, a fake checkout copy and an argv log.

    Parameters:
        tmp_path (Path): Scratch directory.
        stubs (dict[str, str]): Extra stub command bodies by name, overriding the defaults.

    Returns:
        tuple[dict[str, str], Path]: Environment for `wsl2_setup.sh` and the log of every `timeout` call.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    log = tmp_path / "timeout.log"
    defaults = {
        # The hosted fallback is x64 whatever machine runs this test.
        "uname": "#!/bin/sh\necho x86_64\n",
        "findmnt": "#!/bin/sh\nprintf ext4\n",
        "ps": "#!/bin/sh\necho 'PID PPID ELAPSED STAT COMMAND'\necho '42 1 05:00 S synthetic-stuck-apt'\n",
        # The copy stub plants the pins the real checkout carries.
        "cp": '#!/bin/sh\nfor last; do :; done\nprintf "22.0.0\\n" > "$last/.node-version"\n',
        # Stand-in for coreutils `timeout`, absent on some hosts: record argv, then run or model a trip.
        "timeout": f'#!/bin/sh\nprintf "%s\\n" "$*" >> {shlex.quote(str(log))}\n'
        'shift 2\ncase "$1" in curl) exit 124 ;; esac\nexec "$@"\n',
    }
    for name, body in (defaults | stubs).items():
        (commands / name).write_text(body, encoding="utf-8")
        (commands / name).chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    env = dict(os.environ) | {
        "HOME": str(home),
        "WSL_HOST_WORKSPACE": "/mnt/c/synthetic-checkout",
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
    }
    return env, log


def run_guest_setup(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run the real guest bootstrap with the given environment.

    Parameters:
        env (dict[str, str]): Process environment.

    Returns:
        subprocess.CompletedProcess[str]: Outcome.
    """
    return subprocess.run(["/bin/bash", str(SETUP)], env=env, capture_output=True, check=False, text=True)


def test_guest_setup_names_the_stuck_command_and_guest_processes_on_a_timeout(tmp_path: Path) -> None:
    """A tripped bound exits 124 and prints the label, the command, and what the guest was running."""
    env, log = guest_setup_env(tmp_path, {})
    result = run_guest_setup(env)
    assert result.returncode == 124
    assert (
        "wsl2-setup: TIMEOUT: download https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-x64.tar.xz"
        in result.stderr
    )
    assert "exceeded 180s" in result.stderr
    assert "curl --fail --location --retry 3 --connect-timeout 15 --max-time 45 --output" in result.stderr
    assert "synthetic-stuck-apt" in result.stderr
    calls = log.read_text().splitlines()
    assert calls[0].startswith("--kill-after=10 60 cp -a ")
    assert calls[1].startswith("--kill-after=10 180 curl ")


def test_trip_snapshots_list_the_newest_processes_first(tmp_path: Path) -> None:
    """Keep the stuck process inside the 40-row cut: boot-time processes alone outnumber it."""
    # 59 long-lived services plus the stuck child; `ps` honours only the requested sort.
    ps = (
        "#!/bin/sh\n"
        "echo 'PID PPID ELAPSED STAT COMMAND'\n"
        'case "$*" in *--sort=etime*) echo "42 1 00:05 S synthetic-stuck-child" ;; esac\n'
        'i=0; while [ $i -lt 59 ]; do echo "$((100 + i)) 1 9-00:00:00 S service-$i"; i=$((i + 1)); done\n'
        'case "$*" in *--sort=-etime*) echo "42 1 00:05 S synthetic-stuck-child" ;; esac\n'
    )
    env, _ = guest_setup_env(tmp_path, {"ps": ps})
    result = run_guest_setup(env)
    assert result.returncode == 124
    assert "synthetic-stuck-child" in result.stderr
    assert "guest processes, newest first:" in result.stderr
    helper = (ROOT / "scripts/wsl2_bounded.ps1").read_text()
    assert "Sort-Object CreationDate -Descending |" in helper
    assert "'--sort=etime'" in helper
    assert "--sort=-etime" not in helper
    assert "--- host processes, newest first" in helper
    assert "--- guest processes, newest first" in helper


def test_guest_setup_names_a_failed_command_without_calling_it_a_timeout(tmp_path: Path) -> None:
    """A plain failure keeps its status and names the command, with no process dump."""
    env, _ = guest_setup_env(tmp_path, {"cp": "#!/bin/sh\nexit 7\n"})
    result = run_guest_setup(env)
    assert result.returncode == 7
    assert "wsl2-setup: FAILED: copy checkout (status 7): cp -a " in result.stderr
    assert "TIMEOUT" not in result.stderr
    assert "synthetic-stuck-apt" not in result.stderr


def test_guest_setup_leaves_no_external_command_unbounded() -> None:
    """Every network, archive and installer command goes through `bounded`/`fetch`; no pipe into a shell."""
    setup = SETUP.read_text(encoding="utf-8")
    assert not re.search(r"\|\s*(ba)?sh\b", setup)
    body = setup.split("source_checkout=$WSL_HOST_WORKSPACE", 1)[1]
    unbounded = [
        stripped
        for stripped in (line.strip() for line in body.splitlines())
        if re.match(r"(curl|tar|npm|cp|bun|uv) ", stripped) or re.match(r"(ba)?sh ", stripped)
    ]
    assert not unbounded, unbounded
    for label in ("copy checkout", "extract node", "install npm", "install bun", "install uv", "install gh"):
        assert f'bounded "{label}" ' in setup
    assert 'bounded "install owned tools" 90 ' in setup
    owned_tools = (ROOT / "scripts/install_wsl_owned_tools.py").read_text(encoding="utf-8")
    assert 'CURL_BOUNDS = ["--connect-timeout", "15", "--max-time", "45"]' in owned_tools


APT = ROOT / "scripts" / "wsl2_apt.sh"
UBUNTU_SOURCES = (
    "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\n\n"
    "Types: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\n"
)


PACKAGES = (
    "build-essential curl fd-find git jq libatomic1 libssl-dev pkg-config python3 ripgrep tmux unzip xz-utils"
)
APT_FLAGS = "install --yes --no-install-recommends"


class DnsToolMode(StrEnum):
    """Diagnostic outcomes available to the isolated apt failure fixtures."""

    FAILED = "failed"
    TIMEOUT = "timeout"
    MISSING = "missing"
    RESOLVED = "resolved"
    INVALID_CLASSIFICATION = "invalid-classification"
    SYSTEM_CLASSIFICATION = "system-classification"


def test_dns_timeout_fixture_is_import_safe() -> None:
    """Import the timeout fixture without starting a subprocess.

    Returns:
        None: The fixture exposes its main function without executing it.
    """
    namespace = runpy.run_path(str(ROOT / "scripts/tests/fixtures/wsl_timeout.py"))
    assert callable(namespace["main"])


def dns_failure_stubs(commands: Path, tools: DnsToolMode, log: Path) -> dict[str, str]:
    """Build isolated DNS failure tools with real timeout and shell processes.

    Parameters:
        commands (Path): Executable directory, without inherited host resolver tools.
        tools (DnsToolMode): Diagnostic fixture outcome mode.
        log (Path): Apt invocation log, proving no install occurs.
    Returns:
        dict[str, str]: Fixture bodies; supporting real tools are symlinked separately.
    """
    timeout_fixture = ROOT / "scripts/tests/fixtures/wsl_timeout.py"
    stubs: dict[str, str] = {}
    stubs[DnsToolMode.TIMEOUT] = textwrap.dedent(
        f"""\
        #!/bin/sh
        exec {shlex.quote(sys.executable)} {shlex.quote(str(timeout_fixture))} "$@"
        """
    )
    stubs["apt-get"] = textwrap.dedent(
        f"""\
        #!/bin/sh
        printf "%s\\n" "$*" >> {shlex.quote(str(log))}
        echo "Could not resolve fixture mirror" >&2
        exit 100
        """
    )
    for name in ("bash", "mkdir", "sed", "grep"):
        binary = shutil.which(name)
        assert binary is not None
        (commands / name).symlink_to(binary)
    if tools != DnsToolMode.MISSING:
        body = {
            DnsToolMode.FAILED: 'echo "192.0.2.19 private.invalid SECRET=fixture"; '
            'echo "192.0.2.19 private.invalid SECRET=fixture" >&2; exit 2',
            DnsToolMode.TIMEOUT: "exec /bin/sleep 30",
            DnsToolMode.RESOLVED: 'echo "192.0.2.19 private.invalid SECRET=fixture"; exit 0',
            DnsToolMode.INVALID_CLASSIFICATION: "exit 2",
            DnsToolMode.SYSTEM_CLASSIFICATION: "exit 2",
        }[tools]
        for name in ("getent", "resolvectl"):
            stubs[name] = textwrap.dedent(
                f"""\
                #!/bin/sh
                {body}
                """
            )
        classification = (
            "private.invalid 192.0.2.19 SECRET=fixture"
            if tools == DnsToolMode.INVALID_CLASSIFICATION
            else "loopback-only"
        )
        if tools == DnsToolMode.SYSTEM_CLASSIFICATION:
            awk = shutil.which("awk")
            assert awk is not None
            (commands / "awk").symlink_to(awk)
        else:
            stubs["awk"] = textwrap.dedent(
                f"""\
                #!/bin/sh
                printf '%s\\n' {shlex.quote(classification)}
                """
            )
    return stubs


def run_apt(
    tmp_path: Path,
    fail_mirror: str | None = None,
    *,
    hang: bool = False,
    cached: bool = False,
    stale: bool = False,
    fetched_version: str = "1.0",
    extra_debs: tuple[str, ...] = (),
    tmpdir: Path | None = None,
    broken_cache_copy: bool = False,
    install_status: int = 0,
    dns_failure: bool = False,
    dns_tools: DnsToolMode = DnsToolMode.FAILED,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """Run the real apt script with stub `id`, `timeout`, `apt-get` and `ps`.

    Parameters:
        tmp_path (Path): Scratch directory; `cache/` and `archives/` live under it.
        fail_mirror (str | None): Mirror host whose `apt-get update` fails; `None` fails none.
        hang (bool): Model `timeout` tripping (exit 124) on every `apt-get update`.
        cached (bool): Seed the host cache with one .deb.
        fetched_version (str): Version in the name of the .deb a download leaves behind.
        extra_debs (tuple[str, ...]): More .deb names to seed in the host cache.
        tmpdir (Path | None): `TMPDIR` for the script's scratch directory.
        stale (bool): Seed the host cache with a .deb of a superseded version.
        broken_cache_copy (bool): Model a host cache write failing (`cp` into `cache/` exits 1).
        install_status (int): Offline installation exit status, after successful fetches.
        dns_failure (bool): Fail both mirrors with captured DNS errors; use real diagnostic bounds.
        dns_tools (DnsToolMode): Diagnostic fixture mode: failed, timeout, missing, resolved,
            system-classification or invalid-classification.

    Returns:
        tuple[subprocess.CompletedProcess[str], Path, Path]: Outcome, the sources file and the stub call log.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    log = tmp_path / "calls.log"
    sources = tmp_path / "ubuntu.sources"
    sources.write_text(UBUNTU_SOURCES, encoding="utf-8")
    cache = tmp_path / "cache"
    cache.mkdir()
    if stale:
        (cache / "stale_0.9_amd64.deb").write_text("deb", encoding="utf-8")
    for extra in extra_debs:
        (cache / extra).write_text("deb", encoding="utf-8")
    if cached:
        (cache / "seeded_1.0_amd64.deb").write_text("deb", encoding="utf-8")
    quoted = shlex.quote(str(sources))
    quoted_log = shlex.quote(str(log))
    quoted_lists = shlex.quote(str(tmp_path / "lists.uri"))
    fail = f'case "$1" in update) grep -q {fail_mirror} {quoted} && exit 100 ;; esac\n' if fail_mirror else ""
    dpkg_deb_body = (
        'v=${n#*_}\ncase "$3" in Package) echo "${n%%_*}" ;; Version) echo "${v%%_*}" ;; '
        '*) echo "${v#*_}" ;; esac\n'
    )
    fetched = f"fetched_{fetched_version}_amd64.deb"
    no_candidate = '{ echo "E: Unable to locate package" >&2; exit 100; }'
    stubs = {
        "id": "#!/bin/sh\necho 0\n",
        # .deb names are `package_version_arch.deb`; every package is "installed" at version 1.0.
        "dpkg-deb": '#!/bin/sh\nn=$(basename "$2" .deb)\ncase $n in broken*) exit 1 ;; esac\n'
        + dpkg_deb_body,
        # Installed: amd64 packages (queried `name:amd64`) and the arch-independent `docs` (queried bare).
        "dpkg-query": '#!/bin/sh\ncase "$3" in *:amd64|docs) printf 1.0 ;; *) exit 1 ;; esac\n',
        "ps": "#!/bin/sh\necho '42 1 05:00 S synthetic-stuck-apt'\n",
        "timeout": '#!/bin/sh\nshift 2\ncase "$*" in *"apt-get update"*) '
        + ("exit 124 " if hang else "")
        + ';; esac\nexec "$@"\n',
        # Log argv plus the sources' first URI at call time. A successful `update` records the URI its lists
        # match; a real install fails (as apt does with no candidate) when the sources moved since. A
        # download-only run leaves one .deb behind.
        "apt-get": f'#!/bin/sh\nprintf "%s|%s\\n" "$*" "$(grep -m1 URIs {quoted})" >> {quoted_log}\n'
        + fail
        + f"uris=$(grep -m1 URIs {quoted})\n"
        + f'case "$1" in update) echo "$uris" > {quoted_lists}; exit 0 ;; esac\n'
        + f'case "$*" in *--download-only*) touch "$WSL_APT_ARCHIVES/{fetched}"; exit 0 ;; esac\n'
        + f'case "$1" in install) [ "$uris" = "$(cat {quoted_lists})" ] || {no_candidate}; '
        + f"exit {install_status} ;; esac\n"
        + "exit 0\n",
    }
    if dns_failure:
        stubs |= dns_failure_stubs(commands, dns_tools, log)
    else:
        # Other apt fixtures must never reach the host resolver either.
        unavailable = textwrap.dedent(
            """\
            #!/bin/sh
            exit 2
            """
        )
        stubs |= dict.fromkeys(("getent", "resolvectl"), unavailable)
    if broken_cache_copy:
        # Only writes into the host cache fail; seeding the archives from it still works.
        last = 'for a in "$@"; do t=$a; done\n'
        refuse = f'case "$t" in {shlex.quote(str(cache))}*) exit 1 ;; esac\n'
        stubs["cp"] = f'#!/bin/sh\n{last}{refuse}exec /bin/cp "$@"\n'
    for name, body in stubs.items():
        (commands / name).write_text(body, encoding="utf-8")
        (commands / name).chmod(0o755)
    env = dict(os.environ) | {
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "WSL_APT_SOURCES": str(sources),
        "WSL_APT_CONF": str(tmp_path / "99-pi-ci"),
        "WSL_APT_ARCHIVES": str(tmp_path / "archives"),
        "WSL_APT_CACHE": str(cache),
        "WSL_APT_DIAGNOSTICS": "",
    }
    if tmpdir is not None:
        env["TMPDIR"] = str(tmpdir)
    if dns_failure:
        env["PATH"] = str(commands)
        env["WSL_APT_CACHE"] = ""
        env["WSL_APT_DIAGNOSTICS"] = str(tmp_path / "apt-dns.txt")
    result = subprocess.run(
        ["/bin/bash", str(APT)], env=env, capture_output=True, check=False, text=True, timeout=30
    )
    return result, sources, log


def test_apt_prerequisites_download_from_azure_then_install_offline(tmp_path: Path) -> None:
    """Rewrite archive and security to one mirror and install offline against that same mirror's lists."""
    result, sources, log = run_apt(tmp_path)
    assert result.returncode == 0, result.stderr
    conf = (tmp_path / "99-pi-ci").read_text()
    for line in ('Acquire::Retries "3";', 'Acquire::http::Timeout "20";', 'Acquire::Languages "none";'):
        assert line in conf
    azure = "URIs: http://azure.archive.ubuntu.com/ubuntu/"
    assert log.read_text().splitlines()[:3] == [
        f"update|{azure}",
        f"{APT_FLAGS} --download-only {PACKAGES}|{azure}",
        f"{APT_FLAGS} {PACKAGES}|{azure}",
    ]
    # The sources stay on the mirror whose lists apt holds; the guest is ephemeral.
    assert sources.read_text() != UBUNTU_SOURCES
    assert azure in sources.read_text()
    # Both stock hosts collapse to the one mirror, without a doubled slash.
    assert "(archive|security)" in APT.read_text(encoding="utf-8")
    assert "ubuntu/?#${mirror}/#" in APT.read_text(encoding="utf-8")


def test_apt_debs_are_cached_by_the_host_and_keyed_by_script_and_week() -> None:
    """The guest's .deb downloads are slow, so the host's Actions cache carries them between runs (#626)."""
    steps = setup_steps()
    locate = next(step for step in steps if step.get("id") == "apt-cache")
    cache = next(step for step in steps if step.get("uses", "").startswith("actions/cache@"))
    cache_with = cast("dict[str, str]", cache["with"])
    assert cache_with["path"] == "${{ steps.apt-cache.outputs.dir }}"
    assert "hashFiles('scripts/wsl2_apt.sh')" in cache_with["key"]
    assert "steps.apt-cache.outputs.week" in cache_with["key"]
    assert cache_with["restore-keys"].startswith("wsl-apt-${{ hashFiles('scripts/wsl2_apt.sh') }}-")
    assert "GetWeekOfYear" in locate["run"]
    names = [step.get("name", step.get("uses", "")) for step in steps]
    assert (
        names.index("Locate the WSL apt cache")
        < steps.index(cache)
        < names.index("Assert WSL2 and prepare guest")
    )
    prepare = next(step for step in steps if step.get("name") == "Assert WSL2 and prepare guest")
    prepare_env = cast("dict[str, str]", prepare["env"])
    assert prepare_env["WSL_APT_CACHE"] == "${{ steps.apt-cache.outputs.dir }}"
    assert "$env:WSLENV = 'WSL_APT_CACHE/p:WSL_APT_DIAGNOSTICS/p'" in prepare["run"]
    assert "wsl2-diagnostics/apt-dns.txt" in prepare["run"]


def test_apt_prerequisites_restore_and_refill_the_host_cache(tmp_path: Path) -> None:
    """Seed `/archives` from the cache before apt runs, and copy newly downloaded .debs back."""
    result, _, _ = run_apt(tmp_path, cached=True)
    assert result.returncode == 0, result.stderr
    assert "restored 1 cached packages" in result.stdout
    assert (tmp_path / "archives" / "seeded_1.0_amd64.deb").exists()
    assert (tmp_path / "cache" / "fetched_1.0_amd64.deb").exists()


def test_apt_cache_is_pruned_to_installed_versions(tmp_path: Path) -> None:
    """A superseded .deb in the host cache (last week's restore-key hit) is not carried into the new key."""
    result, _, _ = run_apt(tmp_path, stale=True)
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "cache" / "stale_0.9_amd64.deb").exists()
    assert (tmp_path / "cache" / "fetched_1.0_amd64.deb").exists()


def test_apt_cache_prune_keys_arch_skips_unreadable_debs_and_cleans_up(tmp_path: Path) -> None:
    """Query `all` debs bare and others as `name:arch`, skip a corrupt .deb, and leave no scratch."""
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    extra = ("docs_1.0_all.deb", "foreign_1.0_i386.deb", "broken_1.0_amd64.deb")
    result, _, _ = run_apt(tmp_path, extra_debs=extra, tmpdir=scratch)
    assert result.returncode == 0, result.stderr
    kept = sorted(path.name for path in (tmp_path / "cache").glob("*.deb"))
    assert kept == ["docs_1.0_all.deb", "fetched_1.0_amd64.deb"]
    assert list(scratch.iterdir()) == []


def test_apt_cache_is_left_alone_when_no_installed_deb_is_found(tmp_path: Path) -> None:
    """Nothing in the archives matches an installed version: keep the cache rather than wipe it."""
    result, _, _ = run_apt(tmp_path, stale=True, fetched_version="0.5")
    assert result.returncode == 0, result.stderr
    assert "leaving the host cache as it was" in result.stderr
    assert (tmp_path / "cache" / "stale_0.9_amd64.deb").exists()


def test_apt_cache_refresh_failure_does_not_fail_a_successful_install(tmp_path: Path) -> None:
    """A host cache write failing after the install only warns: the packages are in place."""
    result, _, log = run_apt(tmp_path, stale=True, broken_cache_copy=True)
    assert result.returncode == 0, result.stderr
    assert "cache refresh failed, continuing" in result.stderr
    assert f"{APT_FLAGS} {PACKAGES}|" in log.read_text()


def test_apt_prerequisites_fall_back_to_the_stock_mirror_once(tmp_path: Path) -> None:
    """A failing first mirror names itself, then the stock one is tried and succeeds."""
    result, _, log = run_apt(tmp_path, "azure.archive")
    assert result.returncode == 0, result.stderr
    assert "wsl2-apt: FAILED: apt-get update (http://azure.archive.ubuntu.com/ubuntu)" in result.stderr
    assert "trying the next mirror" in result.stderr
    # azure update (failed), stock update, stock download, offline install on the stock mirror
    lines = log.read_text().splitlines()
    assert len(lines) == 4
    assert "--download-only" in lines[2]
    stock = "URIs: http://archive.ubuntu.com/ubuntu/"
    assert lines[3] == f"{APT_FLAGS} {PACKAGES}|{stock}"


def test_apt_prerequisites_name_a_hang_on_both_mirrors(tmp_path: Path) -> None:
    """A trip on both mirrors exits non-zero with the stuck command and guest processes."""
    result, _, log = run_apt(tmp_path, hang=True)
    assert result.returncode == 1
    assert result.stderr.count("wsl2-apt: TIMEOUT: apt-get update") == 2
    assert "synthetic-stuck-apt" in result.stderr
    assert "every mirror failed" in result.stderr
    assert not log.exists()


@pytest.mark.parametrize("tools", list(DnsToolMode))
def test_apt_dns_failure_retains_only_bounded_allowlisted_evidence(
    tmp_path: Path, tools: DnsToolMode
) -> None:
    """Replay both-mirror failure through the real trap, without DNS or root installation.

    Parameters:
        tmp_path (Path): Disposable apt filesystem and host-visible artifact destination.
        tools (DnsToolMode): Optional tool behavior, including actual sleeping processes.
    Returns:
        None: Original failure survives; only safe diagnostic labels reach logs/artifacts.
    """
    result, _, log = run_apt(tmp_path, dns_failure=True, dns_tools=tools)
    assert result.returncode == 1, result.stderr
    assert log.read_text().splitlines() == ["update", "update"]
    assert result.stderr.count("Could not resolve fixture mirror") == 2
    assert "every mirror failed" in result.stderr
    report = (tmp_path / "apt-dns.txt").read_text()
    assert report in result.stdout
    assert "failure-time guest resolver evidence" in report
    assert "capture complete" in report
    assert not any(
        value in result.stdout + result.stderr + report
        for value in ("192.0.2.19", "private.invalid", "SECRET")
    )
    classification = (
        "unavailable"
        if tools in (DnsToolMode.MISSING, DnsToolMode.INVALID_CLASSIFICATION)
        else "loopback-only"
    )
    if tools == DnsToolMode.SYSTEM_CLASSIFICATION:
        assert re.search(
            r"configured-resolver=(?:loopback-only|nonloopback-present|none|unavailable)\n", report
        )
    else:
        assert f"configured-resolver={classification}" in report
    if tools == DnsToolMode.MISSING:
        assert "getent=unavailable" in report
        assert "resolvectl=unavailable" in report
    else:
        outcome = (
            DnsToolMode.FAILED
            if tools in (DnsToolMode.INVALID_CLASSIFICATION, DnsToolMode.SYSTEM_CLASSIFICATION)
            else tools
        )
        for tool in ("getent", "resolvectl"):
            for name in ("azure.archive.ubuntu.com", "archive.ubuntu.com"):
                assert f"{tool} {name}={outcome}" in report


def test_apt_dns_capture_preserves_an_offline_install_failure_status(tmp_path: Path) -> None:
    """Keep a non-1 apt status and original error, without retrying a failed offline install.

    Parameters:
        tmp_path (Path): Disposable apt filesystem.
    Returns:
        None: The original status and error survive diagnostic capture.
    """
    result, _, log = run_apt(tmp_path, install_status=47)
    assert result.returncode == 47
    assert "FAILED: apt-get install (status 47)" in result.stderr
    assert len(log.read_text().splitlines()) == 3
    assert "capture complete" in result.stdout


def test_apt_success_does_not_collect_dns_evidence(tmp_path: Path) -> None:
    """Successful setup adds no resolver probes or diagnostic artifacts.

    Parameters:
        tmp_path (Path): Disposable apt filesystem.
    Returns:
        None: Successful setup emits no DNS diagnostics.
    """
    result, _, _ = run_apt(tmp_path)
    assert result.returncode == 0
    assert "wsl2-dns:" not in result.stdout + result.stderr
    assert not (tmp_path / "apt-dns.txt").exists()


def test_apt_dns_artifact_write_failure_cannot_mask_original_failure(tmp_path: Path) -> None:
    """An unwritable artifact destination preserves log diagnostics and the apt failure.

    Parameters:
        tmp_path (Path): Disposable filesystem containing a directory instead of an artifact file.
    Returns:
        None: Log diagnostics and the original failure remain available.
    """
    (tmp_path / "apt-dns.txt").mkdir()
    result, _, log = run_apt(tmp_path, dns_failure=True)
    assert result.returncode == 1
    assert log.read_text().splitlines() == ["update", "update"]
    assert "artifact unavailable" in result.stderr
    assert "capture complete" in result.stdout


def test_apt_dns_blocked_artifact_write_is_bounded_without_masking_failure(tmp_path: Path) -> None:
    """Even opening a FIFO with no reader cannot hang the apt failure trap.

    Parameters:
        tmp_path (Path): Disposable filesystem containing a FIFO instead of an artifact file.
    Returns:
        None: The outer capture deadline stops blocked IO and preserves the apt failure.
    """
    os.mkfifo(tmp_path / "apt-dns.txt")
    result, _, log = run_apt(tmp_path, dns_failure=True)
    assert result.returncode == 1
    assert log.read_text().splitlines() == ["update", "update"]
    assert "every mirror failed" in result.stderr
    assert "DNS diagnostics unavailable or incomplete" in result.stderr


SMOKE = ROOT / "scripts" / "wsl2_smoke.sh"


def native_guest(tmp_path: Path, versions: dict[str, str]) -> tuple[dict[str, str], Path, Path]:
    """Build an in-guest bootstrap fixture: a checkout on "ext4", stub tools and a recording `curl`.

    Parameters:
        tmp_path (Path): Scratch directory.
        versions (dict[str, str]): Overrides of the stub tools' versions (`node`, `npm`, `bun`, `uv`).

    Returns:
        tuple[dict[str, str], Path, Path]: Environment for `wsl2_setup.sh`, the workspace and the log of
            every command that would have downloaded something.
    """
    workspace = tmp_path / "workspace"
    (workspace / ".git").mkdir(parents=True)
    (workspace / "scripts").mkdir()
    shutil.copy(INSTALL_GH, workspace / "scripts" / "install_gh_linux.sh")
    shutil.copy(INSTALL_GH_PY, workspace / "scripts" / "install_gh_linux.py")
    shutil.copy(INSTALL_GH_PY.with_name("wsl2_exec.py"), workspace / "scripts" / "wsl2_exec.py")
    (workspace / ".node-version").write_text("22.0.0\n", encoding="utf-8")
    (workspace / ".bun-version").write_text("1.4.4\n", encoding="utf-8")
    (workspace / "package.json").write_text("{}", encoding="utf-8")
    home = tmp_path / "home"
    gh_bin = home / ".cache" / "pi-harness-wsl2-tools" / "gh" / "bin"
    gh_bin.mkdir(parents=True)
    (gh_bin / "gh").write_text(f"#!/bin/sh\necho 'gh version {GH_VERSION} (2026-01-01)'\n", encoding="utf-8")
    (gh_bin / "gh").chmod(0o755)
    downloads = tmp_path / "downloads.log"
    reported = {"node": "22.0.0", "npm": "11.0.0", "bun": "1.4.4", "uv": "0.13.1"} | versions
    stubs = {
        "uname": "#!/bin/sh\necho aarch64\n",
        "findmnt": "#!/bin/sh\nprintf ext4\n",
        "timeout": '#!/bin/sh\nshift 2\nexec "$@"\n',
        "node": f'#!/bin/sh\ncase "$1" in -p) echo npm@11.0.0 ;; *) echo v{reported["node"]} ;; esac\n',
        "npm": f"#!/bin/sh\necho {reported['npm']}\n",
        "bun": f"#!/bin/sh\necho {reported['bun']}\n",
        "uv": f"#!/bin/sh\necho 'uv {reported['uv']} (abc 2026-01-01)'\n",
        "curl": f'#!/bin/sh\necho "curl $*" >> {shlex.quote(str(downloads))}\nexit 99\n',
    }
    commands = tmp_path / "commands"
    commands.mkdir()
    for name, body in stubs.items():
        (commands / name).write_text(body, encoding="utf-8")
        (commands / name).chmod(0o755)
    env = {
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(home),
        "PI_WSL2_IN_GUEST": "1",
        "GITHUB_WORKSPACE": str(workspace),
        "RUNNER_TEMP": str(tmp_path / "temp"),
        "GITHUB_PATH": str(tmp_path / "github_path"),
    }
    return env, workspace, downloads


def test_in_guest_setup_reuses_baked_tools_and_never_touches_the_windows_side(tmp_path: Path) -> None:
    """Matching versions mean no download, no `/mnt` check, no copy; the tool path goes to GITHUB_PATH."""
    env, workspace, downloads = native_guest(tmp_path, {})
    result = subprocess.run(
        ["/bin/bash", str(SETUP)], cwd=workspace, env=env, capture_output=True, check=False, text=True
    )
    assert result.returncode == 0, result.stderr
    assert not downloads.exists()
    assert not (tmp_path / "home" / "pi-harness-ci").exists()
    tool_dirs = Path(env["GITHUB_PATH"]).read_text().splitlines()
    assert str(tmp_path / "home" / ".cache" / "pi-harness-wsl2-tools" / "gh" / "bin") in tool_dirs
    identity = (tmp_path / "temp" / "wsl2-diagnostics" / "identity.txt").read_text()
    assert "Arch: aarch64" in identity
    assert (workspace / ".ci-temp" / "tool-path").is_file()
    # The runner prepends each line, so the file must list the PATH's home directories in reverse.
    home_dirs = [
        d
        for d in (workspace / ".ci-temp" / "tool-path").read_text().strip().split(":")
        if d.startswith(str(tmp_path / "home"))
    ]
    assert tool_dirs == home_dirs[::-1]


@pytest.mark.parametrize(
    ("versions", "url"),
    [
        ({"node": "21.0.0"}, "https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-arm64.tar.xz"),
        ({"bun": "1.0.0"}, "https://bun.sh/install"),
        ({"uv": "0.1.0"}, "https://astral.sh/uv/0.13.1/install.sh"),
    ],
)
def test_in_guest_setup_downloads_only_the_tool_whose_version_drifted(
    tmp_path: Path, versions: dict[str, str], url: str
) -> None:
    """A mismatch fetches that tool (for the guest's own architecture); the matching ones are reused."""
    env, workspace, downloads = native_guest(tmp_path, versions)
    result = subprocess.run(
        ["/bin/bash", str(SETUP)], cwd=workspace, env=env, capture_output=True, check=False, text=True
    )
    assert result.returncode == 99
    assert [line.split()[-1] for line in downloads.read_text().splitlines()] == [url]


def test_in_guest_setup_needs_a_runner_checkout_and_an_unprivileged_user(tmp_path: Path) -> None:
    """Refuse a workspace that is not a Git checkout instead of bootstrapping nothing."""
    env, workspace, _ = native_guest(tmp_path, {})
    shutil.rmtree(workspace / ".git")
    result = subprocess.run(
        ["/bin/bash", str(SETUP)], cwd=workspace, env=env, capture_output=True, check=False, text=True
    )
    assert result.returncode != 0


DISABLED_WSL_POLICY = (
    "[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n"
)


def run_smoke(
    tmp_path: Path,
    blocked: bool,
    extra_env: dict[str, str] | None = None,
    *,
    userns: bool = False,
    ns_limit: str = "0",
    control: bool = True,
    policy: str | None = DISABLED_WSL_POLICY,
    policy_stat: str = "0 644",
    binfmt: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the real smoke script against stub network tools.

    Parameters:
        tmp_path (Path): Scratch directory.
        blocked (bool): Whether private targets refuse connections (`timeout` exits 124 for them).
        extra_env (dict[str, str] | None): Extra environment, e.g. injected host targets.
        userns (bool): Whether `unshare -Urn` succeeds, i.e. unprivileged user namespaces are enabled.
        ns_limit (str): Value of `user.max_user_namespaces`.
        control (bool): Whether the public positive-control connection (port 443) opens.
        policy (str | None): Fixture configuration, or None for a missing file.
        policy_stat (str): Stub owner and octal permissions reported by stat.
        binfmt (dict[str, str] | None): Contents of `binfmt_misc` interop registrations by file name;
            None models a retained, disabled `WSLInterop`.

    Returns:
        subprocess.CompletedProcess[str]: The smoke run; `aarch64` and a non-root, no-sudo user are stubbed.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    refuse = (
        (
            'case "$*" in *"/443"*) '
            + ("" if control else "exit 124 ")
            + ';; *"/dev/tcp/"*) exit 124 ;; esac\n'
        )
        if blocked
        else ""
    )
    stubs = {
        "uname": '#!/bin/sh\ncase "$1" in -m) echo aarch64 ;; -r) echo 6.18-stub ;; *) echo Linux ;; esac\n',
        "id": '#!/bin/sh\ncase "$1" in -u) echo 1001 ;; *) echo runner ;; esac\n',
        "sudo": "#!/bin/sh\nexit 1\n",
        "unshare": f"#!/bin/sh\nexit {0 if userns else 1}\n",
        "curl": "#!/bin/sh\nexit 0\n",
        "ip": "#!/bin/sh\necho 'default via 172.20.0.1 dev eth0'\n",
        "nft": "#!/bin/sh\nexit 1\n",
        "findmnt": "#!/bin/sh\nexit 1\n",
        "stat": f'#!/bin/sh\n[ -f "$3" ] || exit 1\nprintf "%s\\n" {shlex.quote(policy_stat)}\n',
        "timeout": f"#!/bin/sh\nshift\n{refuse}exit 0\n",
    }
    for name, body in stubs.items():
        (commands / name).write_text(body, encoding="utf-8")
        (commands / name).chmod(0o755)
    root = tmp_path / "root"
    (root / "etc").mkdir(parents=True)
    if policy is not None:
        (root / "etc/wsl.conf").write_text(policy, encoding="utf-8")
    # WSL can retain these paths even when an actual Windows executable is rejected.
    (root / "proc/sys/fs/binfmt_misc").mkdir(parents=True)
    for name, contents in (binfmt if binfmt is not None else {"WSLInterop": "disabled\n"}).items():
        (root / "proc/sys/fs/binfmt_misc" / name).write_text(contents, encoding="utf-8")
    (root / "run/WSL").mkdir(parents=True)
    (root / "run/WSL/17_interop").touch()
    (root / "proc/sys/net/ipv6/conf/all").mkdir(parents=True)
    (root / "proc/sys/net/ipv6/conf/all/disable_ipv6").write_text("1\n")
    (root / "proc/sys/user").mkdir(parents=True)
    (root / "proc/sys/user/max_user_namespaces").write_text(f"{ns_limit}\n")
    env = (
        dict(os.environ)
        | {"PATH": f"{commands}{os.pathsep}{os.environ['PATH']}", "SMOKE_ROOT": str(root)}
        | (extra_env or {})
    )
    return subprocess.run(["/bin/bash", str(SMOKE)], env=env, capture_output=True, check=False, text=True)


def test_smoke_passes_when_every_private_target_is_blocked(tmp_path: Path) -> None:
    """Probe the generic private classes and the gateway, and every injected host and dev target."""
    result = run_smoke(
        tmp_path,
        blocked=True,
        extra_env={"SMOKE_HOST_IP": "172.20.0.2", "SMOKE_DEV_IP": "172.20.0.9", "SMOKE_DEV_PORTS": "22 8080"},
    )
    assert result.returncode == 0, result.stdout
    assert "::error::" not in result.stdout
    for target in (
        "192.168.1.1:80",
        "100.100.100.100:80",
        "169.254.169.254:80",
        "172.20.0.1:445",
        "172.20.0.2:3389",
        "172.20.0.9:8080",
    ):
        assert f"blocked: {target}" in result.stdout, target
    assert "loopback:8080 closed" in result.stdout
    assert "interop and automount are explicitly disabled" in result.stdout
    assert "note: WSLInterop registration present" in result.stdout
    assert "note: WSL broker paths present" in result.stdout


@pytest.mark.parametrize(
    "policy",
    [
        None,
        "not an ini file",
        "[interop]\nenabled=false\n",
        DISABLED_WSL_POLICY.replace("enabled=false", "enabled=true"),
        DISABLED_WSL_POLICY.replace("appendWindowsPath=false", "appendWindowsPath=true"),
        DISABLED_WSL_POLICY + "[interop]\nenabled=true\n",
        "[DEFAULT]\nenabled=false\nappendWindowsPath=false\nmountFsTab=false\n[interop]\n[automount]\n",
        DISABLED_WSL_POLICY.replace("enabled=false", "enabled=off"),
        DISABLED_WSL_POLICY.replace("enabled=false", "enabled=no"),
        DISABLED_WSL_POLICY.replace("enabled=false", "enabled=0"),
    ],
)
def test_smoke_rejects_missing_ambiguous_or_enabled_policy(tmp_path: Path, policy: str | None) -> None:
    """Residual plumbing is harmless only alongside an explicitly disabled, valid policy."""
    result = run_smoke(tmp_path, blocked=True, policy=policy)
    assert result.returncode == 1
    assert "::error::wsl.conf does not explicitly disable interop and automount" in result.stdout


@pytest.mark.parametrize("name", ["WSLInterop", "WSLInterop-late"])
@pytest.mark.parametrize(
    "contents",
    ["enabled\ninterpreter /init\n", "enabled\n", "", "garbage\n", "disabled \n", "\ndisabled\n"],
)
def test_smoke_fails_on_a_live_or_unreadable_interop_registration(
    tmp_path: Path, name: str, contents: str
) -> None:
    """A registration is only residue when its first line is exactly `disabled`."""
    result = run_smoke(tmp_path, blocked=True, binfmt={name: contents})
    assert result.returncode == 1
    assert f"::error::{name} interop registration is not disabled" in result.stdout


@pytest.mark.parametrize("names", [["WSLInterop"], ["WSLInterop-late"], ["WSLInterop", "WSLInterop-late"]])
def test_smoke_notes_only_disabled_interop_registrations(tmp_path: Path, names: list[str]) -> None:
    """Disabled registrations stay diagnostics; trailing lines after `disabled` are ignored."""
    result = run_smoke(tmp_path, blocked=True, binfmt=dict.fromkeys(names, "disabled\ninterpreter /init\n"))
    assert result.returncode == 0, result.stdout
    assert "::error::" not in result.stdout
    assert "note: WSLInterop registration present" in result.stdout


def test_smoke_passes_without_any_interop_registration(tmp_path: Path) -> None:
    """Absent registrations need no note and no failure."""
    result = run_smoke(tmp_path, blocked=True, binfmt={})
    assert result.returncode == 0, result.stdout
    assert "WSLInterop registration" not in result.stdout


@pytest.mark.parametrize("policy_stat", ["1001 644", "0 664", "0 646", "0 invalid"])
def test_smoke_rejects_unprotected_policy(tmp_path: Path, policy_stat: str) -> None:
    """The runner must not supply a writable configuration to make the policy check pass."""
    result = run_smoke(tmp_path, blocked=True, policy_stat=policy_stat)
    assert result.returncode == 1
    assert "::error::wsl.conf is missing or not protected" in result.stdout


def test_smoke_fails_when_unprivileged_user_namespaces_are_enabled(tmp_path: Path) -> None:
    """`unshare -Urn` working means root-in-namespace reaches kernel attack surface: a violation."""
    result = run_smoke(tmp_path, blocked=True, userns=True)
    assert result.returncode == 1
    assert "::error::unprivileged user namespaces are enabled" in result.stdout


def test_smoke_fails_when_the_user_namespace_limit_is_not_zero(tmp_path: Path) -> None:
    """Read the sysctl itself: a failing `unshare` can have other causes than the limit being zero."""
    result = run_smoke(tmp_path, blocked=True, ns_limit="1")
    assert result.returncode == 1
    assert "::error::user.max_user_namespaces is 1, not 0" in result.stdout


def test_smoke_fails_when_the_positive_control_cannot_connect(tmp_path: Path) -> None:
    """A failed public TCP probe makes every `blocked` line meaningless: fail instead of passing them."""
    result = run_smoke(tmp_path, blocked=True, control=False)
    assert result.returncode == 1
    assert "::error::probe machinery cannot open a public connection" in result.stdout


def test_smoke_fails_on_a_reachable_private_target(tmp_path: Path) -> None:
    """A connection that opens to a private range is a violation, named with its address."""
    result = run_smoke(tmp_path, blocked=False)
    assert result.returncode == 1
    assert "::error::reachable: 192.168.1.1:80" in result.stdout
    assert "::error::reachable: 172.20.0.1:445" in result.stdout


def test_smoke_hardcodes_no_host_or_dev_address() -> None:
    """Host and dev addresses come from the environment; the script names only generic ranges."""
    addresses = set(re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", SMOKE.read_text(encoding="utf-8")))
    assert addresses == {
        "192.168.1.1",
        "10.0.0.1",
        "172.16.0.1",
        "100.64.0.1",
        "100.100.100.100",
        "169.254.169.254",
        "127.0.0.1",
    }
