"""Assembled direct/routed child compaction against the built candidate core.

References:
    https://github.com/nredd/pi-harness/issues/1020
    https://github.com/nredd/pi-harness/issues/751
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from harness.sandbox import build_sandbox

ROOT = Path(__file__).resolve().parents[3]


def test_candidate_core_child_compaction(tmp_path: Path) -> None:
    """Run both real child-session probes with private HOME/auth/tmp and no inherited credentials.

    Parameters:
        tmp_path (Path): Private scenario directory.
    """
    node = shutil.which("node")
    assert node is not None, "Candidate compaction requires Node on PATH"
    resolver = ROOT / "forks/pi/packages/coding-agent/src/experimental/source-resolver.ts"
    assert resolver.is_file(), "Initialize and build the candidate `forks/pi` before running this scenario"
    assert (ROOT / "forks/pi/packages/coding-agent/dist/index.js").is_file(), "Build the candidate core first"
    assert (ROOT / "packages/subagents/dist/index.ts").is_file(), "Run `make build` before child probes"
    box = build_sandbox(tmp_path / "candidate")
    result = subprocess.run(
        [
            node,
            "--import",
            str(resolver),
            "--test",
            "--test-concurrency=1",
            "--test-timeout=120000",
            str(ROOT / "tests/integration/probes/compaction-children.test.ts"),
        ],
        cwd=ROOT,
        env=box.env(
            {
                "USERPROFILE": str(box.home),
                "PI_NO_LOCAL_LLM": "1",
                "JITI_FS_CACHE": "false",
                "AWS_EC2_METADATA_DISABLED": "true",
                "GIT_TERMINAL_PROMPT": "0",
            }
        ),
        capture_output=True,
        text=True,
        timeout=250,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
