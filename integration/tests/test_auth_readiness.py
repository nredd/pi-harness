"""Loopback readiness plumbing and per-launch nonce isolation; no Pi process or credentials.

References:
- https://docs.python.org/3/library/urllib.request.html
- https://github.com/nredd/pi-harness/blob/main/integration/providers/auth_guard.mjs
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from urllib.error import HTTPError
from urllib.request import urlopen

import pytest

from harness.anthropic_mock import AnthropicMock, anthropic_env
from harness.sandbox import build_sandbox

if TYPE_CHECKING:
    from pathlib import Path


def test_loopback_readiness_is_not_a_provider_or_token_request() -> None:
    """Keep nonce echoes separate from recorded provider/token traffic and reject malformed probes."""
    with AnthropicMock() as mock:
        with urlopen(mock.url + "/__harness_ready__?nonce=unit", timeout=5) as response:
            assert json.loads(response.read()) == {"nonce": "unit"}
        assert mock.messages == []
        assert mock.tokens == []
        with pytest.raises(HTTPError, match="404"):
            urlopen(mock.url + "/__harness_ready__", timeout=5)
        with pytest.raises(HTTPError, match="404"):
            urlopen(mock.url + "/not-a-readiness-path?nonce=unit", timeout=5)


def test_each_auth_launch_requires_a_fresh_preload_nonce(tmp_path: Path) -> None:
    """Bind each auth launch to a unique preload identity in its private environment.

    Parameters:
        tmp_path (Path): private sandbox root.
    """
    box = build_sandbox(tmp_path / "box")
    with AnthropicMock() as mock:
        first, second = anthropic_env(mock, box), anthropic_env(mock, box)
        assert first["HARNESS_ANTHROPIC_MOCK"] == mock.url
        assert first["HARNESS_AUTH_NONCE"] != second["HARNESS_AUTH_NONCE"]
        assert "--import" in first["NODE_OPTIONS"]
        assert "redirect_anthropic.mjs" in first["NODE_OPTIONS"]
        assert box.env(first)["HARNESS_AUTH_NONCE"] == first["HARNESS_AUTH_NONCE"]
