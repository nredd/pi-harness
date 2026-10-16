"""Credential-free local OpenAI-compatible provider that replays a scripted conversation.

Stock Pi talks to it through a `models.json` provider on a loopback port, so real Pi code
(model registry, agent loop, extension tools) runs offline without credentials or provider calls.
Each chat-completions request is answered from a script, indexed by the number of assistant
messages already in the request. Requests are recorded so tests can assert what Pi sent.

References:
    https://platform.openai.com/docs/api-reference/chat/streaming
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from typing import Any, Self

LOGGER = logging.getLogger(__name__)

LOOPBACK = "127.0.0.1"
CHAT_PATH = "/v1/chat/completions"
PROVIDER_API_KEY = "faux-local"  # Not a credential: the server never checks it.


@dataclass(frozen=True)
class ToolStep:
    """One scripted assistant turn that calls a tool.

    Parameters:
        name (str): Tool name Pi must have declared in the request.
        arguments (dict[str, Any]): JSON-serializable tool arguments.
    """

    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TextStep:
    """One scripted final assistant turn.

    Parameters:
        text (str): Assistant text.
    """

    text: str


Step = ToolStep | TextStep


@dataclass(frozen=True)
class RecordedRequest:
    """What Pi sent for one model call.

    Parameters:
        model (str): Physical model id the request named.
        roles (tuple[str, ...]): Message roles in order.
        tools (tuple[str, ...]): Names of the declared tools.
    """

    model: str
    roles: tuple[str, ...]
    tools: tuple[str, ...]


def _chunk(delta: dict[str, Any], finish_reason: str | None) -> bytes:
    """Encode one server-sent chat-completion chunk.

    Parameters:
        delta (dict[str, Any]): Delta payload.
        finish_reason (str | None): OpenAI finish reason, or `None` mid-stream.

    Returns:
        bytes: The SSE frame.
    """
    body: dict[str, Any] = {
        "id": "faux",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "faux",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if finish_reason is not None:
        body["usage"] = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
    return b"data: " + json.dumps(body).encode() + b"\n\n"


def encode_step(step: Step, index: int) -> bytes:
    """Encode a scripted turn as a complete SSE response body.

    Parameters:
        step (Step): The turn to emit.
        index (int): Turn index, used to make tool-call ids unique.

    Returns:
        bytes: SSE frames ending with `[DONE]`.
    """
    if isinstance(step, ToolStep):
        call = {
            "index": 0,
            "id": f"call_{index}",
            "type": "function",
            "function": {"name": step.name, "arguments": json.dumps(step.arguments)},
        }
        frames = _chunk({"role": "assistant", "tool_calls": [call]}, None) + _chunk({}, "tool_calls")
    else:
        frames = _chunk({"role": "assistant", "content": step.text}, None) + _chunk({}, "stop")
    return frames + b"data: [DONE]\n\n"


class FauxProvider:
    """Loopback chat-completions server replaying `script`; a context manager.

    Parameters:
        script (Sequence[Step]): Turns, one per assistant message. Requests past the end repeat
            the final turn, so a script ending in `TextStep` is stable under retries.
    """

    def __init__(self, script: Sequence[Step]) -> None:
        """Bind an ephemeral loopback port; serving starts on `__enter__`.

        Parameters:
            script (Sequence[Step]): Non-empty scripted turns.

        Raises:
            ValueError: If `script` is empty.
        """
        if not script:
            raise ValueError("`script` must contain at least one step")
        self.script = tuple(script)
        self.requests: list[RecordedRequest] = []
        self._lock = threading.Lock()
        provider = self

        class Handler(BaseHTTPRequestHandler):
            """Answer chat completions from the enclosing provider's script."""

            def do_POST(self) -> None:
                """Handle one chat-completions request."""
                if self.path != CHAT_PATH:
                    self.send_error(404)
                    return
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                payload = provider.respond(body)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: object) -> None:
                """Silence per-request logging.

                Parameters:
                    format (str): `%`-style message format.
                    *args (object): Format arguments.
                """

        self._server = ThreadingHTTPServer((LOOPBACK, 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        """Base URL for the provider's `baseUrl` setting.

        Returns:
            str: Base URL ending in `/v1`.
        """
        return f"http://{LOOPBACK}:{self._server.server_address[1]}/v1"

    def respond(self, body: dict[str, Any]) -> bytes:
        """Record the request and encode the scripted answer.

        Parameters:
            body (dict[str, Any]): Parsed chat-completions request.

        Returns:
            bytes: SSE response body.
        """
        messages: list[dict[str, Any]] = body.get("messages", [])
        roles = tuple(str(message.get("role")) for message in messages)
        tools = tuple(str(tool["function"]["name"]) for tool in body.get("tools", []))
        with self._lock:
            self.requests.append(RecordedRequest(str(body.get("model")), roles, tools))
        index = min(roles.count("assistant"), len(self.script) - 1)
        return encode_step(self.script[index], index)

    def __enter__(self) -> Self:
        """Start serving.

        Returns:
            Self: The running provider.
        """
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Stop serving and release the port.

        Parameters:
            exc_type (type[BaseException] | None): Propagating exception type.
            exc (BaseException | None): Propagating exception.
            tb (TracebackType | None): Traceback.
        """
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def models_json(base_url: str, provider_name: str, model_ids: Sequence[str]) -> str:
    """Render a `models.json` registering the provider under `provider_name`.

    Parameters:
        base_url (str): The provider base URL.
        provider_name (str): Provider id Pi lists the models under.
        model_ids (Sequence[str]): Model ids to list.

    Returns:
        str: JSON document for `<agent dir>/models.json`.
    """
    provider = {
        "baseUrl": base_url,
        "api": "openai-completions",
        "apiKey": PROVIDER_API_KEY,
        "models": [{"id": model_id} for model_id in model_ids],
    }
    return json.dumps({"providers": {provider_name: provider}}, indent=2) + "\n"
