"""Pin the CI matrix and exercise the guest adapter without pretending to run WSL.

References:
    https://docs.github.com/actions/using-jobs/using-a-matrix-for-your-jobs
    https://learn.microsoft.com/windows/wsl/filesystems
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
PLATFORMS = {
    "ubuntu-24.04": ("ubuntu-24.04", "linux", "linux-x64"),
    "macos-14": ("macos-14", "macos", "darwin-arm64"),
    "wsl2": ("windows-2022", "wsl2", "linux-x64"),
}


def jobs() -> dict[str, Any]:
    """Return parsed CI jobs, retaining GitHub expressions as strings.

    Returns:
        dict[str, Any]: YAML job records.
    """
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]


@pytest.mark.parametrize("name", ["owned", "contracts", "stack"])
def test_shared_guest_matrix(name: str) -> None:
    """Expand every supported cell and reject unsupported hosts/platforms.

    Parameters:
        name (str): Ordinary CI gate job.
    """
    job = jobs()[name]
    matrix = job["strategy"]["matrix"]
    assert matrix["os"] == list(PLATFORMS)
    assert set(matrix) == ({"os", "stack", "include"} if name == "stack" else {"os", "include"})
    assert len(matrix["include"]) == len(PLATFORMS)
    for record in matrix["include"]:
        runner, guest, platform = PLATFORMS[record["os"]]
        assert record["runner"] == runner
        assert record["guest"] == guest
        if name == "stack":
            assert record["platform"] == platform
    assert job["runs-on"] == "${{ matrix.runner }}"
    assert 'format(\'bash "{0}/scripts/wsl2_host.sh"' in job["defaults"]["run"]["shell"]
    assert "pwsh" not in job["defaults"]["run"]["shell"]
    assert job["needs"] == "classify"
    assert job["strategy"]["fail-fast"] is False
    steps = job["steps"]
    selection = steps[0]
    assert selection["if"] == "matrix.os == 'wsl2'"
    assert selection["shell"] == "pwsh"
    assert "'Git\\bin'" in selection["run"]
    assert (
        "Get-Command bash.exe -All -CommandType Application | Select-Object -First 1).Source"
        in selection["run"]
    )
    assert 'Write-Output "Resolved Git Bash: $resolved; expected: $bash"' in selection["run"]
    assert "$gitBin >> $env:GITHUB_PATH" in selection["run"]
    assert "--version" in selection["run"]
    assert "GITHUB_STEP_SUMMARY" in selection["run"]
    plan = steps[1]
    assert plan["id"] == "plan"
    assert plan["shell"] == "bash -e {0}"
    assert job["defaults"]["run"]["shell"].endswith("|| 'bash -e {0}' }}")
    setup = next(i for i, step in enumerate(steps) if step.get("id") == "tools")
    assert steps[setup]["uses"] == "./.github/actions/setup-ci-tools"
    assert steps[setup]["with"]["guest"] == "${{ matrix.guest }}"
    assert all("shell" not in step for step in steps[setup + 1 :] if "run" in step)
    assert "!= wsl2" in plan["run"]  # Retain old always-run WSL acceptance.
    assert any(step.get("with", {}).get("cleanup") == "cleanup" for step in steps)
    diagnostics = [
        step for step in steps if step.get("with", {}).get("path", "").endswith("/wsl2-diagnostics/")
    ]
    assert len(diagnostics) == 1
    assert "always()" in diagnostics[0]["if"]


def test_git_bash_selection_is_one_ordered_candidate_in_every_job() -> None:
    """Avoid treating Get-Command's application collection as one resolved path."""
    cfg = jobs()
    selections = {cfg[name]["steps"][0]["run"] for name in ("owned", "contracts", "stack")}
    assert len(selections) == 1
    selection = selections.pop()
    assert "Get-Command bash.exe -All -CommandType Application | Select-Object -First 1).Source" in selection
    assert "if ($resolved -ne $bash)" in selection
    assert "(Get-Command bash -CommandType Application).Source -ne $bash" not in selection


def test_all_original_cases_and_new_applicable_gates_share_the_boundary() -> None:
    """Keep exact scenario selectors and gates, with no WSL-only reduced suite."""
    cfg = jobs()
    assert set(cfg) == {"classify", "owned", "contracts", "stack", "bench"}
    owned = cfg["owned"]["steps"]
    assert any(step.get("run") == "make check-ts check-scripts check-integration" for step in owned)
    arm = next(step for step in owned if step.get("name") == "Add the aarch64 Linux compile target")
    assert "matrix.guest != 'macos'" in arm["if"]
    contracts = [step["run"] for step in cfg["contracts"]["steps"] if "run" in step]
    for target in (
        "check-package-contracts",
        "check-plan-mode-package-contract",
        "check-subagents-package-contract",
        "check-todo-package-contract",
        "check-computer-use-package-contract",
    ):
        assert any(command.startswith(f"make {target} REPORT=") for command in contracts)
    stack = cfg["stack"]
    assert stack["strategy"]["matrix"]["stack"] == ["personal", "local"]
    scenarios = [step for step in stack["steps"] if "pytest scenarios/" in step.get("run", "")]
    assert len(scenarios) == 3
    for step in scenarios:
        assert "pytest scenarios/test_*.py scenarios/tui/test_footer_resize.py" in step["run"]
        assert "-m stack -n 2 --dist loadfile" in step["run"]
        assert "matrix.os" not in step["if"]  # No WSL-only elision.
    assert '--stack "stacks/${{ matrix.stack }}.json"' in scenarios[0]["run"]
    assert "stacks/personal.json --runtime bun-standalone" in scenarios[1]["run"]
    assert "stacks/local.json --runtime bun-standalone" in scenarios[2]["run"]
    uploads = [step for step in stack["steps"] if "upload-artifact@" in step.get("uses", "")]
    startup = next(
        step for step in uploads if step.get("name") == "Upload scanned standalone startup failure evidence"
    )
    assert startup["if"] == (
        "${{ !cancelled() && steps.startup.outcome == 'failure' "
        "&& steps.startup.outputs.artifact_ready == 'true' "
        "&& (matrix.os != 'wsl2' || steps.startup_capture.outcome == 'success') }}"
    )
    assert all("always()" in step["if"] for step in uploads if step is not startup)
    assert startup["with"]["name"] == (
        "${{ matrix.os == 'wsl2' && 'standalone-startup-wsl2-linux-x64' || 'standalone-startup-linux-x64' }}"
    )
    capture = stack["steps"][stack["steps"].index(startup) - 1]
    assert capture["uses"] == "./.github/actions/capture-ci-wsl"
    assert capture["id"] == "startup_capture"
    assert "matrix.os == 'wsl2'" in capture["if"]
    assert "steps.startup.outputs.artifact_ready == 'true'" in capture["if"]
    standalone = next(step for step in uploads if "standalone-wsl2" in step["with"]["name"])
    assert (
        standalone["with"]["name"]
        == "${{ matrix.os == 'wsl2' && 'standalone-wsl2' || 'standalone' }}-${{ matrix.platform }}"
    )
    assert "${{ matrix.os == 'wsl2' && 'integration/artifacts-node/' || '' }}" in standalone["with"]["path"]
    assert "integration/artifacts-node/" in standalone["with"]["path"]
    assert "integration/artifacts-personal/" in standalone["with"]["path"]
    assert not (WORKFLOW.parent / "wsl2.yml").exists()
    for path in WORKFLOW.parent.glob("*.yml"):
        if path != WORKFLOW:
            assert "setup-ci-wsl" not in path.read_text()
            assert "wsl2_run.sh" not in path.read_text()


def guest_fixture(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """Prepare a Linux-shaped guest HOME with real adapter inputs.

    Parameters:
        tmp_path (Path): Disposable fixture directory.

    Returns:
        tuple[Path, dict[str, str]]: Guest checkout and adapter environment.
    """
    home = tmp_path / "guest home"
    worktree = home / "pi-harness-ci"
    ti = worktree / ".ci-temp"
    ti.mkdir(parents=True)
    (ti / "tool-path").write_text(os.environ["PATH"])
    (worktree / "integration").mkdir()
    step = tmp_path / "host step.sh"
    env = dict(os.environ) | {
        "HOME": str(home),
        "WSL_STEP_SCRIPT": str(step),
        "WSL_STEP_DIRECTORY": "integration",
        "GITHUB_OUTPUT": str(tmp_path / "output"),
        "GITHUB_ENV": str(tmp_path / "env"),
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"),
        "GH_TOKEN": "synthetic-sentinel",
    }
    return worktree, env


@pytest.mark.parametrize("status", [0, 47])
def test_guest_adapter_real_execution_and_status(tmp_path: Path, status: int) -> None:
    """Exercise CRLF, paths with spaces, guest cwd/temp, outputs and failure retention.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        status (int): Exit status of the ordinary gate.
    """
    worktree, env = guest_fixture(tmp_path)
    Path(env["WSL_STEP_SCRIPT"]).write_bytes(
        (
            'test "$PWD" = "$GITHUB_WORKSPACE/integration"\r\n'
            'test "$RUNNER_TEMP" = "$GITHUB_WORKSPACE/.ci-temp"\r\n'
            'echo "PI_BIN=$GITHUB_WORKSPACE/pi-release/bin/pi" >> "$GITHUB_ENV"\r\n'
            'echo "ran=true" >> "$GITHUB_OUTPUT"\r\n'
            f"exit {status}\r\n"
        ).encode()
    )
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == status
    assert Path(env["GITHUB_OUTPUT"]).read_text() == "ran=true\n"
    assert Path(env["GITHUB_ENV"]).read_text() == f"PI_BIN={worktree}/pi-release/bin/pi\n"
    assert "synthetic-sentinel" not in result.stdout + result.stderr
    failure = worktree / ".ci-temp/first-failure"
    assert failure.exists() is bool(status)
    if status:
        assert failure.read_text() == f"{status}\n"
    assert not list((worktree / ".ci-temp").glob("step.*"))


@pytest.mark.parametrize("directory", ["..", "../escape", "integration/../..", "escape-link"])
def test_guest_adapter_refuses_escaping_directory(tmp_path: Path, directory: str) -> None:
    """Fail before running a host script outside the guest checkout.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        directory (str): Logical or symlink traversal outside the guest checkout.
    """
    worktree, env = guest_fixture(tmp_path)
    (worktree / "escape-link").symlink_to(tmp_path, target_is_directory=True)
    env["WSL_STEP_DIRECTORY"] = directory
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "escapes guest checkout" in result.stderr


@pytest.mark.parametrize("export_failure", [False, True])
def test_capture_retains_first_failure_and_only_explicit_reports(
    tmp_path: Path, export_failure: bool
) -> None:
    """Run real export/cleanup against successively failed/successful guest steps.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        export_failure (bool): Inject a report-copy failure before cleanup.
    """
    worktree, env = guest_fixture(tmp_path)
    ti = worktree / ".ci-temp"
    (ti / "first-failure").write_text("47\n")
    (ti / "package-contracts.json").write_text("{}\n")
    (ti / "secret.txt").write_text("must not upload")
    startup = ti / "standalone-startup-diagnostics"
    startup.mkdir()
    (startup / "SHA256SUMS").write_text("synthetic scanned manifest\n")
    for name in ("artifacts", "artifacts-node", "artifacts-personal"):
        artifacts = worktree / "integration" / name
        artifacts.mkdir()
        (artifacts / "wsl2-personal.xml").write_text("<testsuite/>\n")
    scripts = worktree / "scripts"
    scripts.mkdir()
    shutil.copyfile(ROOT / "scripts/wsl2_cleanup.sh", scripts / "wsl2_cleanup.sh")
    host = tmp_path / "host"
    host_temp = host / "temp"
    (host_temp / "wsl2-diagnostics").mkdir(parents=True)
    env |= {"WSL_HOST_WORKSPACE": str(host), "WSL_HOST_TEMP": str(host_temp), "RUNNER_TEMP": str(ti)}
    commands = tmp_path / "commands"
    commands.mkdir()
    # Model DrvFs refusing timestamp/ownership preservation by an ordinary user.
    copy_script = (
        "#!/bin/sh\nexit 92\n"
        if export_failure
        else (
            f"#!{sys.executable}\n"
            "import os\nimport sys\n"
            "if sys.argv[1] in ('-a', '-p') or sys.argv[1].startswith('--preserve'):\n"
            "    sys.exit(93)\n"
            "os.execv('/bin/cp', ['/bin/cp', *sys.argv[1:]])\n"
        )
    )
    (commands / "cp").write_text(copy_script)
    (commands / "cp").chmod(0o755)
    env["PATH"] = f"{commands}{os.pathsep}{env['PATH']}"
    (ti / "tool-path").write_text(env["PATH"])
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh"), "cleanup"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 47
    assert not worktree.exists()
    for name in ("artifacts", "artifacts-node", "artifacts-personal"):
        assert (host / "integration" / name / "wsl2-personal.xml").is_file() is not export_failure
    assert (host_temp / "package-contracts.json").is_file() is not export_failure
    assert (host_temp / "wsl2-diagnostics/artifacts/wsl2-personal.xml").is_file() is not export_failure
    assert not (host_temp / "secret.txt").exists()
    assert (host_temp / "standalone-startup-diagnostics/SHA256SUMS").is_file() is not export_failure
    assert "status 47" in (host_temp / "wsl2-diagnostics/capture-status.txt").read_text()


def test_capture_does_not_publish_partial_startup_evidence(tmp_path: Path) -> None:
    """Refuse a partial host copy before announcing uploadable startup evidence.

    Parameters:
        tmp_path (Path): Disposable guest and host directories.
    """
    worktree, env = guest_fixture(tmp_path)
    startup = worktree / ".ci-temp/standalone-startup-diagnostics"
    startup.mkdir()
    (startup / "SHA256SUMS").write_text("synthetic manifest\n")
    host = tmp_path / "host"
    host_temp = host / "temp"
    host_temp.mkdir(parents=True)
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "cp").write_text('#!/bin/sh\nprintf partial > "$3/partial"\nexit 92\n')
    (commands / "cp").chmod(0o755)
    env |= {
        "WSL_HOST_WORKSPACE": str(host),
        "WSL_HOST_TEMP": str(host_temp),
        "PATH": f"{commands}{os.pathsep}{env['PATH']}",
    }
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"])
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert not (host_temp / "standalone-startup-diagnostics").exists()
    assert not list(host_temp.glob(".standalone-startup.*"))


def test_capture_replaces_stale_node_snapshot(tmp_path: Path) -> None:
    """Keep Node and standalone report trees distinct across guest renames.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    worktree, env = guest_fixture(tmp_path)
    host = tmp_path / "host"
    (host / "temp/wsl2-diagnostics").mkdir(parents=True)
    env |= {"WSL_HOST_WORKSPACE": str(host), "WSL_HOST_TEMP": str(host / "temp")}
    artifacts = worktree / "integration/artifacts"
    artifacts.mkdir()
    (artifacts / "node.xml").write_text("Node report")
    command = ["/bin/bash", str(ROOT / "scripts/wsl2_capture.sh")]
    subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    artifacts.rename(worktree / "integration/artifacts-node")
    artifacts.mkdir()
    (artifacts / "standalone.xml").write_text("Standalone report")
    subprocess.run(command, env=env, capture_output=True, text=True, check=True)
    assert not (host / "integration/artifacts/node.xml").exists()
    assert (host / "integration/artifacts/standalone.xml").read_text() == "Standalone report"
    assert (host / "integration/artifacts-node/node.xml").read_text() == "Node report"


@pytest.mark.parametrize("ambiguous_path", [False, True])
def test_host_launcher_preserves_script_arguments_and_exit_status(
    tmp_path: Path, ambiguous_path: bool
) -> None:
    """Prove host forwarding with a PowerShell argv stub, not a WSL runtime claim.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        ambiguous_path (bool): Resolve a shadowing legacy Windows Bash first.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "pwsh").write_text(
        '#!/bin/sh\ncase ";${MSYS2_ENV_CONV_EXCL:-};" in *";PI_BIN;"*) ;; *) exit 93 ;; esac\n'
        'test "$PI_BIN" = /root/pi-harness-ci/pi-release/bin/pi || exit 94\n'
        'printf "%s\\n" "$@" > "$ARGV_CAPTURE"\nexit 49\n'
    )
    (commands / "cygpath").write_text(
        '#!/bin/sh\ncase "$2" in */ambiguous/bash) printf "%s" "$LEGACY_BASH" ;; '
        '*) printf "%s" "$PI_CI_GIT_BASH" ;; esac\n'
    )
    for command in commands.iterdir():
        command.chmod(0o755)
    step = tmp_path / "step with spaces.sh"
    original = b'printf "%s\\n" "unchanged guest script"\n'
    step.write_bytes(original)
    workspace = tmp_path / "host checkout"
    arguments = tmp_path / "arguments.txt"
    env = dict(os.environ) | {
        "GITHUB_WORKSPACE": str(workspace),
        "ARGV_CAPTURE": str(arguments),
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "PI_CI_GIT_BASH": r"C:\Program Files\Git\bin\bash.exe",
        "LEGACY_BASH": r"C:\Windows\System32\bash.exe",
        "PI_BIN": "/root/pi-harness-ci/pi-release/bin/pi",
    }
    if ambiguous_path:
        ambiguous = tmp_path / "ambiguous"
        ambiguous.mkdir()
        (ambiguous / "bash").write_text("#!/bin/sh\nexit 97\n")
        (ambiguous / "bash").chmod(0o755)
        env["PATH"] = f"{ambiguous}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_host.sh"), str(step)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if ambiguous_path:
        assert result.returncode == 1
        assert "Refusing ambiguous Bash" in result.stderr
        assert not arguments.exists()
        return
    assert result.returncode == 49
    assert arguments.read_text().splitlines() == [
        "-NoProfile",
        "-File",
        str(workspace / "scripts/wsl2_shell.ps1"),
        str(step),
    ]
    assert step.read_bytes() == original


def test_toolchain_pins_and_token_lifetime_follow_shared_steps() -> None:
    """Pin the new per-step credential lifetime, not the retired monolithic unset.

    Returns:
        None: Verification precedes installers and tokens exist only in fetch steps.
    """
    tools = yaml.safe_load((ROOT / ".github/actions/setup-ci-tools/action.yml").read_text())
    uv = next(step for step in tools["runs"]["steps"] if "setup-uv@" in step.get("uses", ""))
    bootstrap = (ROOT / "scripts/wsl2_setup.sh").read_text()
    assert f"uv_version={uv['with']['version']}" in bootstrap
    assert bootstrap.index("unset GH_TOKEN") < bootstrap.index("curl ")
    assert "< .node-version" in bootstrap
    assert "< .bun-version" in bootstrap
    assert 'require("./package.json").packageManager' in bootstrap
    cfg = jobs()
    for name in ("owned", "contracts", "stack"):
        steps = cfg[name]["steps"]
        token_steps = [step for step in steps if "GH_TOKEN" in step.get("env", {})]
        if name == "stack":
            assert [step["name"] for step in token_steps] == [
                "Verify root core overrides before install",
                "Fetch exact Gitlinked core release, formula-equivalent install",
            ]
            commands = "\n".join(step.get("run", "") for step in steps)
            assert commands.index("--verify-root-overrides") < commands.index("npm ci --ignore-scripts")
            assert commands.index("--gitlink ../forks/pi") < commands.index("pytest scenarios/")
        else:
            assert [step["name"] for step in token_steps] == ["Install"]
        assert all(step["env"]["GH_TOKEN"] == "${{ github.token }}" for step in token_steps)
    wrapper = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    assert "GH_TOKEN/u" in wrapper
    assert "Get-ChildItem Env:" not in wrapper
    capture = (ROOT / ".github/actions/capture-ci-wsl/action.yml").read_text()
    assert '--exec bash -euo pipefail "$capture" "$env:WSL_CAPTURE_MODE"' in capture
    assert "-- bash" not in capture
    for boundary in (wrapper, capture, (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()):
        assert "--exec wslpath -u" in boundary
        assert "--exec bash -euo pipefail" in boundary
        assert " -c " not in boundary
        assert "--user pi-ci --exec bash -euo pipefail" in boundary
    setup = (ROOT / ".github/actions/setup-ci-wsl/action.yml").read_text()
    assert "--user root --exec /usr/sbin/useradd --create-home --shell /bin/bash pi-ci" in setup
    guest_setup = yaml.safe_load(setup)
    distribution = next(
        step for step in guest_setup["runs"]["steps"] if "Vampire/setup-wsl@" in step.get("uses", "")
    )
    # install-action needs jq; install system prerequisites before dropping root.
    assert "jq" in distribution["with"]["additional-packages"].split()


def test_guest_preflight_failure_is_recorded(tmp_path: Path) -> None:
    """Retain missing-toolchain failure before attempting an ordinary script.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    worktree, env = guest_fixture(tmp_path)
    (worktree / ".ci-temp/tool-path").unlink()
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert (worktree / ".ci-temp/first-failure").read_text() == "1\n"


@pytest.mark.parametrize("script", ["wsl2_setup.sh", "wsl2_run.sh"])
def test_guest_refuses_root_before_copy_or_gate(tmp_path: Path, script: str) -> None:
    """Reject privileged execution rather than skipping permission-error tests.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        script (str): Guest bootstrap or ordinary execution boundary.
    """
    worktree, env = guest_fixture(tmp_path)
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "id").write_text("#!/bin/sh\nprintf '0\\n'\n")
    (commands / "id").chmod(0o755)
    env["PATH"] = f"{commands}{os.pathsep}{env['PATH']}"
    (worktree / ".ci-temp/tool-path").write_text(env["PATH"])
    Path(env["WSL_STEP_SCRIPT"]).write_text("echo unexpected-gate\n")
    env["WSL_HOST_WORKSPACE"] = "/mnt/c/synthetic-checkout"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts" / script)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "unprivileged Linux user" in result.stderr
    assert "unexpected-gate" not in result.stdout


@pytest.mark.parametrize("filesystem", ["drvfs", ""])
def test_setup_refuses_non_linux_filesystem(tmp_path: Path, filesystem: str) -> None:
    """Execute setup's mount refusal before any download or install.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        filesystem (str): Unsupported findmnt result.
    """
    commands = tmp_path / "commands"
    commands.mkdir()
    (commands / "cp").write_text("#!/bin/sh\nexit 0\n")
    (commands / "findmnt").write_text(f"#!/bin/sh\nprintf '%s' '{filesystem}'\n")
    (commands / "curl").write_text("#!/bin/sh\necho unexpected-download >&2\nexit 99\n")
    for command in commands.iterdir():
        command.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    env = dict(os.environ) | {
        "HOME": str(home),
        "WSL_HOST_WORKSPACE": "/mnt/c/synthetic-checkout",
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
    }
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_setup.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "not on a Linux filesystem" in result.stderr
    assert "unexpected-download" not in result.stderr
