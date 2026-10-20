"""Standalone exclusions are explicit collection skips, never dispatched auth calls.

References:
- https://github.com/nredd/pi-harness/issues/14
"""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from conftest import pytest_collection_modifyitems


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
