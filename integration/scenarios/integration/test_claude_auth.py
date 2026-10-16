"""Anthropic subscription auth runs on pi's NATIVE OAuth; `pi-claude-auth` only adds headers.

The real native Anthropic provider and OAuth refresh run against `harness/anthropic_mock.py`, with
fake credentials only. `providers/redirect_anthropic.mjs` points pi's `fetch` at the mock, so the
tests record exactly what was sent. The package under test is whatever the sandbox resolves for
`npm:pi-claude-auth`: the installed one, or the fork via `HARNESS_LOCAL=pi-claude-auth`.

Version 0.1.3 read Claude Code's keychain and `~/.claude/.credentials.json`, rewrote `auth.json`
from them, owned the OAuth refresh and fell back to the `claude` CLI. Every test below fails on
it for one of those reasons.
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
    RecordedRequest,
    anthropic_env,
    install_recording_shims,
    shim_calls,
)
from harness.headless import RunResult, run_headless

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

MODEL = "anthropic/claude-haiku-4-5"
FAR_FUTURE_MS = 4_102_444_800_000
EXPIRED_MS = 1
USER_AGENT = re.compile(r"^claude-cli/\S+ \(external, [^)]+\)$")
BILLING_PREFIX = "x-anthropic-billing-header"
PLANTED_CLAUDE_TOKEN = "sk-ant-oat01-PLANTED-IN-DOT-CLAUDE"


def oauth(access: str, refresh: str, expires: int = FAR_FUTURE_MS) -> dict[str, Any]:
    """Build a pi `auth.json` OAuth entry with fake tokens.

    Parameters:
        access (str): access token; must contain `sk-ant-oat` for pi's OAuth mode.
        refresh (str): refresh token.
        expires (int): epoch milliseconds.

    Returns:
        dict[str, Any]: the entry.
    """
    return {"type": "oauth", "access": access, "refresh": refresh, "expires": expires}


UNRELATED = {
    "openai-codex": {
        "type": "oauth",
        "access": "codex-access",
        "refresh": "codex-refresh",
        "expires": FAR_FUTURE_MS,
        "accountId": "harness",
    },
    "openrouter": {"type": "api_key", "key": "sk-or-harness"},
}


def write_auth(agent_dir: Path, auth: dict[str, Any]) -> None:
    """Replace a sandbox `auth.json`.

    Parameters:
        agent_dir (Path): agent dir holding the file.
        auth (dict[str, Any]): full contents.
    """
    path = agent_dir / "auth.json"
    path.write_text(json.dumps(auth, indent=2))
    path.chmod(0o600)


def read_auth(agent_dir: Path) -> dict[str, Any]:
    """Read a sandbox `auth.json`.

    Parameters:
        agent_dir (Path): agent dir holding the file.

    Returns:
        dict[str, Any]: parsed contents.
    """
    return json.loads((agent_dir / "auth.json").read_text())


@pytest.fixture
def mock() -> Iterator[AnthropicMock]:
    """Serve the Anthropic mock for one test.

    Yields:
        AnthropicMock: running server.
    """
    with AnthropicMock() as server:
        yield server


@pytest.fixture
def box(sandbox: Sandbox) -> Sandbox:
    """Return a sandbox whose `claude` and `security` commands record their use.

    Parameters:
        sandbox (Sandbox): fresh sandbox.

    Returns:
        Sandbox: the same sandbox.
    """
    install_recording_shims(sandbox)
    return sandbox


def run_pi(
    box: Sandbox, mock: AnthropicMock, *, model: str = MODEL, env: dict[str, str] | None = None
) -> RunResult:
    """Run one prompt on the real native Anthropic provider through the mock.

    Parameters:
        box (Sandbox): sandbox to run in.
        mock (AnthropicMock): running server.
        model (str): `provider/id` to select.
        env (dict[str, str] | None): extra environment, e.g. a custom `PI_CODING_AGENT_DIR`.

    Returns:
        RunResult: parsed outcome; a failed run is returned, not raised.
    """
    return run_headless(
        box,
        {"providers": {}},
        ["hi"],
        model=model,
        extra_args=["--thinking", "off"],
        env=anthropic_env(mock, box) | (env or {}),
        load_faux=False,
        timeout_s=120,
    )


def assert_answered(result: RunResult, mock: AnthropicMock) -> None:
    """Assert the run reached the mock once and the reply came back.

    Parameters:
        result (RunResult): the run.
        mock (AnthropicMock): server that answered.
    """
    assert result.returncode == 0, result.transcript()
    assert REPLY_TEXT in result.assistant_texts(), result.transcript()
    assert len(mock.messages) == 1, [request.headers for request in mock.messages]


def assert_no_claude_code_access(box: Sandbox, result: RunResult) -> None:
    """Assert nothing consulted Claude Code's keychain, CLI or credential file.

    Parameters:
        box (Sandbox): sandbox the run used.
        result (RunResult): the run.
    """
    assert shim_calls(box) == [], shim_calls(box)
    assert "pi-claude-auth" not in result.stderr, result.stderr
    assert "Claude Code credentials" not in result.stderr, result.stderr


def bearer(request_headers: dict[str, str]) -> str:
    """Return the bearer token of a recorded request.

    Parameters:
        request_headers (dict[str, str]): lower-cased headers.

    Returns:
        str: token, empty when there is no bearer authorization.
    """
    return request_headers.get("authorization", "").removeprefix("Bearer ")


def test_request_uses_auth_json_token_with_claude_code_headers(box: Sandbox, mock: AnthropicMock) -> None:
    """The token comes from `auth.json`; the package adds the full user-agent and billing block."""
    write_auth(
        box.agent_dir, {"anthropic": oauth("sk-ant-oat01-harness-access", "sk-ant-ort01-harness-refresh")}
    )

    result = run_pi(box, mock)

    assert_answered(result, mock)
    request = mock.messages[0]
    assert bearer(request.headers) == "sk-ant-oat01-harness-access"
    assert USER_AGENT.match(request.headers["user-agent"]), request.headers["user-agent"]
    assert isinstance(request.body, dict)
    system = request.body["system"]
    assert system[0]["text"].startswith(BILLING_PREFIX), system
    assert mock.tokens == []
    assert_no_claude_code_access(box, result)
    assert read_auth(box.agent_dir)["anthropic"]["access"] == "sk-ant-oat01-harness-access"


def test_claude_code_credentials_are_never_read(box: Sandbox, mock: AnthropicMock) -> None:
    """A planted `~/.claude/.credentials.json` is ignored: not used, not synced into `auth.json`."""
    write_auth(
        box.agent_dir, {"anthropic": oauth("sk-ant-oat01-harness-access", "sk-ant-ort01-harness-refresh")}
    )
    planted = box.home / ".claude" / ".credentials.json"
    planted.parent.mkdir()
    planted.write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": PLANTED_CLAUDE_TOKEN,
                    "refreshToken": "sk-ant-ort01-PLANTED",
                    "expiresAt": FAR_FUTURE_MS,
                }
            }
        )
    )

    result = run_pi(box, mock)

    assert_answered(result, mock)
    assert bearer(mock.messages[0].headers) == "sk-ant-oat01-harness-access"
    assert PLANTED_CLAUDE_TOKEN not in json.dumps(read_auth(box.agent_dir))
    assert_no_claude_code_access(box, result)


def test_expired_token_refreshes_natively_and_persists(box: Sandbox, mock: AnthropicMock) -> None:
    """pi's own refresh grant runs, the new pair is used and written back to `auth.json`."""
    write_auth(box.agent_dir, {"anthropic": oauth("sk-ant-oat01-stale", "sk-ant-ort01-old", EXPIRED_MS)})
    mock.queue_token(
        200, {"access_token": "sk-ant-oat01-fresh", "refresh_token": "sk-ant-ort01-new", "expires_in": 36_000}
    )

    result = run_pi(box, mock)

    assert_answered(result, mock)
    assert len(mock.tokens) == 1, mock.tokens
    grant = mock.tokens[0].body
    assert "sk-ant-ort01-old" in json.dumps(grant)
    assert "refresh_token" in json.dumps(grant)
    assert bearer(mock.messages[0].headers) == "sk-ant-oat01-fresh"
    saved = read_auth(box.agent_dir)["anthropic"]
    assert (saved["access"], saved["refresh"]) == ("sk-ant-oat01-fresh", "sk-ant-ort01-new")
    assert saved["expires"] > EXPIRED_MS
    assert_no_claude_code_access(box, result)


def test_refresh_failure_sends_nothing_and_keeps_credentials(box: Sandbox, mock: AnthropicMock) -> None:
    """A rejected refresh sends no stale-token request, never falls back to `claude`, loses nothing."""
    original = oauth("sk-ant-oat01-stale", "sk-ant-ort01-old", EXPIRED_MS)
    write_auth(box.agent_dir, {"anthropic": original})
    mock.queue_token(400, {"error": "invalid_grant"})

    result = run_pi(box, mock)

    assert REPLY_TEXT not in result.assistant_texts(), result.transcript()
    assert mock.messages == [], [request.headers for request in mock.messages]
    assert mock.tokens, "the refresh was never attempted"
    assert read_auth(box.agent_dir)["anthropic"] == original
    assert shim_calls(box) == [], shim_calls(box)


def test_unrelated_credentials_survive_a_refresh(box: Sandbox, mock: AnthropicMock) -> None:
    """Only the `anthropic` entry changes; every other provider's credentials keep equal values."""
    write_auth(
        box.agent_dir,
        {"anthropic": oauth("sk-ant-oat01-stale", "sk-ant-ort01-old", EXPIRED_MS), **UNRELATED},
    )
    mock.queue_token(
        200, {"access_token": "sk-ant-oat01-fresh", "refresh_token": "sk-ant-ort01-new", "expires_in": 36_000}
    )

    result = run_pi(box, mock)

    assert_answered(result, mock)
    saved = read_auth(box.agent_dir)
    assert {name: saved[name] for name in UNRELATED} == UNRELATED
    assert saved["anthropic"]["access"] == "sk-ant-oat01-fresh"


def test_logout_stays_logged_out_and_relogin_is_picked_up(box: Sandbox, mock: AnthropicMock) -> None:
    """With no `anthropic` entry nothing resurrects one (not even from `.claude`); a new login works."""
    write_auth(box.agent_dir, dict(UNRELATED))
    planted = box.home / ".claude" / ".credentials.json"
    planted.parent.mkdir()
    planted.write_text(
        json.dumps({"claudeAiOauth": {"accessToken": PLANTED_CLAUDE_TOKEN, "expiresAt": FAR_FUTURE_MS}})
    )

    logged_out = run_pi(box, mock)

    assert REPLY_TEXT not in logged_out.assistant_texts(), logged_out.transcript()
    assert mock.messages == [], [request.headers for request in mock.messages]
    assert "anthropic" not in read_auth(box.agent_dir), read_auth(box.agent_dir)
    assert_no_claude_code_access(box, logged_out)

    write_auth(
        box.agent_dir, {"anthropic": oauth("sk-ant-oat01-relogin", "sk-ant-ort01-relogin"), **UNRELATED}
    )
    relogged = run_pi(box, mock)

    assert_answered(relogged, mock)
    assert bearer(mock.messages[0].headers) == "sk-ant-oat01-relogin"


def test_custom_agent_dir_is_the_only_one_touched(box: Sandbox, mock: AnthropicMock) -> None:
    """With `PI_CODING_AGENT_DIR` elsewhere, the refresh lands there and the default dir is untouched."""
    default_auth = read_auth(box.agent_dir)
    custom = box.root / "custom-agent"
    shutil.copytree(box.agent_dir, custom, symlinks=True)
    write_auth(custom, {"anthropic": oauth("sk-ant-oat01-stale", "sk-ant-ort01-old", EXPIRED_MS)})
    mock.queue_token(
        200, {"access_token": "sk-ant-oat01-fresh", "refresh_token": "sk-ant-ort01-new", "expires_in": 36_000}
    )

    result = run_pi(box, mock, env={"PI_CODING_AGENT_DIR": str(custom)})

    assert_answered(result, mock)
    assert read_auth(custom)["anthropic"]["access"] == "sk-ant-oat01-fresh"
    assert read_auth(box.agent_dir) == default_auth
    assert not (box.agent_dir / "claude-account-source.txt").exists()


def test_router_routed_anthropic_requests_get_the_same_headers(box: Sandbox, mock: AnthropicMock) -> None:
    """`router/default` resolves to a physical Anthropic model; its request keeps the headers and block.

    Guards the hook scoping: `ctx.model` is the SELECTED (virtual) `router/default`, not the
    physical model, so scoping on `ctx.model.provider` would silently drop them here.
    """
    if not any("pi-subscription-router" in str(package) for package in box.settings().get("packages", [])):
        pytest.skip("`pi-subscription-router` is not a configured package on this profile")
    write_auth(
        box.agent_dir, {"anthropic": oauth("sk-ant-oat01-harness-access", "sk-ant-ort01-harness-refresh")}
    )

    result = run_pi(box, mock, model="router/default")

    assert result.returncode == 0, result.transcript()
    assert mock.messages, result.transcript()
    request = mock.messages[0]
    assert bearer(request.headers) == "sk-ant-oat01-harness-access"
    assert USER_AGENT.match(request.headers["user-agent"]), request.headers["user-agent"]
    assert isinstance(request.body, dict)
    assert request.body["system"][0]["text"].startswith(BILLING_PREFIX), request.body["system"]


def assert_untouched_request(request: RecordedRequest) -> None:
    """Assert a non-OAuth request carries no bearer token and no Claude Code billing block.

    Parameters:
        request (RecordedRequest): the recorded `/v1/messages` call.
    """
    assert "authorization" not in request.headers, request.headers
    assert isinstance(request.body, dict)
    assert BILLING_PREFIX not in json.dumps(request.body.get("system", "")), request.body.get("system")


def test_api_key_request_has_no_billing_block(box: Sandbox, mock: AnthropicMock) -> None:
    """A native API-key Anthropic request is left alone: `x-api-key`, no bearer, no billing block."""
    write_auth(box.agent_dir, {"anthropic": {"type": "api_key", "key": "sk-ant-api03-harness"}})

    result = run_pi(box, mock)

    assert_answered(result, mock)
    assert mock.messages[0].headers["x-api-key"] == "sk-ant-api03-harness"
    assert_untouched_request(mock.messages[0])
    assert_no_claude_code_access(box, result)


def test_enterprise_anthropic_provider_has_no_billing_block(box: Sandbox, mock: AnthropicMock) -> None:
    """A custom `anthropic-messages` provider (fake enterprise gateway) is excluded from the billing block."""
    box.patch_json(
        "models.json",
        {
            "providers": {
                "enterprise": {
                    "baseUrl": mock.url,
                    "api": "anthropic-messages",
                    "apiKey": "enterprise-harness-key",
                    "models": [{"id": "claude-enterprise-harness", "name": "Enterprise harness"}],
                }
            }
        },
    )

    result = run_pi(box, mock, model="enterprise/claude-enterprise-harness")

    assert_answered(result, mock)
    assert_untouched_request(mock.messages[0])
    assert_no_claude_code_access(box, result)
