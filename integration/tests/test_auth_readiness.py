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

from harness.anthropic_mock import AnthropicMock, anthropic_env, expected_billing_version
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


@pytest.mark.parametrize(
    ("native", "floor", "expected"),
    [
        ("2.1.280", "2.1.280", "2.1.280"),
        ("2.1.300", "2.1.280", "2.1.300"),
        ("2.1.251", "2.1.280", "2.1.280"),
        ("2.10.0", "2.9.999", "2.10.0"),
    ],
)
def test_billing_version_uses_native_version_or_installed_floor(
    tmp_path: Path, native: str, floor: str, expected: str
) -> None:
    """Compare version components numerically, reading the floor from installed source.

    Parameters:
        tmp_path (Path): private package fixture.
        native (str): version observed in the native user agent.
        floor (str): bundled extension floor.
        expected (str): expected billing version.
    """
    source = tmp_path / "src/claude-code-version.ts"
    source.parent.mkdir()
    source.write_text(f'export const CLAUDE_CODE_VERSION = "{floor}";')
    assert expected_billing_version(f"claude-cli/{native}", tmp_path) == expected


@pytest.mark.parametrize(
    "user_agent", ["claude-cli/2.1.280 (external, sdk-cli)", "other/2.1.280", "claude-cli/2.1"]
)
def test_billing_version_refuses_non_native_user_agent(tmp_path: Path, user_agent: str) -> None:
    """Reject retired fork suffixes and malformed user agents before reading package source.

    Parameters:
        tmp_path (Path): empty package fixture.
        user_agent (str): invalid wire user agent.
    """
    with pytest.raises(ValueError, match="Unexpected native"):
        expected_billing_version(user_agent, tmp_path)


def test_billing_version_refuses_missing_installed_floor(tmp_path: Path) -> None:
    """Fail explicitly when upstream changes its bundled floor declaration.

    Parameters:
        tmp_path (Path): package fixture with a changed declaration.
    """
    source = tmp_path / "src/claude-code-version.ts"
    source.parent.mkdir()
    source.write_text('export const RENAMED_VERSION = "2.1.280";')
    with pytest.raises(ValueError, match="Missing `CLAUDE_CODE_VERSION`"):
        expected_billing_version("claude-cli/2.1.280", tmp_path)


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
