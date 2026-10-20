"""Standalone exclusions are explicit collection skips, never dispatched auth calls.

References:
- https://github.com/nredd/pi-harness/issues/14
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from conftest import pytest_collection_modifyitems

INTEGRATION = Path(__file__).resolve().parents[1]
# Exactly the auth cases that need the Node preload; everything else in the file runs on both runtimes.
STANDALONE_SKIPS = {
    "test_request_uses_auth_json_token_with_claude_code_headers[direct]",
    "test_request_uses_auth_json_token_with_claude_code_headers[router]",
    "test_request_uses_auth_json_token_with_claude_code_headers[api-key]",
    "test_request_uses_auth_json_token_with_claude_code_headers[custom]",
    "test_expired_token_refreshes_natively_and_persists",
    "test_refresh_failure_sends_nothing_and_keeps_credentials[refresh-refusal]",
    "test_refresh_failure_sends_nothing_and_keeps_credentials[logout-relogin]",
}
RECORDER = """
def pytest_collection_finish(session):
    for item in session.items:
        state = "SKIP" if item.get_closest_marker("skip") else "RUN"
        print("ITEM", item.nodeid.split("::", 1)[1], state)
"""


@pytest.mark.parametrize("runtime", ["node", "bun-standalone"])
def test_only_node_preload_cases_skip_on_standalone(runtime: str) -> None:
    """Keep portable boundaries and the missing-preload refusal active on either runtime.

    Parameters:
        runtime (str): declared binary runtime.
    """
    cfg = Mock(spec=pytest.Config)
    cfg.getoption.return_value = runtime
    auth = Mock(spec=pytest.Item)
    portable = Mock(spec=pytest.Item)
    auth.get_closest_marker.side_effect = lambda name: name == "node_preload"
    portable.get_closest_marker.return_value = None

    pytest_collection_modifyitems(cfg, [auth, portable])

    portable.add_marker.assert_not_called()
    if runtime == "node":
        auth.add_marker.assert_not_called()
        return
    auth.add_marker.assert_called_once()
    marker = auth.add_marker.call_args.args[0]
    assert marker.name == "skip"
    assert "NODE_OPTIONS --import" in marker.kwargs["reason"]
    assert "#14" in marker.kwargs["reason"]


@pytest.mark.parametrize("runtime", ["node", "bun-standalone"])
def test_real_auth_scenarios_collect_exact_skips(runtime: str, tmp_path: Path) -> None:
    """Collect the real auth scenario file: a dropped or misplaced marker changes this set.

    Collection only imports and marks the scenarios; no Pi binary or provider is started.

    Parameters:
        runtime (str): declared binary runtime.
        tmp_path (Path): holds the collection-recording plugin.
    """
    (tmp_path / "record_skips.py").write_text(RECORDER)
    done = subprocess.run(
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
        env={**os.environ, "PYTHONPATH": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    states = dict(line.split()[1:] for line in done.stdout.splitlines() if line.startswith("ITEM "))
    assert "test_request_uses_auth_json_token_with_claude_code_headers[missing-preload]" in states
    skipped = {name for name, state in states.items() if state == "SKIP"}
    assert skipped == (STANDALONE_SKIPS if runtime == "bun-standalone" else set())
