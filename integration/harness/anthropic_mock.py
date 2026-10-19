"""Local stand-in for the Anthropic API and OAuth token endpoint, with fake credentials only.

`providers/redirect_anthropic.mjs` points pi's `fetch` here, so the REAL native Anthropic provider
and OAuth refresh run end to end while the harness records exactly what they sent: headers, bodies
and order. No real token is read or sent.

References:
- Messages streaming events: https://docs.anthropic.com/en/api/messages-streaming
- OAuth refresh grant (RFC 6749 section 6): https://datatracker.ietf.org/doc/html/rfc6749#section-6
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlsplit

from harness.paths import PROVIDERS_DIR

if TYPE_CHECKING:
    from pathlib import Path
    from types import TracebackType

    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)

REDIRECT_PRELOAD = PROVIDERS_DIR / "redirect_anthropic.mjs"
AUTH_GUARD_EXTENSION = PROVIDERS_DIR / "auth_guard.mjs"
MOCK_ENV = "HARNESS_ANTHROPIC_MOCK"
REPLY_TEXT = "MOCK ANTHROPIC OK"
# Commands an Anthropic run must never reach for: Claude Code's CLI and the macOS keychain.
# PATH shims catch bare names; the preload blocks and records node `child_process` launches of
# either, including the absolute `/usr/bin/security` a shim cannot stop.
RECORDING_SHIMS = ("claude", "security")


@dataclass(frozen=True)
class RecordedRequest:
    """One request the mock served.

    Attributes:
        path (str): request path.
        headers (dict[str, str]): lower-cased header names.
        body (dict[str, Any] | str): parsed JSON, or the decoded form body of a token request.
    """

    path: str
    headers: dict[str, str]
    body: dict[str, Any] | str


@dataclass
class AnthropicMock:
    """Threaded HTTP server scripted per test.

    Attributes:
        messages (list[RecordedRequest]): `/v1/messages` calls, in order.
        tokens (list[RecordedRequest]): `/v1/oauth/token` calls, in order.
        token_replies (list[tuple[int, dict[str, Any]]]): queued `(status, json)` token replies;
            an exhausted queue answers 500 so an unexpected refresh is visible, not silent.
        message_status (int): status for `/v1/messages`; non-200 sends an error body.
    """

    messages: list[RecordedRequest] = field(default_factory=list)
    tokens: list[RecordedRequest] = field(default_factory=list)
    token_replies: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    message_status: int = 200
    _server: ThreadingHTTPServer | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def url(self) -> str:
        """Base URL the preload redirects to.

        Raises:
            RuntimeError: the server is not running.
        """
        if self._server is None:
            raise RuntimeError("`AnthropicMock` is not started")
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> AnthropicMock:
        """Start serving on a free loopback port.

        Returns:
            AnthropicMock: this server.
        """
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                """Answer only a loopback runtime-readiness nonce, not any real API."""
                parsed = urlsplit(self.path)
                nonce = parse_qs(parsed.query).get("nonce", [""])[0]
                _send_json(
                    self, 200 if parsed.path == "/__harness_ready__" and nonce else 404, {"nonce": nonce}
                )

            def do_POST(self) -> None:
                """Read the body and hand the request to `AnthropicMock.handle`."""
                length = int(self.headers.get("content-length") or 0)
                mock.handle(self, self.rfile.read(length).decode())

            def log_message(self, format: str, *args: object) -> None:
                """Send the access log to `LOGGER` instead of stderr."""
                LOGGER.debug(f"mock anthropic: {format % args}")

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        """Stop serving."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def queue_token(self, status: int, body: dict[str, Any]) -> None:
        """Queue the reply to the next token request.

        Parameters:
            status (int): HTTP status.
            body (dict[str, Any]): JSON body.
        """
        self.token_replies.append((status, body))

    def handle(self, request: BaseHTTPRequestHandler, raw_body: str) -> None:
        """Record and answer one POST.

        Parameters:
            request (BaseHTTPRequestHandler): the live request.
            raw_body (str): decoded body.
        """
        headers = {name.lower(): value for name, value in request.headers.items()}
        if request.path.startswith("/v1/oauth/token"):
            form = {key: values[0] for key, values in parse_qs(raw_body).items()}
            body: dict[str, Any] | str = form or _json_or_text(raw_body)
            with self._lock:
                self.tokens.append(RecordedRequest(request.path, headers, body))
                status, reply = (
                    self.token_replies.pop(0) if self.token_replies else (500, {"error": "unscripted"})
                )
            _send_json(request, status, reply)
        elif request.path.startswith("/v1/messages"):
            with self._lock:
                self.messages.append(RecordedRequest(request.path, headers, _json_or_text(raw_body)))
            if self.message_status != 200:
                _send_json(
                    request, self.message_status, {"type": "error", "error": {"type": "authentication_error"}}
                )
            else:
                _send_stream(request)
        else:
            _send_json(request, 404, {"error": f"unscripted path {request.path}"})


def _json_or_text(raw: str) -> dict[str, Any] | str:
    """Parse a body as a JSON object.

    Parameters:
        raw (str): decoded body.

    Returns:
        dict[str, Any] | str: the object, or `raw` when it is not a JSON object.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    return parsed if isinstance(parsed, dict) else raw


def _send_json(request: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    """Answer a request with a JSON body.

    Parameters:
        request (BaseHTTPRequestHandler): live request.
        status (int): HTTP status.
        body (dict[str, Any]): JSON payload.
    """
    payload = json.dumps(body).encode()
    request.send_response(status)
    request.send_header("content-type", "application/json")
    request.send_header("content-length", str(len(payload)))
    request.end_headers()
    request.wfile.write(payload)


def _send_stream(request: BaseHTTPRequestHandler) -> None:
    """Answer a `/v1/messages` request with a one-text-block SSE stream saying `REPLY_TEXT`.

    Parameters:
        request (BaseHTTPRequestHandler): live request.
    """
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_harness",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-haiku-4-5",
                    "content": [],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
            },
        ),
        (
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        ),
        (
            "content_block_delta",
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": REPLY_TEXT}},
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"input_tokens": 1, "output_tokens": 3},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    payload = "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()
    request.send_response(200)
    request.send_header("content-type", "text/event-stream")
    request.send_header("content-length", str(len(payload)))
    request.end_headers()
    request.wfile.write(payload)


def install_recording_shims(box: Sandbox) -> None:
    """Replace the `RECORDING_SHIMS` commands with ones that log their argv and exit 1.

    Parameters:
        box (Sandbox): sandbox whose `shims_dir` is on `PATH`.
    """
    log = shim_log(box)
    for name in RECORDING_SHIMS:
        shim = box.shims_dir / name
        shim.write_text(f'#!/bin/sh\necho "{name} $*" >> "{log}"\nexit 1\n')
        shim.chmod(0o755)


def shim_log(box: Sandbox) -> Path:
    """Return the file the recording shims append to.

    Parameters:
        box (Sandbox): sandbox owning the shims.

    Returns:
        Path: log path; absent when nothing was invoked.
    """
    return box.root / "recording-shims.log"


def shim_calls(box: Sandbox) -> list[str]:
    """Return every recorded shim invocation.

    Parameters:
        box (Sandbox): sandbox owning the shims.

    Returns:
        list[str]: `name args` lines, empty when none ran.
    """
    log = shim_log(box)
    return log.read_text().splitlines() if log.is_file() else []


def anthropic_env(mock: AnthropicMock, box: Sandbox) -> dict[str, str]:
    """Return the environment that routes a pi run through the mock and blocks Claude Code access.

    Parameters:
        mock (AnthropicMock): running server.
        box (Sandbox): sandbox whose `shim_log` receives blocked `claude` / `security` launches.

    Returns:
        dict[str, str]: mock URL, blocked-call log, and a `NODE_OPTIONS` that preloads the redirect.
    """
    return {
        MOCK_ENV: mock.url,
        "HARNESS_AUTH_NONCE": secrets.token_hex(16),
        "HARNESS_BLOCKED_LOG": str(shim_log(box)),
        "NODE_OPTIONS": f"--import {REDIRECT_PRELOAD}",
    }
