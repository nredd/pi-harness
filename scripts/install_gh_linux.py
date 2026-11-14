"""Install the pinned official GitHub CLI into a directory, for runners whose package manager ships a `gh`
without `attestation` (Ubuntu 24.04 apt has 2.45; `gh attestation verify` needs 2.49+).

Usage: `install_gh_linux.sh <install-dir>`, then put `<install-dir>/bin` on `PATH`. The shell file is only a
compatibility bootstrap; the logic lives here so `python-scripts` measures it. Standard library only: it runs
on the guest's system `python3` (3.12) before any uv environment exists.

The tarball and its sha256 are from the immutable cli/cli release; the digest was checked against
`gh release verify-asset v2.103.2 gh_2.103.2_linux_<arch>.tar.gz --repo cli/cli` for each arch. To bump,
repeat that on the new release and change the version and BOTH digests below. No token is read, written
or echoed.
`curl`, `sha256sum`, `tar` and `uname` are resolved through `PATH` on purpose: the CI fixtures stub them.

References:
    https://github.com/cli/cli/releases
    https://cli.github.com/manual/gh_attestation_verify
"""

from __future__ import annotations

import signal
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

from wsl2_exec import Runner, run_command, terminate

GH_VERSION = "2.103.2"
GH_SHA256_AMD64 = "62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8"
GH_SHA256_ARM64 = "4c3e99a50bd8b181a3fe9d69b25dd978bac768148d88f01507c6b4d1ef61a443"
# `uname -m` -> (asset architecture, pinned sha256)
ASSETS = {
    "x86_64": ("amd64", GH_SHA256_AMD64),
    "aarch64": ("arm64", GH_SHA256_ARM64),
    "arm64": ("arm64", GH_SHA256_ARM64),
}


def _uname(flag: str, run: Runner) -> str:
    """Return one `uname` field.

    Parameters:
        flag (str): `-s` or `-m`.
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        str: The field without its trailing newline.
    """
    return run_command(["uname", flag], run, capture=True)[1].rstrip("\n")


def _unsupported(run: Runner) -> int:
    """Report an unsupported platform.

    Parameters:
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        int: Exit status 1.
    """
    sys.stderr.write(
        "install_gh_linux.sh supports only linux/x86_64 and linux/aarch64, "
        f"got {_uname('-s', run)}/{_uname('-m', run)}\n"
    )
    return 1


def _install(install_dir: str, asset: tuple[str, str], run: Runner) -> int:
    """Download, verify and extract the pinned tarball, then check the installed binary.

    Parameters:
        install_dir (str): Directory that receives `bin/gh`.
        asset (tuple[str, str]): Asset architecture and its pinned sha256.
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        int: 0 on success, 1 on a digest or version mismatch, else the failing tool's status.
    """
    asset_arch, sha256 = asset
    archive = f"gh_{GH_VERSION}_linux_{asset_arch}.tar.gz"
    Path(install_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        tarball = Path(scratch) / archive
        url = f"https://github.com/cli/cli/releases/download/v{GH_VERSION}/{archive}"
        curl = ["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3"]
        status = run_command([*curl, "--output", str(tarball), url], run)[0]
        if (
            not status
            and run_command(["sha256sum", "--check", "--status"], run, stdin=f"{sha256}  {tarball}\n")[0]
        ):
            sys.stderr.write(f"gh {GH_VERSION} sha256 mismatch for {archive}; refusing to install\n")
            return 1
        if not status:
            extract = ["tar", "--extract", "--gzip", "--file", str(tarball), "--directory", install_dir]
            status = run_command([*extract, "--strip-components=1"], run)[0]
    if status:
        return status
    gh = f"{install_dir}/bin/gh"
    reported = run_command([gh, "--version"], run, capture=True)[1].split("\n", 1)[0].split(" ")
    if reported[2:3] != [GH_VERSION]:
        return 1
    status = run_command([gh, "attestation", "verify", "--help"], run, capture=True)[0]
    if not status:
        sys.stdout.write(f"Installed gh {GH_VERSION} at {gh}\n")
    return status


def main(argv: Sequence[str], run: Runner = subprocess.run) -> int:
    """Install the pinned `gh`, failing closed on any mismatch.

    Parameters:
        argv (Sequence[str]): Arguments after the program name; exactly one install directory.
        run (Runner): `subprocess.run`-compatible callable, injected by tests.

    Returns:
        int: Process exit status. 2 for usage, 1 for a refused platform, digest or version, else the
            failing tool's status. SIGTERM (e.g. from `timeout`) exits 143 after removing the scratch dir.
    """
    signal.signal(signal.SIGTERM, terminate)
    if len(argv) != 1 or not argv[0]:
        sys.stderr.write("usage: install_gh_linux.sh <install-dir>\n")
        return 2
    if _uname("-s", run) != "Linux" or (asset := ASSETS.get(_uname("-m", run))) is None:
        return _unsupported(run)
    return _install(argv[0], asset, run)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
