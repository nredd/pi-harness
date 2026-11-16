"""Behavioral command-boundary tests for the measured WSL bootstrap.

References:
    https://github.com/nredd/pi-harness/issues/695
"""

from __future__ import annotations

import runpy
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import wsl2_setup as setup


class Guest:
    """Deterministic external-tool boundary, with real checkout and receipt files."""

    def __init__(self, root: Path) -> None:
        """Create the guest filesystem and environment.

        Parameters:
            root (Path): Isolated fixture root.
        """
        self.root = root
        self.workspace = root / "workspace"
        self.workspace.mkdir()
        (self.workspace / ".git").write_text("gitdir: fixture\n")
        self.pins(self.workspace)
        self.env = {
            "HOME": str(root),
            "PATH": "/usr/bin:/bin",
            "GH_TOKEN": "must-not-leak",
            "PI_WSL2_IN_GUEST": "1",
            "GITHUB_WORKSPACE": str(self.workspace),
            "RUNNER_TEMP": str(root / "temp"),
            "GITHUB_PATH": str(root / "github-path"),
            "WSL_HOST_WORKSPACE": "/mnt/c/checkout with spaces",
            "WSL_HOST_TEMP": str(root / "host-temp"),
        }
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.outputs = {
            "id": "1000\n",
            "uname": "x86_64\n",
            "findmnt": "ext4\n",
            "node": "v22.0.0\n",
            "npm": "10.0.0\n",
            "bun": "1.0.0\n",
            "uv": "uv 0.13.1 (fixture)\n",
            "gh": f"gh version {setup.GH_VERSION} (fixture)\n",
        }
        self.fail_at = -1
        self.status = 7
        self.probe_status = 0
        self.bake = True

    @staticmethod
    def pins(workspace: Path) -> None:
        """Write independent version fixtures.

        Parameters:
            workspace (Path): Fake checkout.
        """
        (workspace / ".node-version").write_bytes(b"22.0.0\r\n")
        (workspace / ".bun-version").write_bytes(b"1.0.0\r\n")

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Model tool effects, version output and command failure.

        Parameters:
            cmd (list[str]): Actual process argv.
            kwargs (Any): Process options.

        Returns:
            subprocess.CompletedProcess[str]: Scripted outcome.
        """
        assert "GH_TOKEN" not in kwargs["env"]
        self.calls.append((cmd, kwargs))
        if len(self.calls) == self.fail_at:
            return subprocess.CompletedProcess(cmd, self.status, "")
        if kwargs["stderr"] == subprocess.DEVNULL and not self.bake:
            return subprocess.CompletedProcess(cmd, 1, "")
        if cmd[0] == "ps":
            return subprocess.CompletedProcess(cmd, 1, "\n".join(f"process-{i}" for i in range(60)))
        if cmd[0] == "timeout":
            child = cmd[3:]
            if child[0] == "cp":
                self.pins(Path(child[-1]))
            if child[:2] == ["bash", "scripts/install_wsl_owned_tools.sh"]:
                (Path(child[2]) / "owned-tool-path").write_text("/owned/bin\n")
            return subprocess.CompletedProcess(
                cmd, self.probe_status if child[:2] == ["bash", "-c"] else 0, ""
            )
        if cmd[:2] == ["node", "-p"]:
            return subprocess.CompletedProcess(cmd, 0, "npm@10.0.0+sha512.fixture\n")
        return subprocess.CompletedProcess(cmd, 0, self.outputs.get(Path(cmd[0]).name, ""))


def test_root_refusal(tmp_path: Path) -> None:
    """Refuse privileged execution before touching the checkout.

    Parameters:
        tmp_path (Path): Fixture root.
    """
    guest = Guest(tmp_path)
    guest.outputs["id"] = "0\n"
    assert setup.main(guest, guest.env) == 1
    assert len(guest.calls) == 1


def test_cli_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise the real entry point with default environment selection.

    Parameters:
        tmp_path (Path): Fixture root.
        monkeypatch (pytest.MonkeyPatch): Process isolation.
    """
    guest = Guest(tmp_path)
    guest.outputs["id"] = "0\n"
    monkeypatch.setattr(subprocess, "run", guest)
    with pytest.raises(SystemExit) as caught:
        runpy.run_path(str(Path(setup.__file__)), run_name="__main__")
    assert caught.value.code == 1


def test_non_owned_guest(tmp_path: Path) -> None:
    """Do not probe or install Rust when owned tools are not requested.

    Parameters:
        tmp_path (Path): Fixture root.
    """
    guest = Guest(tmp_path)
    assert setup.main(guest, guest.env) == 0
    assert not any(cmd[0] == "timeout" for cmd, _ in guest.calls)


@pytest.mark.parametrize("arch", ["x86_64", "aarch64", "arm64"])
def test_baked_guest_receipts(tmp_path: Path, arch: str) -> None:
    """Reuse baked tools and preserve PATH precedence without mutating the caller environment.

    Parameters:
        tmp_path (Path): Fixture root.
        arch (str): Supported architecture.
    """
    guest = Guest(tmp_path)
    guest.outputs["uname"] = arch + "\n"
    guest.env["WSL_OWNED"] = "true"
    Path(guest.env["GITHUB_PATH"]).write_text("existing\n")
    assert setup.main(guest, guest.env) == 0
    assert guest.env["PATH"] == "/usr/bin:/bin"
    assert guest.env["GH_TOKEN"] == "must-not-leak"
    receipt = (guest.workspace / ".ci-temp/tool-path").read_text().strip()
    lines = Path(guest.env["GITHUB_PATH"]).read_text().splitlines()
    assert lines == ["existing", *reversed([p for p in receipt.split(":") if p.startswith(f"{tmp_path}/")])]
    assert receipt.startswith(f"{tmp_path}/.cache/pi-harness-wsl2-tools/gh/bin:{tmp_path}/.cargo/bin:")
    assert not any(cmd[0] == "timeout" and cmd[3] == "curl" for cmd, _ in guest.calls)
    identity = (tmp_path / "temp/wsl2-diagnostics/identity.txt").read_text()
    assert f"Arch: {arch}\nNode: v22.0.0\nBun: 1.0.0\n" in identity
    assert "Guest setup complete" in (tmp_path / "temp/wsl2-diagnostics/capture-status.txt").read_text()


@pytest.mark.parametrize("guest_mode", [True, False])
def test_install_tools(tmp_path: Path, guest_mode: bool) -> None:
    """Install every tool using bounded literal argv and publish the owned-tool PATH.

    Parameters:
        tmp_path (Path): Fixture root.
        guest_mode (bool): Whether to reuse the ext4 checkout.
    """
    guest = Guest(tmp_path)
    guest.bake = False
    guest.env["PI_WSL2_IN_GUEST"] = "1" if guest_mode else "0"
    guest.env["WSL_OWNED"] = "true"
    guest.outputs["uname"] = "arm64\n"
    assert setup.main(guest, guest.env) == 0
    cmds = [cmd for cmd, _ in guest.calls]
    downloads = [cmd for cmd in cmds if cmd[:4] == ["timeout", "--kill-after=10", "180", "curl"]]
    assert len(downloads) == 3
    assert downloads[0][-1] == "https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-arm64.tar.xz"
    assert downloads[0][4:13] == [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--connect-timeout",
        "15",
        "--max-time",
        "45",
        "--output",
    ]
    bounded = [cmd for cmd in cmds if cmd[0] == "timeout"]
    assert any(
        cmd[2:5] == ["60", "env", f"npm_config_prefix={tmp_path}/.cache/pi-harness-wsl2-tools/npm"]
        for cmd in bounded
    )
    assert any(cmd[-1] == "bun-v1.0.0" for cmd in bounded)
    assert any(cmd[2:5] == ["90", "bash", "scripts/install_wsl_owned_tools.sh"] for cmd in bounded)
    workspace = guest.workspace if guest_mode else tmp_path / "pi-harness-ci"
    assert (
        workspace / ".ci-temp/tool-path"
    ).read_text() == f"{tmp_path}/.cache/pi-harness-wsl2-tools/gh/bin:/owned/bin\n"
    if not guest_mode:
        assert cmds[2] == [
            "timeout",
            "--kill-after=10",
            "60",
            "cp",
            "-a",
            "/mnt/c/checkout with spaces/.",
            str(workspace),
        ]
        assert not Path(guest.env["GITHUB_PATH"]).exists()


@pytest.mark.parametrize("failure", ["arch", "git", "source", "existing", "drvfs", "empty", "missing", "io"])
def test_refusals(tmp_path: Path, failure: str) -> None:
    """Refuse unsupported checkouts and missing environment before tool installation.

    Parameters:
        tmp_path (Path): Fixture root.
        failure (str): Refusal case.
    """
    guest = Guest(tmp_path)
    if failure == "arch":
        guest.outputs["uname"] = "riscv64"
    elif failure == "git":
        (guest.workspace / ".git").unlink()
    elif failure in ("source", "existing"):
        guest.env["PI_WSL2_IN_GUEST"] = "0"
        if failure == "source":
            guest.env["WSL_HOST_WORKSPACE"] = "/wrong"
        else:
            (tmp_path / "pi-harness-ci").mkdir()
    elif failure in ("drvfs", "empty"):
        guest.outputs["findmnt"] = "drvfs" if failure == "drvfs" else ""
    elif failure == "missing":
        del guest.env["HOME"]
    else:
        (guest.workspace / ".node-version").unlink()
    assert setup.main(guest, guest.env) == 1
    assert not any(cmd[0] == "timeout" for cmd, _ in guest.calls)


@pytest.mark.parametrize(("tool", "output"), [("node", "wrong"), ("bun", "wrong"), ("uv", "wrong")])
def test_installed_version_mismatch(tmp_path: Path, tool: str, output: str) -> None:
    """Refuse wrong installed versions after download rather than publishing success.

    Parameters:
        tmp_path (Path): Fixture root.
        tool (str): Wrong tool.
        output (str): Probe output.
    """
    guest = Guest(tmp_path)
    guest.outputs[tool] = output
    assert setup.main(guest, guest.env) == 1
    assert not (guest.workspace / ".ci-temp/tool-path").exists()


@pytest.mark.parametrize("status", [7, 124, 137])
def test_every_command_failure(tmp_path: Path, status: int, capsys: pytest.CaptureFixture[str]) -> None:
    """Retain every setup command failure and bound timeout process snapshots to forty rows.

    Parameters:
        tmp_path (Path): Fixture root.
        status (int): External failure status.
        capsys (pytest.CaptureFixture[str]): Diagnostics capture.
    """
    # Collect a successful hosted trace, then fail each public subprocess boundary in isolation.
    root = tmp_path / "trace"
    root.mkdir()
    trace = Guest(root)
    trace.env["PI_WSL2_IN_GUEST"] = "0"
    trace.env["WSL_OWNED"] = "true"
    assert setup.main(trace, trace.env) == 0
    for index, (cmd, _) in enumerate(trace.calls, 1):
        case = tmp_path / str(index)
        case.mkdir()
        guest = Guest(case)
        guest.env["PI_WSL2_IN_GUEST"] = "0"
        guest.env["WSL_OWNED"] = "true"
        guest.fail_at = index
        guest.status = status
        assert setup.main(guest, guest.env) == status, cmd
        error = capsys.readouterr().err
        if cmd[0] == "timeout":
            assert ("TIMEOUT" if status in (124, 137) else "FAILED") in error
        assert "process-40" not in error


def test_cached_node_and_failed_owned_probe(tmp_path: Path) -> None:
    """Prefer executable cached Node and fall back when the guest Rust probe fails.

    Parameters:
        tmp_path (Path): Fixture root.
    """
    guest = Guest(tmp_path)
    node = tmp_path / ".cache/pi-harness-wsl2-tools/node-v22.0.0-linux-x64/bin/node"
    node.parent.mkdir(parents=True)
    node.write_text("fixture")
    node.chmod(0o755)
    guest.env["WSL_OWNED"] = "true"
    guest.probe_status = 1
    assert setup.main(guest, guest.env) == 0
    assert any("scripts/install_wsl_owned_tools.sh" in cmd for cmd, _ in guest.calls)
    assert any(kwargs["env"]["PATH"].startswith(str(node.parent)) for cmd, kwargs in guest.calls)


@pytest.mark.parametrize("output", ["", "wrong\n", "v22.0.0 extra\n"])
def test_baked_output_first_line(tmp_path: Path, output: str) -> None:
    """Handle empty, mismatched and suffixed baked probes at the main boundary.

    Parameters:
        tmp_path (Path): Fixture root.
        output (str): Node probe output.
    """
    guest = Guest(tmp_path)
    guest.outputs["node"] = output
    assert setup.main(guest, guest.env) == 1
