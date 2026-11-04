"""Loopback readiness plumbing and per-launch nonce isolation; no Pi process or credentials.

References:
- https://docs.python.org/3/library/urllib.request.html
- https://github.com/nredd/pi-harness/blob/main/integration/providers/auth_guard.mjs
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from harness.anthropic_mock import (
    RECORDING_SHIMS,
    AnthropicMock,
    anthropic_env,
    expected_billing_version,
    install_recording_shims,
    shim_calls,
)
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
        assert first["BUN_OPTIONS"].startswith("--preload ")
        assert "redirect_anthropic.mjs" in first["BUN_OPTIONS"]
        assert box.env(first)["HARNESS_AUTH_NONCE"] == first["HARNESS_AUTH_NONCE"]


def post(url: str, body: bytes, content_type: str) -> tuple[int, dict[str, Any]]:
    """POST to the mock and return its status and JSON body, error statuses included.

    Parameters:
        url (str): full request URL.
        body (bytes): request body.
        content_type (str): `content-type` header.

    Returns:
        tuple[int, dict[str, Any]]: HTTP status and decoded reply.
    """
    request = Request(url, data=body, headers={"content-type": content_type}, method="POST")
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        with error:
            return error.code, json.loads(error.read())


def test_mock_url_refuses_before_start_and_after_stop() -> None:
    """The base URL exists only while the server is serving."""
    mock = AnthropicMock()
    with pytest.raises(RuntimeError, match="not started"):
        _ = mock.url
    with mock:
        assert mock.url.startswith("http://127.0.0.1:")
    with pytest.raises(RuntimeError, match="not started"):
        _ = mock.url


def test_token_replies_are_scripted_in_order_then_refused() -> None:
    """Queued token replies are consumed FIFO, an unscripted refresh is a 500, every request is recorded."""
    with AnthropicMock() as mock:
        mock.queue_token(200, {"access_token": "fake-access", "expires_in": 3600})
        mock.queue_token(400, {"error": "invalid_grant"})
        form = b"grant_type=refresh_token&refresh_token=fake-refresh"
        assert post(mock.url + "/v1/oauth/token", form, "application/x-www-form-urlencoded") == (
            200,
            {"access_token": "fake-access", "expires_in": 3600},
        )
        assert post(mock.url + "/v1/oauth/token", b'{"grant_type": "refresh_token"}', "application/json") == (
            400,
            {"error": "invalid_grant"},
        )
        assert post(mock.url + "/v1/oauth/token?beta=1", b"not json", "text/plain") == (
            500,
            {"error": "unscripted"},
        )
        assert [(token.path, token.body) for token in mock.tokens] == [
            ("/v1/oauth/token", {"grant_type": "refresh_token", "refresh_token": "fake-refresh"}),
            ("/v1/oauth/token", {"grant_type": "refresh_token"}),
            ("/v1/oauth/token?beta=1", "not json"),
        ]
        assert mock.tokens[0].headers["content-type"] == "application/x-www-form-urlencoded"
        assert mock.token_replies == []
        assert mock.messages == []


def test_message_status_answers_with_an_authentication_error() -> None:
    """A non-200 `message_status` records the call and replies with an Anthropic error body."""
    with AnthropicMock(message_status=401) as mock:
        body = b'{"model": "claude-haiku-4-5", "messages": []}'
        assert post(mock.url + "/v1/messages", body, "application/json") == (
            401,
            {"type": "error", "error": {"type": "authentication_error"}},
        )
        assert [(m.path, m.body) for m in mock.messages] == [
            ("/v1/messages", {"model": "claude-haiku-4-5", "messages": []})
        ]
        assert mock.tokens == []


def test_unscripted_post_path_is_not_found_and_unrecorded() -> None:
    """Only the token and messages endpoints are served."""
    with AnthropicMock() as mock:
        assert post(mock.url + "/v1/complete", b"{}", "application/json") == (
            404,
            {"error": "unscripted path /v1/complete"},
        )
        assert mock.messages == mock.tokens == []


def test_recording_shims_log_argv_and_fail(tmp_path: Path) -> None:
    """Each shim on the sandbox PATH records its argv and exits 1, so a reach for it fails loudly.

    Parameters:
        tmp_path (Path): private sandbox root.
    """
    box = build_sandbox(tmp_path / "box")
    install_recording_shims(box)
    assert shim_calls(box) == []
    for name in RECORDING_SHIMS:
        assert (box.shims_dir / name).stat().st_mode & 0o111
    env = box.env()
    claude = subprocess.run(["claude", "-p", "hi there"], env=env, cwd=box.workdir, check=False)
    security = subprocess.run(
        ["security", "find-generic-password", "-s", "Claude Code"], env=env, cwd=box.workdir, check=False
    )
    assert (claude.returncode, security.returncode) == (1, 1)
    assert shim_calls(box) == ["claude -p hi there", "security find-generic-password -s Claude Code"]
