"""No auth scenario is skipped on either runtime: Bun standalone loads the hook via `BUN_OPTIONS`.

References:
- https://github.com/nredd/pi-harness/issues/14
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

import pytest

INTEGRATION = Path(__file__).resolve().parents[1]
RECORDER = dedent(
    """
    import pytest


    def pytest_collection_finish(session: pytest.Session) -> None:
        '''Print each collected scenario's id and whether collection marked it skipped.

        Parameters:
            session (pytest.Session): finished collection.
        '''
        for item in session.items:
            state = "SKIP" if item.get_closest_marker("skip") else "RUN"
            print("ITEM", item.nodeid.split("::", 1)[1], state)
    """
)


@pytest.mark.parametrize("runtime", ["node", "bun-standalone"])
def test_real_auth_scenarios_collect_without_skips(runtime: str, tmp_path: Path) -> None:
    """Collect the real auth scenario file: a reintroduced skip marker changes this set.

    Collection only imports and marks the scenarios; no Pi binary or provider is started.

    Parameters:
        runtime (str): declared binary runtime.
        tmp_path (Path): holds the collection-recording plugin.
    """
    (tmp_path / "record_skips.py").write_text(RECORDER)
    output = subprocess.check_output(
        [
            sys.executable,
            "-m",
            "pytest",
            "scenarios/test_auth_transport.py",
            "--co",
            "-q",
            "-p",
            "record_skips",
            "-p",
            "no:cacheprovider",
            "--runtime",
            runtime,
        ],
        cwd=INTEGRATION,
        env=os.environ | {"PYTHONPATH": str(tmp_path)},
        text=True,
        stderr=subprocess.STDOUT,
        timeout=120,
    )
    states = dict(line.split()[1:] for line in output.splitlines() if line.startswith("ITEM "))
    assert "test_request_uses_auth_json_token_with_claude_code_headers[missing-preload]" in states
    # Four shaping kinds, missing-preload, one refresh and two refresh-failure cases.
    assert len(states) == 8
    assert set(states.values()) == {"RUN"}
