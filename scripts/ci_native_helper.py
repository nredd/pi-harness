"""Stage the Windows helper and its build evidence without installing it.

References:
- https://learn.microsoft.com/powershell/module/microsoft.powershell.management/set-content
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path

EXE_NAME = "windows-bridge.exe"
FIXTURE_STATUS = Path("native-fixture-status.txt")
EVIDENCE_FILES = (Path("native-fixture.log"), Path("native-compiler.log"), FIXTURE_STATUS)


def stage(executable: Path, artifact_dir: Path, source_sha: str) -> None:
    """Stage the executable if built and record evidence even when build steps failed.

    Parameters:
        executable (Path): Cargo's release executable.
        artifact_dir (Path): Directory read by the upload step.
        source_sha (str): Checked-out source revision to record in build.txt.

    Raises:
        ValueError: The fixture status file exists but has no content.
    """
    artifact_dir.mkdir(exist_ok=True)
    executable_status = "NOT_BUILT"
    if executable.exists():
        staged = artifact_dir / EXE_NAME
        shutil.copyfile(executable, staged)
        digest = hashlib.sha256(staged.read_bytes()).hexdigest()
        (artifact_dir / "SHA256SUMS").write_bytes(f"{digest}  {EXE_NAME}\r\n".encode("ascii"))
        executable_status = "PRESENT"

    fixture_status = "NOT_REACHED"
    if FIXTURE_STATUS.exists():
        raw_status = FIXTURE_STATUS.read_bytes().decode("utf-8-sig")
        # Get-Content -Raw returns null for an empty file, so the old step failed at .Trim().
        if not raw_status:
            msg = f"Fixture status file is empty: '{FIXTURE_STATUS}'"
            raise ValueError(msg)
        fixture_status = raw_status.strip()
    # PowerShell's embedded `n separators are LF; Set-Content on Windows appends CRLF.
    build = (
        f"source={source_sha}\n"
        "target=x86_64-pc-windows-msvc\n"
        "rust_requested=1.97.1\n"
        "protocol=4\n"
        "capability=fail-closed-live-target-v1\n"
        f"executable={executable_status}\n"
        f"fixture={fixture_status}\r\n"
    )
    (artifact_dir / "build.txt").write_bytes(build.encode("ascii", errors="replace"))
    for evidence in EVIDENCE_FILES:
        if evidence.exists():
            shutil.copyfile(evidence, artifact_dir / evidence.name)


def main() -> None:
    """Parse the workflow arguments and stage the Windows artifact."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    args = parser.parse_args()
    stage(args.executable, args.artifact_dir, args.source_sha)


if __name__ == "__main__":
    main()
