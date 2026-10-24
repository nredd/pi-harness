"""Credential-free local OpenAI-compatible provider that replays a scripted conversation.

Stock Pi talks to it through a `models.json` provider on a loopback port, so real Pi code
(model registry, agent loop, extension tools) runs offline without credentials or provider calls.
Each chat-completions request is answered from a script, indexed by the number of assistant
messages already in the request. Requests are recorded so tests can assert what Pi sent.

A second conversation in the same process (e.g. a subagent child session sharing the provider)
would otherwise replay the parent's script. Optional `Route`s select a different script when a
user message contains a marker, so each conversation keeps its own turn indexing.

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

from pydantic import BaseModel, ConfigDict, Field, ValidationError

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


@dataclass(frozen=True)
class ErrorStep:
    """One provider SSE error, after transport establishment.

    Parameters:
        message (str): Synthetic error message delivered by the provider SDK.
    """

    message: str


Step = ToolStep | TextStep | ErrorStep


@dataclass(frozen=True)
class Route:
    """An alternative script for requests whose user messages contain `marker`.

    Parameters:
        marker (str): Non-empty text searched for in the text of every `user` message.
        script (Sequence[Step]): Turns for matching conversations, indexed like the default script.
    """

    marker: str
    script: Sequence[Step]

    def __post_init__(self) -> None:
        """Reject a route that could never be selected or answered.

        Raises:
            ValueError: If `marker` is empty or `script` has no steps.
        """
        if not self.marker:
            raise ValueError("`marker` must not be empty")
        if not self.script:
            raise ValueError(f"route '{self.marker}' needs at least one step")


@dataclass(frozen=True)
class RecordedRequest:
    """What Pi sent for one model call.

    Parameters:
        model (str): Physical model id the request named.
        roles (tuple[str, ...]): Message roles in order.
        tools (tuple[str, ...]): Names of the declared tools.
        system (str): Text of the `system` and `developer` messages, joined by newlines.
        route (str | None): Marker of the `Route` that answered, `None` for the default script.
        tool_results (tuple[str, ...]): Text of the `tool` messages in order, i.e. what Pi returned for
            the calls already made in this conversation.
    """

    model: str
    roles: tuple[str, ...]
    tools: tuple[str, ...]
    system: str = ""
    route: str | None = None
    tool_results: tuple[str, ...] = ()


REQUEST_MODEL = ConfigDict(extra="ignore", frozen=True, strict=True)


class ChatPart(BaseModel):
    model_config = REQUEST_MODEL
    text: str | None = Field(default=None, description="Text of a text part; absent for other part kinds")


class ChatMessage(BaseModel):
    model_config = REQUEST_MODEL
    role: str = Field(description="Message author role")
    content: str | list[ChatPart] | None = Field(
        default=None, description="Message content: a string, a list of parts, or null for tool calls"
    )

    def text(self) -> str:
        """Join the message's text.

        Returns:
            str: The string content, or the text parts joined without a separator; empty for null.
        """
        if self.content is None:
            return ""
        if isinstance(self.content, str):
            return self.content
        return "".join(part.text or "" for part in self.content)


class ChatToolFunction(BaseModel):
    model_config = REQUEST_MODEL
    name: str = Field(description="Declared tool name")


class ChatTool(BaseModel):
    model_config = REQUEST_MODEL
    function: ChatToolFunction = Field(description="Function declaration")


class ChatRequest(BaseModel):
    model_config = REQUEST_MODEL
    model: str = Field(description="Physical model id the request names")
    messages: list[ChatMessage] = Field(default_factory=list, description="Conversation so far")
    tools: list[ChatTool] = Field(default_factory=list, description="Declared tools")


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
    if isinstance(step, ErrorStep):
        error = {
            "error": {"message": step.message, "type": "insufficient_quota", "code": "insufficient_quota"}
        }
        return b"data: " + json.dumps(error).encode() + b"\n\ndata: [DONE]\n\n"
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

    def __init__(self, script: Sequence[Step], routes: Sequence[Route] = ()) -> None:
        """Bind an ephemeral loopback port; serving starts on `__enter__`.

        Parameters:
            script (Sequence[Step]): Non-empty scripted turns.
            routes (Sequence[Route]): Optional alternative scripts, tried in order.

        Raises:
            ValueError: If `script` is empty or two routes share a marker.
        """
        if not script:
            raise ValueError("`script` must contain at least one step")
        markers = [route.marker for route in routes]
        if len(set(markers)) != len(markers):
            raise ValueError(f"duplicate route markers: {markers}")
        self.script = tuple(script)
        self.routes = tuple(routes)
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
                try:
                    length = int(self.headers.get("content-length", "0"))
                    body = json.loads(self.rfile.read(length))
                    payload = provider.respond(body)
                except ValueError as e:
                    # `ValidationError`, `JSONDecodeError` and a bad length are all `ValueError`s.
                    reason = " ".join(str(e).split())[:200]
                    LOGGER.warning(f"Rejected malformed chat request: {reason}")
                    self.send_error(400, f"malformed chat request: {reason}")
                    return
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

    def respond(self, body: object) -> bytes:
        """Record the request and encode the scripted answer.

        Parameters:
            body (object): Parsed chat-completions request JSON.

        Returns:
            bytes: SSE response body.

        Raises:
            ValueError: If `body` lacks the consumed fields (`model`, `messages[].role`,
                `messages[].content`, `tools[].function.name`) or they have the wrong type.
        """
        try:
            request = ChatRequest.model_validate(body)
        except ValidationError as e:
            raise ValueError(
                "; ".join(f"`{'.'.join(str(p) for p in i['loc'])}`: {i['msg']}" for i in e.errors())
            ) from e
        roles = tuple(message.role for message in request.messages)
        tools = tuple(tool.function.name for tool in request.tools)
        system = "\n".join(m.text() for m in request.messages if m.role in {"system", "developer"})
        user_text = [m.text() for m in request.messages if m.role == "user"]
        tool_results = tuple(m.text() for m in request.messages if m.role == "tool")
        route = next((r for r in self.routes if any(r.marker in text for text in user_text)), None)
        script = route.script if route else self.script
        with self._lock:
            self.requests.append(
                RecordedRequest(
                    request.model, roles, tools, system, route.marker if route else None, tool_results
                )
            )
        index = min(roles.count("assistant"), len(script) - 1)
        return encode_step(script[index], index)

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
