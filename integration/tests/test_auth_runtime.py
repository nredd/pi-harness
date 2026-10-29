"""Exercise the real runtime hook in a tiny native compiled executable, never a Node wrapper.

References:
- https://bun.sh/docs/bundler/executables
- https://bun.sh/docs/runtime/bunfig#preload
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from harness import anthropic_mock
from harness.anthropic_mock import AnthropicMock, anthropic_env
from harness.sandbox import build_sandbox

if TYPE_CHECKING:
    from http.server import BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[2]
PROVIDERS = ROOT / "integration/providers"


@pytest.fixture(scope="module")
def compiled_auth_fixture(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Compile only the two-module native fixture with the repository's installed Bun pin.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): private executable output directory.

    Returns:
        Path: compiled executable, not a runtime wrapper.
    """
    bun = shutil.which("bun")
    assert bun, "The pinned Bun runtime is required for the compiled auth fixture"
    assert (
        subprocess.check_output([bun, "--version"], text=True).strip()
        == (ROOT / ".bun-version").read_text().strip()
    )
    binary = tmp_path_factory.mktemp("compiled-auth") / "auth-fixture"
    subprocess.run(
        [bun, "build", "--compile", str(PROVIDERS / "auth_runtime_fixture.mjs"), "--outfile", str(binary)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return binary


@pytest.mark.parametrize("interception", [True, False])
@pytest.mark.parametrize("runtime", ["node", "compiled-bun"])
def test_compiled_auth_runtime_requires_interception(
    compiled_auth_fixture: Path, tmp_path: Path, runtime: str, *, interception: bool
) -> None:
    """Prove compiled preload admission and fail-closed refusal using the actual harness environment.

    Parameters:
        compiled_auth_fixture (Path): native executable.
        tmp_path (Path): private fake-only sandbox.
        runtime (str): Node preload control or actual compiled Bun executable.
        interception (bool): remove both runtime hooks for the negative control.
    """
    box = build_sandbox(tmp_path / "box")
    with AnthropicMock() as mock:
        env = anthropic_env(mock, box)
        if not interception:
            env |= {"NODE_OPTIONS": "", "BUN_OPTIONS": ""}
        node = shutil.which("node")
        assert node
        command = (
            [node, str(PROVIDERS / "auth_runtime_fixture.mjs")]
            if runtime == "node"
            else [str(compiled_auth_fixture)]
        )
        result = subprocess.run(
            command, env=box.env(env), capture_output=True, text=True, timeout=15, check=False
        )
        if interception:
            assert result.returncode == 0, result.stderr
            assert result.stdout.strip() == "AUTH_RUNTIME_FIXTURE_OK"
            assert len(mock.messages) == 1
            assert mock.messages[0].headers["authorization"] == "Bearer fixture-only"
            assert mock.messages[0].path == "/v1/messages?fixture=1"
            log = Path(env["HARNESS_BLOCKED_LOG"]).read_text().splitlines()
            assert len(log) == (2 if runtime == "node" else 6)
        else:
            assert result.returncode != 0
            assert "redirect preload is missing" in result.stderr
            assert mock.messages == []
        assert mock.tokens == []


@pytest.mark.parametrize(
    ("mode", "message"),
    [
        ("--stale-nonce", "redirect preload is missing"),
        ("--lost-egress", "did not refuse non-loopback"),
        ("--wrong-echo", "readiness nonce did not match"),
    ],
)
def test_compiled_auth_runtime_rejects_broken_readiness(
    compiled_auth_fixture: Path, tmp_path: Path, mode: str, message: str
) -> None:
    """Reject stale identity, a missing fetch guard and a wrong loopback echo before dispatch.

    Parameters:
        compiled_auth_fixture (Path): native executable.
        tmp_path (Path): private sandbox.
        mode (str): controlled broken-readiness mutation, without real egress.
        message (str): required refusal evidence.
    """
    box = build_sandbox(tmp_path / "box")
    with AnthropicMock() as mock:
        result = subprocess.run(
            [str(compiled_auth_fixture), mode],
            env=box.env(anthropic_env(mock, box)),
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode != 0
        assert message in result.stderr
        assert mock.messages == []
        assert mock.tokens == []


def test_compiled_auth_runtime_never_follows_redirects(
    compiled_auth_fixture: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prove a real HTTP redirect cannot bypass fetch interception, using two loopback servers.

    Parameters:
        compiled_auth_fixture (Path): native executable.
        tmp_path (Path): private sandbox.
        monkeypatch (pytest.MonkeyPatch): replace only the fake server's response.
    """
    box = build_sandbox(tmp_path / "box")
    with AnthropicMock() as mock, AnthropicMock() as destination:

        def redirect(request: BaseHTTPRequestHandler) -> None:
            """Return a credential-preserving redirect to another recording loopback server.

            Parameters:
                request (BaseHTTPRequestHandler): fake provider request.
            """
            request.send_response(307)
            request.send_header("Location", destination.url + "/v1/messages")
            request.send_header("Content-Length", "0")
            request.end_headers()

        monkeypatch.setattr(anthropic_mock, "_send_stream", redirect)
        result = subprocess.run(
            [str(compiled_auth_fixture)],
            env=box.env(anthropic_env(mock, box)),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert result.returncode != 0
        assert len(mock.messages) == 1
        assert destination.messages == []
        assert mock.tokens == destination.tokens == []


@pytest.mark.parametrize("endpoint", ["https://example.invalid", "http://127.0.0.1:1234/path"])
def test_compiled_auth_hook_refuses_unsafe_mock_origin(
    compiled_auth_fixture: Path, tmp_path: Path, endpoint: str
) -> None:
    """Reject invalid redirect targets before the native fixture can dispatch.

    Parameters:
        compiled_auth_fixture (Path): native executable.
        tmp_path (Path): private sandbox.
        endpoint (str): invalid origin; no request is sent to it.
    """
    box = build_sandbox(tmp_path / "box")
    with AnthropicMock() as mock:
        env = anthropic_env(mock, box) | {"HARNESS_ANTHROPIC_MOCK": endpoint}
        result = subprocess.run(
            [str(compiled_auth_fixture)],
            env=box.env(env),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert result.returncode != 0
        assert "requires an exact http://127.0.0.1 loopback origin" in result.stderr
        assert mock.messages == []
        assert mock.tokens == []
