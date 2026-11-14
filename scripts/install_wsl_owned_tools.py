"""Execute the same SHA-pinned install-action manifest as the native owned cell, inside the WSL guest.

Usage: `install_wsl_owned_tools.sh <tool-dir>` from the checkout root. The shell file is only a compatibility
bootstrap; the logic lives here so `python-scripts` measures it. Standard library only: it runs on the guest's
system `python3` (3.12) before any uv environment exists.

Official contract: `install-action/action.yml` maps `INPUT_*` and runs `main.sh`. The action ref is read from
`.github/actions/setup-ci-tools/action.yml`, which must pin exactly one `taiki-e/install-action` SHA. The
downloaded `main.sh` runs with the GitHub tokens removed from its environment, and the caller imports only the
explicit `PATH` receipt written at the end, never sources downloaded output.

References:
    https://github.com/taiki-e/install-action
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from wsl2_exec import Runner, run_command

SETUP_ACTION = Path(".github/actions/setup-ci-tools/action.yml")
ACTION_REF = re.compile(r"uses: taiki-e/install-action@([0-9a-f]{40})")
# `uname -m` -> GitHub's `RUNNER_ARCH`
RUNNER_ARCHES = {"x86_64": "X64", "aarch64": "ARM64", "arm64": "ARM64"}
# Short, fixed bounds: wsl2_setup.sh wraps this whole script in a 90s `timeout`.
CURL_BOUNDS = ["--connect-timeout", "15", "--max-time", "45"]
SCRUBBED_TOKENS = ("GH_TOKEN", "GITHUB_TOKEN", "DEFAULT_GITHUB_TOKEN")
VERSION_PROBES = (
    ["rustc", "--version"],
    ["cargo", "--version"],
    ["cargo", "fmt", "--version"],
    ["cargo", "clippy", "--version"],
    ["cargo", "nextest", "--version"],
)


def _fail(message: str) -> int:
    """Report one failure line.

    Parameters:
        message (str): Text without the `install_wsl_owned_tools:` prefix or newline.

    Returns:
        int: Exit status 1.
    """
    sys.stderr.write(f"install_wsl_owned_tools: {message}\n")
    return 1


def _pinned_ref(action: Path) -> str | None:
    """Return the one authoritative install-action SHA.

    Parameters:
        action (Path): The shared setup action manifest.

    Returns:
        str | None: The 40-hex ref, or `None` when the manifest is unreadable or does not pin exactly one.
    """
    try:
        refs = ACTION_REF.findall(action.read_text(encoding="utf-8"))
    except OSError:
        return None
    return refs[0] if len(refs) == 1 else None


def _path_entries(receipt: Path) -> list[str]:
    """Read the directories the action asked to prepend to `PATH`.

    Parameters:
        receipt (Path): The `GITHUB_PATH` file, one directory per newline-terminated line.

    Returns:
        list[str]: Non-empty directories in file order; the caller prepends them one by one. An empty entry
            would put the working directory on `PATH`, and an unterminated final line was never a complete
            write, so neither is returned.
    """
    return [line for line in receipt.read_text(encoding="utf-8").split("\n")[:-1] if line]


def _install(tool_dir: Path, ref: str, runner_arch: str, run: Runner, environ: Mapping[str, str]) -> int:
    """Fetch the pinned action, run its `main.sh`, probe the toolchain and write the `PATH` receipt.

    Parameters:
        tool_dir (Path): Directory that receives the action checkout and the receipts.
        ref (str): The pinned install-action commit.
        runner_arch (str): `X64` or `ARM64`.
        run (Runner): `subprocess.run`-compatible callable.
        environ (Mapping[str, str]): The parent environment.

    Returns:
        int: 0 on success, else the failing command's status.
    """
    action_dir = tool_dir / "install-action"
    archive = tool_dir / "install-action.tar.gz"
    action_dir.mkdir(parents=True, exist_ok=True)
    url = f"https://codeload.github.com/taiki-e/install-action/tar.gz/{ref}"
    curl = ["curl", "--fail", "--location", "--retry", "3", *CURL_BOUNDS, "--output", str(archive), url]
    untar = ["tar", "-xzf", str(archive), "--strip-components=1", "--directory", str(action_dir)]
    for command in (curl, untar):
        if status := run_command(command, run)[0]:
            return status
    receipt = tool_dir / "install-action-paths"
    receipt.write_text("", encoding="utf-8")
    action_env = {key: value for key, value in environ.items() if key not in SCRUBBED_TOKENS} | {
        "INPUT_TOOL": "rust+rustfmt+clippy,cargo-nextest",
        "INPUT_CHECKSUM": "true",
        "INPUT_FALLBACK": "none",
        "GITHUB_ACTION_PATH": str(action_dir),
        "GITHUB_PATH": str(receipt),
        "RUNNER_OS": "Linux",
        "RUNNER_ARCH": runner_arch,
        "ACTION_USER_AGENT": f"taiki-e/install-action ({ref})",
    }
    main_sh = ["bash", "--noprofile", "--norc", str(action_dir / "main.sh")]
    if status := run_command(main_sh, run, env=action_env)[0]:
        return status
    # Each receipt line is prepended in turn, so the last line written ends up first on PATH.
    search = os.pathsep.join([*reversed(_path_entries(receipt)), environ.get("PATH", os.defpath)])
    probe_env = dict(environ) | {"PATH": search}
    for probe in VERSION_PROBES:
        if status := run_command(probe, run, env=probe_env)[0]:
            return status
    # Caller imports only this explicit PATH receipt, never sources downloaded output.
    (tool_dir / "owned-tool-path").write_text(f"{search}\n", encoding="utf-8")
    return 0


def main(argv: Sequence[str], run: Runner = subprocess.run, environ: Mapping[str, str] | None = None) -> int:
    """Install the pinned Rust toolchain and `cargo-nextest` the way the native owned cell does.

    Parameters:
        argv (Sequence[str]): Arguments after the program name; exactly one tool directory.
        run (Runner): `subprocess.run`-compatible callable, injected by tests.
        environ (Mapping[str, str] | None): Parent environment; defaults to `os.environ`.

    Returns:
        int: 0 on success, 1 for usage, an unreadable or ambiguous action pin, an unsupported architecture or
            a filesystem error, else the failing command's status.
    """
    env = os.environ if environ is None else environ
    if len(argv) != 1 or not argv[0]:
        return _fail("exactly one tool directory required")
    if (ref := _pinned_ref(SETUP_ACTION)) is None:
        return _fail("expected one authoritative install-action SHA")
    machine = run_command(["uname", "-m"], run, capture=True)[1].rstrip("\n")
    if (runner_arch := RUNNER_ARCHES.get(machine)) is None:
        return _fail(f"unsupported architecture '{machine}'")
    try:
        return _install(Path(argv[0]), ref, runner_arch, run, env)
    except OSError as exc:
        return _fail(str(exc))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
