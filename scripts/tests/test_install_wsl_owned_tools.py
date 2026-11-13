"""Exercise `install_wsl_owned_tools.py` in-process with an injected command runner."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install_wsl_owned_tools as tools

PIN = "0123456789abcdef0123456789abcdef01234567"
OTHER_PIN = "fedcba9876543210fedcba9876543210fedcba98"
ACTION_USE = "uses: taiki-e/install-action@"


class Fake:
    """Scripted stand-in for `subprocess.run` that records every argv and environment."""

    def __init__(
        self,
        *,
        machine: str = "x86_64",
        failing: dict[str, int] | None = None,
        paths: str = "/fake/a\n/fake/b\n",
    ) -> None:
        """Script the host.

        Parameters:
            machine (str): `uname -m` output.
            failing (dict[str, int] | None): Exit status per command, keyed by the joined argv tail
                (`curl`, `tar`, `main.sh`, `cargo fmt`, ...).
            paths (str): What the action's `main.sh` appends to `GITHUB_PATH`.
        """
        self.machine = machine
        self.failing = failing or {}
        self.paths = paths
        self.calls: list[tuple[list[str], dict[str, str] | None]] = []

    def __call__(self, cmd: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Record one command and answer it.

        Parameters:
            cmd (Sequence[str]): Argument vector.
            **kwargs (Any): `subprocess.run` options; only `env` is recorded.

        Returns:
            subprocess.CompletedProcess[str]: Scripted result.
        """
        argv = list(cmd)
        env = kwargs.get("env")
        self.calls.append((argv, env))
        key = (
            Path(argv[0]).name if Path(argv[0]).name != "cargo" else " ".join(["cargo", *argv[1:-1]]).strip()
        )
        if key == "bash":
            assert env is not None
            Path(env["GITHUB_PATH"]).write_text(self.paths)
            key = "main.sh"
        if key == "uname":
            return subprocess.CompletedProcess(argv, 0, f"{self.machine}\n")
        return subprocess.CompletedProcess(argv, self.failing.get(key, 0), "")

    def names(self) -> list[str]:
        """Return the executed commands in order, `uname` excluded.

        Returns:
            list[str]: Command names such as `curl`, `tar`, `bash`, `rustc`.
        """
        return [Path(argv[0]).name for argv, _ in self.calls if Path(argv[0]).name != "uname"]


@pytest.fixture(autouse=True)
def checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run from a fake checkout root whose setup action pins exactly one install-action SHA."""
    root = tmp_path / "checkout"
    action = root / ".github/actions/setup-ci-tools/action.yml"
    action.parent.mkdir(parents=True)
    action.write_text(f"steps:\n  - {ACTION_USE}{PIN} # v2\n")
    monkeypatch.chdir(root)
    return root


def run_main(tool_dir: Path, fake: Fake, environ: Mapping[str, str] | None = None) -> int:
    """Run `main` against `tool_dir` with a deterministic environment."""
    env = {
        "PATH": "/usr/bin",
        "GH_TOKEN": "t1",
        "GITHUB_TOKEN": "t2",
        "DEFAULT_GITHUB_TOKEN": "t3",
        "KEEP": "1",
    }
    return tools.main([str(tool_dir)], fake, env if environ is None else environ)


@pytest.mark.parametrize(("machine", "arch"), [("x86_64", "X64"), ("aarch64", "ARM64"), ("arm64", "ARM64")])
def test_installs_the_pinned_action_for_the_architecture(tmp_path: Path, machine: str, arch: str) -> None:
    """Fetch the pinned archive, run `main.sh` token-free, probe every tool, write the PATH receipt."""
    target = tmp_path / "tools"
    fake = Fake(machine=machine)
    assert run_main(target, fake) == 0
    assert fake.names() == ["curl", "tar", "bash", "rustc", "cargo", "cargo", "cargo", "cargo"]
    curl = fake.calls[1][0]
    assert curl[-1] == f"https://codeload.github.com/taiki-e/install-action/tar.gz/{PIN}"
    assert curl[curl.index("--output") + 1] == str(target / "install-action.tar.gz")
    assert "--fail" in curl
    assert curl[curl.index("--retry") + 1] == "3"
    assert curl[curl.index("--connect-timeout") : curl.index("--connect-timeout") + 4] == [
        "--connect-timeout",
        "15",
        "--max-time",
        "45",
    ]
    tar = fake.calls[2][0]
    assert tar[1:] == [
        "-xzf",
        str(target / "install-action.tar.gz"),
        "--strip-components=1",
        "--directory",
        str(target / "install-action"),
    ]
    main_argv, main_env = fake.calls[3]
    assert main_argv == ["bash", "--noprofile", "--norc", str(target / "install-action/main.sh")]
    assert main_env is not None
    assert main_env["INPUT_TOOL"] == "rust+rustfmt+clippy,cargo-nextest"
    assert (main_env["INPUT_CHECKSUM"], main_env["INPUT_FALLBACK"]) == ("true", "none")
    assert (main_env["RUNNER_OS"], main_env["RUNNER_ARCH"]) == ("Linux", arch)
    assert main_env["GITHUB_ACTION_PATH"] == str(target / "install-action")
    assert main_env["GITHUB_PATH"] == str(target / "install-action-paths")
    assert main_env["ACTION_USER_AGENT"] == f"taiki-e/install-action ({PIN})"
    assert main_env["KEEP"] == "1"
    assert not {"GH_TOKEN", "GITHUB_TOKEN", "DEFAULT_GITHUB_TOKEN"} & main_env.keys()
    probes = [argv for argv, _ in fake.calls[4:]]
    assert probes == [
        ["rustc", "--version"],
        ["cargo", "--version"],
        ["cargo", "fmt", "--version"],
        ["cargo", "clippy", "--version"],
        ["cargo", "nextest", "--version"],
    ]
    expected = "/fake/b:/fake/a:/usr/bin"
    assert all(env is not None and env["PATH"] == expected for _, env in fake.calls[4:])
    assert (target / "owned-tool-path").read_text() == f"{expected}\n"


def test_path_receipt_ignores_empty_and_unterminated_lines(tmp_path: Path) -> None:
    """An empty entry would put the working directory on PATH; a torn final line is not a complete write."""
    fake = Fake(paths="/fake/a\n\n/fake/b\n/torn")
    assert run_main(tmp_path / "tools", fake) == 0
    assert (tmp_path / "tools/owned-tool-path").read_text() == "/fake/b:/fake/a:/usr/bin\n"


def test_path_receipt_defaults_to_the_standard_search_path(tmp_path: Path) -> None:
    """A parent without `PATH` still yields a usable receipt."""
    assert run_main(tmp_path / "tools", Fake(paths=""), {}) == 0
    assert (tmp_path / "tools/owned-tool-path").read_text().rstrip("\n") == os.defpath


def test_main_reads_the_process_environment_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without an injected environment the real one is scrubbed of tokens and forwarded."""
    monkeypatch.setenv("GH_TOKEN", "secret")
    monkeypatch.setenv("PATH", "/usr/bin")
    fake = Fake()
    assert tools.main([str(tmp_path / "tools")], fake) == 0
    main_env = fake.calls[3][1]
    assert main_env is not None
    assert "GH_TOKEN" not in main_env
    assert main_env["PATH"] == "/usr/bin"


@pytest.mark.parametrize("argv", [[], [""], ["a", "b"]])
def test_requires_a_tool_directory(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    """A missing directory fails before any command runs."""
    fake = Fake()
    assert tools.main(argv, fake, {}) == 1
    assert "exactly one tool directory required" in capsys.readouterr().err
    assert not fake.calls


@pytest.mark.parametrize("manifest", [None, "steps: []\n", f"{ACTION_USE}{PIN}\n{ACTION_USE}{OTHER_PIN}\n"])
def test_refuses_a_missing_or_ambiguous_action_pin(
    tmp_path: Path, checkout: Path, manifest: str | None, capsys: pytest.CaptureFixture[str]
) -> None:
    """Zero pins, two pins or no manifest: nothing is fetched or run."""
    action = checkout / tools.SETUP_ACTION
    if manifest is None:
        action.unlink()
    else:
        action.write_text(manifest)
    fake = Fake()
    assert run_main(tmp_path / "tools", fake) == 1
    assert "expected one authoritative install-action SHA" in capsys.readouterr().err
    assert not fake.calls
    assert not (tmp_path / "tools").exists()


def test_a_ref_that_is_not_a_full_sha_is_not_a_pin(tmp_path: Path, checkout: Path) -> None:
    """A tag or abbreviated SHA must never be accepted as the authoritative pin."""
    (checkout / tools.SETUP_ACTION).write_text(f"{ACTION_USE}v2\n{ACTION_USE}{PIN[:39]}\n")
    assert run_main(tmp_path / "tools", Fake()) == 1


@pytest.mark.parametrize("machine", ["riscv64", "i686", ""])
def test_refuses_unsupported_architectures_before_downloading(
    tmp_path: Path, machine: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Off x86_64/aarch64 the installer names the architecture and touches nothing."""
    fake = Fake(machine=machine)
    assert run_main(tmp_path / "tools", fake) == 1
    assert f"unsupported architecture '{machine}'\n" in capsys.readouterr().err
    assert fake.names() == []
    assert not (tmp_path / "tools").exists()


@pytest.mark.parametrize(
    ("tool", "status"),
    [
        ("curl", 22),
        ("tar", 2),
        ("main.sh", 9),
        ("rustc", 3),
        ("cargo", 4),
        ("cargo fmt", 5),
        ("cargo clippy", 6),
        ("cargo nextest", 7),
    ],
)
def test_propagates_the_failing_command_status_without_a_receipt(
    tmp_path: Path, tool: str, status: int
) -> None:
    """Any failing download, extraction, action or probe exits with that status and leaves no PATH receipt."""
    assert run_main(tmp_path / "tools", Fake(failing={tool: status})) == status
    assert not (tmp_path / "tools/owned-tool-path").exists()


def test_a_missing_download_tool_exits_127(tmp_path: Path) -> None:
    """An unstartable `curl` reports status 127 like a shell instead of a traceback."""

    def missing(cmd: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd[0] == "curl":
            raise FileNotFoundError(2, "No such file or directory")
        return Fake()(cmd, **kwargs)

    assert tools.main([str(tmp_path / "tools")], missing, {}) == 127


def test_a_filesystem_error_is_one_line_and_status_1(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """An unusable tool directory reports the OS error instead of a traceback."""
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    assert run_main(blocker / "tools", Fake()) == 1
    assert "install_wsl_owned_tools:" in capsys.readouterr().err


def test_runs_as_a_script_from_the_checkout_root(checkout: Path) -> None:
    """The bootstrap's `python3 install_wsl_owned_tools.py` entry point exits with `main`'s status."""
    completed = subprocess.run(
        [sys.executable, tools.__file__], cwd=checkout, capture_output=True, text=True, check=False
    )
    assert completed.returncode == 1
    assert "exactly one tool directory required" in completed.stderr
