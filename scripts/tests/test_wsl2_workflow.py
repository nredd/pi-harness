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
    assert workflow.count("os: [ubuntu-24.04, macos-14, wsl2]") == 3
    assert workflow.count("runner: windows-2025") == 2
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
    assert "-replace ([char]0), ''" in action
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
        for step in job["steps"]
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
        ("Bun standalone", r"default D/E.*seven auth skips.*#14"),
        ("candidate compiled-core auth adapter", r"outcome and JUnit.*not this notice"),
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
    assert "python3" in action.split("additional-packages:")[1].splitlines()[0]
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
