"""Lock down the native WSL2 workflow's platform and harness boundaries.

References:
    https://learn.microsoft.com/windows/wsl/basic-commands
    https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
CLEANUP = ROOT / "scripts" / "wsl2_cleanup.sh"


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


def run_cleanup(
    tmp_path: Path,
    status: int,
    command_dir: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """Run the workflow's real cleanup trap against a disposable harness worktree.

    Parameters:
        tmp_path: Root for the disposable worktree and diagnostics directory.
        status: Harness exit status to preserve through the cleanup trap.
        command_dir: Optional directory of failing command fixtures prepended to `PATH`.

    Returns:
        tuple[CompletedProcess[str], Path, Path]: Shell outcome, worktree, and diagnostics paths.
    """
    worktree = tmp_path / "worktree"
    artifacts = worktree / "integration" / "artifacts"
    artifacts.mkdir(parents=True)
    (artifacts / "wsl2-personal.xml").write_text("<testsuite/>\n", encoding="utf-8")
    diagnostics = tmp_path / "wsl2-diagnostics"
    diagnostics.mkdir()
    script = "\n".join(
        [
            "set -euo pipefail",
            f"source {shlex.quote(str(CLEANUP))}",
            f"worktree={shlex.quote(str(worktree))}",
            f"diagnostics_dir={shlex.quote(str(diagnostics))}",
            "trap cleanup_wsl2_worktree EXIT",
            f"exit {status}",
        ]
    )
    env = dict(os.environ)
    if command_dir is not None:
        env["PATH"] = f"{command_dir}{os.pathsep}{env['PATH']}"
    completed = subprocess.run(
        ["/bin/bash", "-c", script], capture_output=True, check=False, env=env, text=True
    )
    return completed, worktree, diagnostics


def write_failing_command(directory: Path, name: str) -> None:
    """Create a `PATH` fixture that causes one cleanup command to fail.

    Parameters:
        directory: Fixture command directory.
        name: Command name intercepted by the fixture.

    Returns:
        None: The executable fixture is created.
    """
    command = directory / name
    command.write_text("#!/bin/sh\nexit 92\n", encoding="utf-8")
    command.chmod(0o755)


def test_wsl2_cleanup_preserves_failure_artifacts_before_deleting_worktree(tmp_path: Path) -> None:
    """Copy bounded artifacts before removing a failed harness worktree."""
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47)
    assert completed.returncode == 47
    assert not worktree.exists()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").read_text(encoding="utf-8") == "<testsuite/>\n"
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"


def test_wsl2_cleanup_preserves_success_status_and_artifacts(tmp_path: Path) -> None:
    """Keep normal cleanup successful after retaining the bounded diagnostics."""
    completed, worktree, diagnostics = run_cleanup(tmp_path, 0)
    assert completed.returncode == 0
    assert not worktree.exists()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").is_file()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 0.\n"


def test_wsl2_cleanup_retains_harness_failure_when_copying_artifacts_fails(tmp_path: Path) -> None:
    """Do not replace the harness failure when diagnostic preservation fails."""
    commands = tmp_path / "commands"
    commands.mkdir()
    write_failing_command(commands, "cp")
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47, commands)
    assert completed.returncode == 47
    assert "WARNING: could not preserve WSL failure artifacts" in completed.stderr
    assert not worktree.exists()
    assert not (diagnostics / "artifacts" / "wsl2-personal.xml").exists()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"


def test_wsl2_cleanup_retains_harness_failure_when_worktree_removal_fails(tmp_path: Path) -> None:
    """Do not replace the harness failure when disposable-worktree removal fails."""
    commands = tmp_path / "commands"
    commands.mkdir()
    write_failing_command(commands, "rm")
    completed, worktree, diagnostics = run_cleanup(tmp_path, 47, commands)
    assert completed.returncode == 47
    assert "WARNING: could not remove disposable WSL worktree" in completed.stderr
    assert worktree.is_dir()
    assert (diagnostics / "artifacts" / "wsl2-personal.xml").is_file()
    assert (diagnostics / "capture-status.txt").read_text(
        encoding="utf-8"
    ) == "WSL harness exited with status 47.\n"
    shutil.rmtree(worktree)


def test_wsl2_workflow_preserves_and_uploads_bounded_diagnostics() -> None:
    """Keep the executable cleanup and bounded upload attached to the native job."""
    workflow = workflow_text()
    capture = (ROOT / "scripts/wsl2_capture.sh").read_text()
    assert "wsl2-diagnostics" in workflow
    assert 'source "$worktree/scripts/wsl2_cleanup.sh"' in capture
    assert "trap finish_capture EXIT" in capture
    assert capture.index("trap finish_capture EXIT") < capture.index("for name in")
    assert "cleanup_wsl2_worktree" in capture
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
        "packages/example/coverage/bun/lcov.info",
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


INSTALL_GH = CLEANUP.parent / "install_gh_linux.sh"


def test_wsl2_workflow_bootstraps_gh_and_verifies_overrides_before_npm_ci() -> None:
    """Install attestation-capable `gh`, forward the token via WSLENV, and gate `npm ci` on verification."""
    workflow = workflow_text()
    setup = (ROOT / "scripts/wsl2_setup.sh").read_text()
    wrapper = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    assert "GH_TOKEN: ${{ github.token }}" in workflow
    assert "GH_TOKEN/u" in wrapper
    assert "Core Gitlink:" in (ROOT / "scripts/wsl2_capture.sh").read_text()
    action = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    assert "additional-packages" not in action
    assert "python3" in (ROOT / "scripts/wsl2_apt.sh").read_text().split("packages=(")[1].splitlines()[0]
    assert "unset GH_TOKEN" in setup
    assert 'bash scripts/install_gh_linux.sh "$tool_dir/gh"' in setup
    makefile = (ROOT / "Makefile").read_text()
    assert "env -u GH_TOKEN npm ci --ignore-scripts" in makefile
    assert "env -u GH_TOKEN uv sync --locked" in makefile
    assert "cd integration && uv sync --locked --python" in workflow
    verify = workflow.index("python3 -m harness.release --verify-root-overrides --root .")
    npm_ci = workflow.index("npm ci --ignore-scripts")
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


def test_install_gh_refuses_unsupported_platforms_before_downloading(tmp_path: Path) -> None:
    """Fail closed off linux/x86_64 instead of installing the wrong binary."""
    completed = run_install_gh(tmp_path, "Linux", "aarch64")
    assert completed.returncode == 1
    assert "supports only linux/x86_64" in completed.stderr
    assert not (tmp_path / "gh").exists()


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
    # The apt bound covers two mirror attempts of the script's own update and install bounds.
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
        "apt prerequisites (scripts/wsl2_apt.sh)": 630,
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
    for line in body.splitlines():
        stripped = line.strip()
        if re.match(r"(curl|tar|npm|cp|bun|uv) ", stripped) or re.match(r"(ba)?sh ", stripped):
            pytest.fail(f"unbounded command: {stripped}")
    for label in ("copy checkout", "extract node", "install npm", "install bun", "install uv", "install gh"):
        assert f'bounded "{label}" ' in setup
    assert 'bounded "install owned tools" 90 ' in setup
    assert "--connect-timeout 15 --max-time 45" in (ROOT / "scripts/install_wsl_owned_tools.sh").read_text()


APT = ROOT / "scripts" / "wsl2_apt.sh"
UBUNTU_SOURCES = (
    "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\n\n"
    "Types: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\n"
)


def run_apt(
    tmp_path: Path, fail_mirror: str | None, hang: bool = False
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """Run the real apt script with stub `id`, `timeout`, `apt-get` and `ps`.

    Parameters:
        tmp_path (Path): Scratch directory.
        fail_mirror (str | None): Mirror host whose `apt-get update` fails; `None` fails none.
        hang (bool): Model `timeout` tripping (exit 124) on every `apt-get update`.

    Returns:
        tuple[subprocess.CompletedProcess[str], Path, Path]: Outcome, the sources file and the stub call log.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    log = tmp_path / "calls.log"
    sources = tmp_path / "ubuntu.sources"
    sources.write_text(UBUNTU_SOURCES, encoding="utf-8")
    quoted = shlex.quote(str(sources))
    quoted_log = shlex.quote(str(log))
    stubs = {
        "id": "#!/bin/sh\necho 0\n",
        "ps": "#!/bin/sh\necho '42 1 05:00 S synthetic-stuck-apt'\n",
        "timeout": '#!/bin/sh\nshift 2\ncase "$*" in *"apt-get update"*) '
        + ("exit 124 " if hang else "")
        + ';; esac\nexec "$@"\n',
        "apt-get": f'#!/bin/sh\nprintf "%s|%s\\n" "$*" "$(grep -m1 URIs {quoted})" >> {quoted_log}\n'
        + (
            f'case "$1" in update) grep -q {fail_mirror} {quoted} && exit 100 ;; esac\nexit 0\n'
            if fail_mirror
            else ""
        ),
    }
    for name, body in stubs.items():
        (commands / name).write_text(body, encoding="utf-8")
        (commands / name).chmod(0o755)
    env = dict(os.environ) | {
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "WSL_APT_SOURCES": str(sources),
        "WSL_APT_CONF": str(tmp_path / "99-pi-ci"),
    }
    result = subprocess.run(["/bin/bash", str(APT)], env=env, capture_output=True, check=False, text=True)
    return result, sources, log


def test_apt_prerequisites_use_the_azure_mirror_with_bounded_retrying_apt(tmp_path: Path) -> None:
    """Point archive and security at one mirror, set short apt timeouts, and install the full package list."""
    result, sources, log = run_apt(tmp_path, None)
    assert result.returncode == 0, result.stderr
    text = sources.read_text()
    assert "azure.archive.ubuntu.com" in text
    assert "security.ubuntu.com" not in text
    assert "archive.ubuntu.com/ubuntu//" not in text
    conf = (tmp_path / "99-pi-ci").read_text()
    for line in ('Acquire::Retries "3";', 'Acquire::http::Timeout "20";', 'Acquire::Languages "none";'):
        assert line in conf
    calls = log.read_text().splitlines()
    assert calls[0].startswith("update|")
    assert "install --yes --no-install-recommends build-essential" in calls[1]
    assert "xz-utils" in calls[1]


def test_apt_prerequisites_fall_back_to_the_stock_mirror_once(tmp_path: Path) -> None:
    """A failing first mirror names itself, then the stock one is tried and succeeds."""
    result, sources, log = run_apt(tmp_path, "azure.archive")
    assert result.returncode == 0, result.stderr
    assert "wsl2-apt: FAILED: apt-get update (http://azure.archive.ubuntu.com/ubuntu)" in result.stderr
    assert "trying the next mirror" in result.stderr
    assert "URIs: http://archive.ubuntu.com/ubuntu/" in sources.read_text()
    assert len(log.read_text().splitlines()) == 3


def test_apt_prerequisites_name_a_hang_and_restore_the_sources(tmp_path: Path) -> None:
    """A trip on both mirrors exits non-zero with the stuck command and guest processes, sources restored."""
    result, sources, _ = run_apt(tmp_path, None, hang=True)
    assert result.returncode == 1
    assert result.stderr.count("wsl2-apt: TIMEOUT: apt-get update") == 2
    assert "synthetic-stuck-apt" in result.stderr
    assert "every mirror failed" in result.stderr
    assert sources.read_text() == UBUNTU_SOURCES
