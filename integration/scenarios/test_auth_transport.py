"""The assembled auth/router stack dispatches native OAuth only to a recording loopback server.

References:
- https://github.com/gotgenes/pi-anthropic-auth/tree/v3.4.3/src
- https://github.com/gotgenes/pi-anthropic-auth/blob/v3.4.3/docs/architecture.md
- https://datatracker.ietf.org/doc/html/rfc6749#section-6
"""

from __future__ import annotations

import hashlib
import json
import shutil
from typing import TYPE_CHECKING, Any

import pytest

from harness.anthropic_mock import (
    AUTH_GUARD_EXTENSION,
    REPLY_TEXT,
    AnthropicMock,
    anthropic_env,
    expected_billing_version,
    install_recording_shims,
    shim_calls,
)
from harness.headless import RunResult, run_headless
from harness.stack import find_package

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack
MODEL = "anthropic/claude-haiku-4-5"
FUTURE = 4_102_444_800_000
ACCESS = "sk-ant-oat01-harness-access"
PLANTED = "sk-ant-oat01-PLANTED"
UNRELATED = {
    "openrouter": {"type": "api_key", "key": "unrelated-preserve-me"},
    "openai-codex": {
        "type": "oauth",
        "access": "codex-fake-access",
        "refresh": "codex-fake-refresh",
        "expires": FUTURE,
        "accountId": "harness",
    },
}
BILLING = "x-anthropic-billing-header"
PI_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness."
MINIMAL_PROMPT = (
    "You are an expert coding assistant.\n"
    "Be concise and helpful.\n"
    "Use the available tools to answer the user's request.\n"
    "Show file paths clearly when working with files."
)
PROJECT_CONTEXT = "AUTH_CONTEXT_SENTINEL: In addition to the tools above, preserve project instructions."


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


def run(
    box: Sandbox, mock: AnthropicMock, model: str = MODEL, agent: Path | None = None, *, preload: bool = True
) -> RunResult:
    """Exercise the real native provider behind the redirect/egress guard.

    Parameters:
        box (Sandbox): explicit package set.
        mock (AnthropicMock): recording server.
        model (str): selected physical, router or custom model.
        agent (Path | None): nondefault auth persistence directory.
        preload (bool): false only for the fail-closed runtime-capability branch.

    Returns:
        RunResult: CLI events and streams.
    """
    return run_headless(
        box,
        {},
        ["hi"],
        model=model,
        load_faux=False,
        extra_args=["-e", str(AUTH_GUARD_EXTENSION), "--thinking", "off", "--no-approve"],
        env=anthropic_env(mock, box)
        | ({"PI_CODING_AGENT_DIR": str(agent)} if agent else {})
        | ({} if preload else {"NODE_OPTIONS": "", "BUN_OPTIONS": ""}),
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


@pytest.mark.parametrize(
    "kind",
    [
        # These dispatch branches need proven interception before planting fake OAuth.
        *[
            pytest.param(kind, marks=pytest.mark.node_preload)
            for kind in ("direct", "router", "api-key", "custom")
        ],
        "missing-preload",  # The refusal itself is safe and must also run on Bun standalone.
    ],
)
def test_request_uses_auth_json_token_with_claude_code_headers(
    sandbox: Sandbox, mock: AnthropicMock, kind: str
) -> None:
    """OAuth mutates direct/routed transport, never API-key or custom providers; Claude auth is ignored.

    Parameters:
        sandbox (Sandbox): private stack and fake native credentials.
        mock (AnthropicMock): loopback wire recorder.
        kind (str): provider/auth path or missing-preload refusal branch.
    """
    (sandbox.workdir / "AGENTS.md").write_text(PROJECT_CONTEXT)
    write_auth(sandbox.agent_dir, {"anthropic": oauth()})
    if kind == "missing-preload":
        refused = run(sandbox, mock, preload=False)
        assert refused.returncode != 0, refused.transcript()
        assert "redirect preload is missing" in refused.stderr, refused.transcript()
        assert mock.messages == []
        assert mock.tokens == []
        return
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
    assert isinstance(request.body, dict)
    system = request.body["system"]
    user = next(message for message in request.body["messages"] if message["role"] == "user")
    assert [block["text"] for block in user["content"] if block["type"] == "text"] == ["hi"]
    system_text = "\n".join(block["text"] for block in system)
    assert PROJECT_CONTEXT in system_text
    assert "<tools>" in system_text
    assert "</tools>" in system_text
    if kind in {"direct", "router"}:
        assert request.headers["authorization"] == f"Bearer {ACCESS}"
        assert "x-api-key" not in request.headers
        package = find_package(
            "@gotgenes/pi-anthropic-auth", sandbox.settings()["packages"], sandbox.agent_dir
        )
        version = expected_billing_version(request.headers["user-agent"], package)
        assert request.headers["x-app"] == "cli"
        # billing-header.ts samples offsets 4, 7, 20 (all absent in 'hi'), then salts the version.
        suffix = hashlib.sha256(f"59cf53e54c78000{version}".encode()).hexdigest()[:3]
        cch = hashlib.sha256(b"hi").hexdigest()[:5]
        assert system[0] == {
            "type": "text",
            "text": f"{BILLING}: cc_version={version}.{suffix}; cc_entrypoint=sdk-cli; cch={cch};",
        }
        assert system[1]["text"] == "You are Claude Code, Anthropic's official CLI for Claude."
        assert MINIMAL_PROMPT in system_text
        assert PI_PREAMBLE not in system_text
        assert "<docs>" not in system_text
        # Only Pi-owned tools filler is removed, not the same phrase in project context.
        tools = system_text.split("<tools>", 1)[1].split("</tools>", 1)[0]
        assert "In addition to the tools above" not in tools
    else:
        assert "authorization" not in request.headers
        assert request.headers["x-api-key"] == ("fake-api-key" if kind == "api-key" else "fake-custom-key")
        assert BILLING not in system_text
        assert PI_PREAMBLE in system_text
        assert MINIMAL_PROMPT not in system_text
        assert "<docs>" in system_text
        assert "In addition to the tools above" in system_text.split("</tools>", 1)[0]


@pytest.mark.node_preload
def test_expired_token_refreshes_natively_and_persists(sandbox: Sandbox, mock: AnthropicMock) -> None:
    """Only a custom agent directory changes on refresh; unrelated provider/default sentinels survive.

    Parameters:
        sandbox (Sandbox): private default agent directory and installed stack.
        mock (AnthropicMock): scripted token and message server.
    """
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
    assert {name: saved[name] for name in UNRELATED} == UNRELATED
    assert mock.messages[0].headers["authorization"] == "Bearer sk-ant-oat01-fresh"
    assert (sandbox.agent_dir / "auth.json").read_bytes() == default


@pytest.mark.node_preload
@pytest.mark.parametrize("kind", ["refresh-refusal", "logout-relogin"])
def test_refresh_failure_sends_nothing_and_keeps_credentials(
    sandbox: Sandbox, mock: AnthropicMock, kind: str
) -> None:
    """Refused refresh preserves credentials; logout stays absent and explicit relogin works next launch.

    Parameters:
        sandbox (Sandbox): private fake credentials and installed stack.
        mock (AnthropicMock): loopback server refusing token refresh.
        kind (str): refresh-refusal or logout/relogin branch.
    """
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
