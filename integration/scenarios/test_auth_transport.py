"""The assembled auth/router stack dispatches native OAuth only to a recording loopback server.

References:
- https://github.com/nredd/pi-claude-auth
- https://datatracker.ietf.org/doc/html/rfc6749#section-6
"""

from __future__ import annotations

import json
import re
import shutil
from typing import TYPE_CHECKING, Any

import pytest

from harness.anthropic_mock import (
    REPLY_TEXT,
    AnthropicMock,
    anthropic_env,
    install_recording_shims,
    shim_calls,
)
from harness.headless import RunResult, run_headless

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack
MODEL = "anthropic/claude-haiku-4-5"
FUTURE = 4_102_444_800_000
ACCESS = "sk-ant-oat01-harness-access"
PLANTED = "sk-ant-oat01-PLANTED"
UNRELATED = {"openrouter": {"type": "api_key", "key": "unrelated-preserve-me"}}
USER_AGENT = re.compile(r"^claude-cli/\S+ \(external, [^)]+\)$")
BILLING = "x-anthropic-billing-header"


def oauth(access: str = ACCESS, expires: int = FUTURE) -> dict[str, Any]:
    """Construct fake native OAuth, never a real credential.

    Parameters:
        access (str): fake access token.
        expires (int): milliseconds.

    Returns:
        dict[str, Any]: auth entry.
    """
    return {"type": "oauth", "access": access, "refresh": "sk-ant-ort01-old", "expires": expires}


def write_auth(directory: Path, value: dict[str, Any]) -> None:
    """Write fake credentials with private permissions.

    Parameters:
        directory (Path): sandbox agent directory.
        value (dict[str, Any]): complete credentials object.
    """
    path = directory / "auth.json"
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def read_auth(directory: Path) -> dict[str, Any]:
    """Read only explicit sandbox credentials.

    Parameters:
        directory (Path): sandbox agent root.

    Returns:
        dict[str, Any]: auth contents.
    """
    return json.loads((directory / "auth.json").read_text())


@pytest.fixture
def mock(sandbox: Sandbox) -> Iterator[AnthropicMock]:
    """Plant forbidden fallback credentials and record forbidden commands.

    Parameters:
        sandbox (Sandbox): isolated HOME.

    Yields:
        AnthropicMock: loopback server.
    """
    install_recording_shims(sandbox)
    planted = sandbox.home / ".claude/.credentials.json"
    planted.parent.mkdir()
    planted.write_text(json.dumps({"claudeAiOauth": {"accessToken": PLANTED, "expiresAt": FUTURE}}))
    with AnthropicMock() as server:
        yield server
    assert shim_calls(sandbox) == []
    assert PLANTED not in json.dumps(read_auth(sandbox.agent_dir))


def run(box: Sandbox, mock: AnthropicMock, model: str = MODEL, agent: Path | None = None) -> RunResult:
    """Exercise the real native provider behind the redirect/egress guard.

    Parameters:
        box (Sandbox): explicit package set.
        mock (AnthropicMock): recording server.
        model (str): selected physical, router or custom model.
        agent (Path | None): nondefault auth persistence directory.

    Returns:
        RunResult: CLI events and streams.
    """
    return run_headless(
        box,
        {},
        ["hi"],
        model=model,
        load_faux=False,
        extra_args=["--thinking", "off", "--no-approve"],
        env=anthropic_env(mock, box) | ({"PI_CODING_AGENT_DIR": str(agent)} if agent else {}),
        timeout_s=90,
    )


def answered(result: RunResult, mock: AnthropicMock) -> None:
    """Require one physical request and its successful CLI reply.

    Parameters:
        result (RunResult): process result.
        mock (AnthropicMock): wire recorder.
    """
    assert result.returncode == 0, result.transcript()
    assert result.assistant_texts() == [REPLY_TEXT], result.transcript()
    assert len(mock.messages) == 1
    assert not result.stderr.strip(), result.stderr


@pytest.mark.parametrize("kind", ["direct", "router", "api-key", "custom"])
def test_request_uses_auth_json_token_with_claude_code_headers(
    sandbox: Sandbox, mock: AnthropicMock, kind: str
) -> None:
    """OAuth mutates direct/routed transport, never API-key or custom providers; Claude auth is ignored."""
    write_auth(sandbox.agent_dir, {"anthropic": oauth()})
    model = "router/default" if kind == "router" else MODEL
    if kind == "api-key":
        write_auth(sandbox.agent_dir, {"anthropic": {"type": "api_key", "key": "fake-api-key"}})
    if kind == "custom":
        sandbox.patch_json(
            "models.json",
            {
                "providers": {
                    "custom": {
                        "baseUrl": mock.url,
                        "api": "anthropic-messages",
                        "apiKey": "fake-custom-key",
                        "models": [{"id": "custom-model", "name": "Custom"}],
                    }
                }
            },
        )
        model = "custom/custom-model"
    result = run(sandbox, mock, model)
    answered(result, mock)
    request = mock.messages[0]
    assert mock.tokens == []
    if kind in {"direct", "router"}:
        assert request.headers["authorization"] == f"Bearer {ACCESS}"
        assert USER_AGENT.fullmatch(request.headers["user-agent"])
        assert isinstance(request.body, dict)
        assert request.body["system"][0]["text"].startswith(BILLING)
    else:
        assert "authorization" not in request.headers
        assert request.headers["x-api-key"] == ("fake-api-key" if kind == "api-key" else "fake-custom-key")
        assert BILLING not in json.dumps(request.body)


def test_expired_token_refreshes_natively_and_persists(sandbox: Sandbox, mock: AnthropicMock) -> None:
    """Only a custom agent directory changes on refresh; unrelated provider/default sentinels survive."""
    default = (sandbox.agent_dir / "auth.json").read_bytes()
    custom = sandbox.root / "custom-agent"
    shutil.copytree(sandbox.agent_dir, custom)
    write_auth(custom, {"anthropic": oauth("sk-ant-oat01-stale", 1)} | UNRELATED)
    mock.queue_token(
        200, {"access_token": "sk-ant-oat01-fresh", "refresh_token": "sk-ant-ort01-new", "expires_in": 36000}
    )
    answered(run(sandbox, mock, agent=custom), mock)
    assert len(mock.tokens) == 1
    assert "sk-ant-ort01-old" in json.dumps(mock.tokens[0].body)
    saved = read_auth(custom)
    assert saved["anthropic"]["access"] == "sk-ant-oat01-fresh"
    assert saved["anthropic"]["refresh"] == "sk-ant-ort01-new"
    assert saved["anthropic"]["expires"] > 1
    assert saved["openrouter"] == UNRELATED["openrouter"]
    assert mock.messages[0].headers["authorization"] == "Bearer sk-ant-oat01-fresh"
    assert (sandbox.agent_dir / "auth.json").read_bytes() == default


@pytest.mark.parametrize("kind", ["refresh-refusal", "logout-relogin"])
def test_refresh_failure_sends_nothing_and_keeps_credentials(
    sandbox: Sandbox, mock: AnthropicMock, kind: str
) -> None:
    """Refused refresh preserves credentials; logout stays absent and explicit relogin works next launch."""
    original = (
        {"anthropic": oauth("sk-ant-oat01-stale", 1)} | UNRELATED if kind == "refresh-refusal" else UNRELATED
    )
    write_auth(sandbox.agent_dir, original)
    mock.queue_token(400, {"error": "invalid_grant"})
    refused = run(sandbox, mock)
    assert REPLY_TEXT not in refused.assistant_texts()
    assert mock.messages == []
    assert read_auth(sandbox.agent_dir) == original
    if kind == "refresh-refusal":
        assert mock.tokens
    else:
        assert mock.tokens == []
        write_auth(sandbox.agent_dir, {"anthropic": oauth()} | UNRELATED)
        answered(run(sandbox, mock), mock)
        assert mock.messages[0].headers["authorization"] == f"Bearer {ACCESS}"
