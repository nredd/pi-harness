"""Reproduce GitHub script generation and the pinned guest installer interface.

References:
    https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs
    https://github.com/taiki-e/install-action/tree/8cca0918f8471c33515202b73f56ab27f2bed283
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import textwrap
from pathlib import Path

import pytest
from test_coverage_round2 import commit_base

from coverage_accounting import git_read
from tests.test_coverage_accounting import policy

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("powershell_header", [False, True])
def test_github_generated_step_header_breaks_only_the_old_boundary(
    tmp_path: Path, powershell_header: bool
) -> None:
    """Execute the runner's documented PowerShell fixup under the real guest adapter.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        powershell_header (bool): Apply the old pwsh shell's script-generation fixup.
    """
    guest = tmp_path / "home/pi-harness-ci"
    (guest / ".ci-temp").mkdir(parents=True)
    (guest / ".ci-temp/tool-path").write_text(os.environ["PATH"])
    marker = tmp_path / "payload-ran"
    payload = 'printf success > "$PAYLOAD_MARKER"\n'
    generated = payload
    if powershell_header:
        generated = (
            "$ErrorActionPreference = 'stop'\n"
            + payload
            + "\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n"
        )
    step = tmp_path / "github-step"
    step.write_text(generated)
    env = dict(os.environ) | {
        "HOME": str(tmp_path / "home"),
        "WSL_STEP_DIRECTORY": ".",
        "WSL_STEP_SCRIPT": str(step),
        "PAYLOAD_MARKER": str(marker),
    }
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    if powershell_header:
        assert result.returncode == 127
        assert "=: command not found" in result.stderr
        assert not marker.exists()
    else:
        assert result.returncode == 0
        assert marker.read_text() == "success"
    assert step.read_text() == generated


def test_guest_adapter_labels_generated_step_failure(tmp_path: Path) -> None:
    """Name generated guest-step failures while preserving Bash's status and stderr.

    Parameters:
        tmp_path (Path): Disposable guest worktree and generated step.
    """
    guest = tmp_path / "home/pi-harness-ci"
    (guest / ".ci-temp").mkdir(parents=True)
    (guest / ".ci-temp/tool-path").write_text(os.environ["PATH"])
    step = tmp_path / "generated-step"
    step.write_text("missing-wsl-guest-command\n")
    env = dict(os.environ) | {
        "HOME": str(tmp_path / "home"),
        "WSL_STEP_DIRECTORY": ".",
        "WSL_STEP_SCRIPT": str(step),
    }
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 127
    assert "missing-wsl-guest-command: command not found" in result.stderr
    assert "wsl2-run: guest-step failed with status 127" in result.stderr
    assert (guest / ".ci-temp/first-failure").read_text() == "127\n"


def test_guest_commit_gate_receives_event_payload(tmp_path: Path) -> None:
    """Run the actual commit gate through the adapter's declared environment boundary.

    Parameters:
        tmp_path (Path): Disposable guest repository and host-visible event/control files.
    Returns:
        None: The real gate reads a full PR range, not a local fallback or missing payload.
    """
    node = shutil.which("node")
    assert node
    guest = tmp_path / "home/pi-harness-ci"
    guest.mkdir(parents=True)
    marker = guest / "marker"
    marker.write_text("base")
    commit_base(guest, policy())
    base = git_read(guest, ["rev-parse", "HEAD"]).strip()
    marker.write_text("head")
    commit_base(guest, policy())
    head = git_read(guest, ["rev-parse", "HEAD"]).strip()
    (guest / ".ci-temp").mkdir()
    (guest / ".ci-temp/tool-path").write_text(os.environ["PATH"])
    payload = tmp_path / "host event.json"
    payload.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}))
    step = tmp_path / "step.sh"
    gate = ROOT / "packages/computer-use/scripts/check-commit-messages.mjs"
    step.write_text(f'"{node}" "{gate}"\n')
    wrapper = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    declaration = next(line for line in wrapper.splitlines() if line.startswith("$env:WSLENV = "))
    entries = declaration.split("'", 2)[1].split(":")
    host = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(payload)}
    forwarded = {entry.split("/")[0] for entry in entries}
    env = {key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")}
    env.pop("COMMIT_RANGE", None)
    env |= {key: value for key, value in host.items() if key in forwarded}
    env |= {
        "HOME": str(tmp_path / "home"),
        "WSL_STEP_DIRECTORY": ".",
        "WSL_STEP_SCRIPT": str(step),
    }
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/wsl2_run.sh")], env=env, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert f"Checked 1 commit message(s) in {base}..{head}." in result.stdout
    assert "GITHUB_EVENT_PATH/p" in entries  # Windows paths require WSL's path translation.


def test_adapter_failure_labels_name_each_hop_without_environment_dumping() -> None:
    """Keep host, PowerShell, and guest diagnostics bounded to their failed hop."""
    host = (ROOT / "scripts/wsl2_host.sh").read_text()
    shell = (ROOT / "scripts/wsl2_shell.ps1").read_text()
    guest = (ROOT / "scripts/wsl2_run.sh").read_text()
    assert "wsl2-host: pwsh command not found" in host
    assert "wsl2-shell: wslpath failed with status $status" in shell
    assert "wsl2-shell: guest dispatch failed with status $status" in shell
    assert "wsl2-run: guest-step failed with status %s" in guest
    assert "Get-ChildItem Env:" not in host + shell + guest


def test_native_shell_preserves_implicit_baseline_pipeline_behavior(tmp_path: Path) -> None:
    """Keep native bash -e semantics rather than silently introducing pipefail.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
    """
    step = tmp_path / "pipeline.sh"
    step.write_text("false | true\nprintf survived\n")
    baseline = subprocess.run(["/bin/bash", "-e", str(step)], capture_output=True, text=True, check=False)
    changed = subprocess.run(
        ["/bin/bash", "-e", "-o", "pipefail", str(step)], capture_output=True, text=True, check=False
    )
    assert baseline.returncode == 0
    assert baseline.stdout == "survived"
    assert changed.returncode == 1
    workflow = (ROOT / ".github/workflows/ci.yml").read_text()
    assert workflow.count("github.workspace) || 'bash -e {0}' }}") == 3


@pytest.mark.parametrize("references", [1, 0, 2])
def test_guest_owned_tools_reuse_native_pinned_action(tmp_path: Path, references: int) -> None:
    """Execute the installer against a local action fixture, refusing ambiguous pins.

    Parameters:
        tmp_path (Path): Disposable fixture directory.
        references (int): Number of authoritative action references in the fixture.
    """
    repo = tmp_path / "repo"
    action = repo / ".github/actions/setup-ci-tools/action.yml"
    action.parent.mkdir(parents=True)
    pin = "8cca0918f8471c33515202b73f56ab27f2bed283"
    action.write_text(f"- uses: taiki-e/install-action@{pin}\n" * references)
    commands = tmp_path / "commands"
    commands.mkdir()
    for name in ("cargo", "rustc"):
        command = commands / name
        command.write_text("#!/bin/sh\nprintf 'fixture tool version\\n'\n")
        command.chmod(0o755)
    source = tmp_path / "action-source"
    source.mkdir()
    (source / "main.sh").write_text(
        textwrap.dedent("""\
        set -euo pipefail
        test "$INPUT_TOOL" = rust+rustfmt+clippy,cargo-nextest
        test "$INPUT_CHECKSUM" = true
        test "$INPUT_FALLBACK" = none
        test "$RUNNER_OS" = Linux
        test "$RUNNER_ARCH" = X64
        test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${DEFAULT_GITHUB_TOKEN:-}"
        printf '%s\n' "$FAKE_BIN" >> "$GITHUB_PATH"
        printf invoked > "$INSTALL_RECEIPT"
        """)
    )
    archive = tmp_path / "action.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source, arcname="install-action")
    (commands / "curl").write_text(
        textwrap.dedent(f"""\
        #!{sys.executable}
        import os
        import shutil
        import sys
        from pathlib import Path
        args = sys.argv[1:]
        Path(os.environ['FETCH_RECEIPT']).write_text(args[-1])
        shutil.copyfile(os.environ['FAKE_ARCHIVE'], args[args.index('--output') + 1])
        """)
    )
    (commands / "curl").chmod(0o755)
    receipt = tmp_path / "installed"
    fetch = tmp_path / "fetched"
    env = dict(os.environ) | {
        "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
        "FAKE_BIN": str(commands),
        "FAKE_ARCHIVE": str(archive),
        "INSTALL_RECEIPT": str(receipt),
        "FETCH_RECEIPT": str(fetch),
        "GH_TOKEN": "sentinel",
        "GITHUB_TOKEN": "sentinel",
        "DEFAULT_GITHUB_TOKEN": "sentinel",
    }
    tools = tmp_path / "tools"
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/install_wsl_owned_tools.sh"), str(tools)],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if references != 1:
        assert result.returncode != 0
        assert not fetch.exists()
        assert not receipt.exists()
        return
    assert result.returncode == 0, result.stderr
    assert fetch.read_text() == f"https://codeload.github.com/taiki-e/install-action/tar.gz/{pin}"
    assert receipt.read_text() == "invoked"
    assert str(commands) in (tools / "owned-tool-path").read_text()
    assert "sentinel" not in result.stdout + result.stderr
    native = (ROOT / ".github/actions/setup-ci-tools/action.yml").read_text()
    assert f"taiki-e/install-action@{pin}" in native
    bootstrap = (ROOT / "scripts/wsl2_setup.sh").read_text()
    assert "cargo install cargo-nextest" not in bootstrap
    assert "sh.rustup.rs" not in bootstrap
