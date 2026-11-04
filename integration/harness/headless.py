"""Headless pi runs (`--mode json -p`) against scripted faux providers.

References:
- pi JSON event stream: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from contextlib import suppress
from dataclasses import dataclass, field
from threading import Event, Thread
from typing import TYPE_CHECKING, Any

from harness import process_group
from harness.paths import FAUX_EXTENSION, pi_command

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)
# Private key stamped on every parsed event: seconds since launch when the line was read.
SEEN_AT = "_harness_seen_s"

DEFAULT_TIMEOUT_S = 180
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
# Bound on the `/bin/ps` listing that explains a `killpg` EPERM.
GROUP_LISTING_TIMEOUT_S = 5.0


@dataclass(frozen=True)
class ToolOutcome:
    """One settled tool execution.

    Attributes:
        name (str): tool name.
        args (dict[str, Any]): call arguments.
        is_error (bool): whether the tool (or a policy hook) failed it.
        text (str): concatenated text content of the result.
        structured (Any): the result's `structuredContent`, when the tool declares an
            `outputSchema`; `None` otherwise.
        duration_s (float): wall time from `tool_execution_start` to `tool_execution_end` as
            seen on pi's stdout; 0 when either event is missing.
    """

    name: str
    args: dict[str, Any]
    is_error: bool
    text: str
    structured: Any = None
    duration_s: float = 0.0


@dataclass
class RunResult:
    """Everything a headless run produced.

    Attributes:
        argv (list[str]): command that ran.
        returncode (int): process exit code.
        events (list[dict[str, Any]]): parsed JSON events, in order.
        stdout_noise (list[str]): stdout lines that were not JSON.
        stderr (str): raw stderr.
        duration_s (float): wall time.
    """

    argv: list[str]
    returncode: int
    events: list[dict[str, Any]]
    stdout_noise: list[str]
    stderr: str
    duration_s: float
    first_event_s: dict[str, float] = field(default_factory=dict)

    def of_type(self, event_type: str) -> list[dict[str, Any]]:
        """Return events of one type.

        Parameters:
            event_type (str): e.g. `message_end`.

        Returns:
            list[dict[str, Any]]: matching events.
        """
        return [event for event in self.events if event.get("type") == event_type]

    def tool_outcomes(self) -> list[ToolOutcome]:
        """Return settled tool executions in order.

        Returns:
            list[ToolOutcome]: one per `tool_execution_end`.
        """
        starts = {event.get("toolCallId"): event for event in self.of_type("tool_execution_start")}
        outcomes = []
        for end in self.of_type("tool_execution_end"):
            start = starts.get(end.get("toolCallId"), {})
            result = end.get("result") or {}
            outcomes.append(
                ToolOutcome(
                    name=str(end.get("toolName", start.get("toolName", ""))),
                    args=dict(start.get("args") or {}),
                    is_error=bool(end.get("isError") or result.get("isError")),
                    text=content_text(result.get("content")),
                    structured=result.get("structuredContent"),
                    duration_s=max(0.0, float(end.get(SEEN_AT, 0.0)) - float(start.get(SEEN_AT, 0.0))),
                )
            )
        return outcomes

    def assistant_texts(self) -> list[str]:
        """Return the text of every finished assistant message.

        Returns:
            list[str]: one entry per assistant `message_end`.
        """
        return [
            content_text(event["message"].get("content"))
            for event in self.of_type("message_end")
            if event.get("message", {}).get("role") == "assistant"
        ]

    def transcript(self) -> str:
        """Render a compact human-readable log for failure artifacts.

        Returns:
            str: one line per message or tool outcome.
        """
        lines = [f"$ {' '.join(self.argv)}", f"exit {self.returncode} in {self.duration_s:.2f}s"]
        for event in self.events:
            if event.get("type") == "message_end":
                message = event.get("message", {})
                lines.append(f"[{message.get('role')}] {content_text(message.get('content'))[:400]}")
            elif event.get("type") == "tool_execution_end":
                result = content_text((event.get("result") or {}).get("content"))
                lines.append(f"  -> {event.get('toolName')} error={event.get('isError')} {result[:400]}")
        lines.extend(["--- stderr", self.stderr])
        return "\n".join(lines)


def content_text(content: object) -> str:
    """Flatten message content to its text.

    Parameters:
        content (object): string or list of content blocks.

    Returns:
        str: joined text, tool calls rendered as `<call name args>`.
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("type") == "toolCall":
            parts.append(f"<call {block.get('name')} {json.dumps(block.get('arguments'))}>")
    return "".join(parts)


def run_headless(
    sandbox: Sandbox,
    script: dict[str, Any],
    prompts: list[str],
    *,
    model: str = "faux/main",
    extra_args: list[str] | None = None,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
    persist_session: bool = True,
    load_faux: bool = True,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> RunResult:
    """Run pi once in JSON print mode with the faux provider script.

    Parameters:
        sandbox (Sandbox): pi home to run in.
        script (dict[str, Any]): faux provider script, see `providers/faux.ts`.
        prompts (list[str]): messages processed in order (slash commands allowed).
        model (str): `provider/id` to select.
        extra_args (list[str] | None): additional pi flags.
        env (dict[str, str] | None): extra environment.
        cwd (Path | None): working directory, default the sandbox workdir.
        persist_session (bool): write the session jsonl into the sandbox (kept as a failure
            artifact); benchmarks turn it off to match their baseline.
        load_faux (bool): load `providers/faux.ts`; the live tier turns it off and talks to
            real providers (the script is then unused).
        timeout_s (float): hard limit for the process.

    Returns:
        RunResult: parsed outcome. A non-zero exit is returned, not raised.
    """
    script_path = sandbox.root / f"script-{time.monotonic_ns()}.json"
    script_path.write_text(json.dumps(script))
    argv = [
        *pi_command(),
        *([] if persist_session else ["--no-session"]),
        *(["-e", str(FAUX_EXTENSION)] if load_faux else []),
        "--model",
        model,
        *(extra_args or []),
        "--mode",
        "json",
        "-p",
        *prompts,
    ]
    LOGGER.info(f"Running headless pi: {argv}")
    started = time.monotonic()
    process = subprocess.Popen(
        argv,
        cwd=cwd or sandbox.workdir,
        env=sandbox.env({"HARNESS_SCRIPT": str(script_path)} | (env or {})),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )
    result = collect_json_process(process, argv, started, timeout_s)
    script_path.with_suffix(".events.jsonl").write_text(
        "".join(json.dumps(event) + "\n" for event in result.events)
    )
    script_path.with_suffix(".stderr").write_text(result.stderr)
    script_path.with_suffix(".noise.txt").write_text("\n".join(result.stdout_noise))
    return result


def collect_json_process(
    process: subprocess.Popen[str], argv: list[str], started: float, timeout_s: float
) -> RunResult:
    """Drain both output pipes with limits and enforce a deadline even on silent stdout.

    Parameters:
        process (subprocess.Popen[str]): running session leader with captured pipes.
        argv (list[str]): command for diagnostics.
        started (float): monotonic launch time.
        timeout_s (float): wall deadline.

    Returns:
        RunResult: captured output and event timestamps.

    Raises:
        TimeoutError: the process never settled before its deadline.
        RuntimeError: an output cap was exceeded.
        PermissionError: killing the session group was refused and not explained as zombie-only,
            see `harness.process_group.kill_owned_group`.
        OSError: waiting for the leader's exit failed.
    """
    events: list[dict[str, Any]] = []
    noise: list[str] = []
    first_event_s: dict[str, float] = {}
    assert process.stdout is not None
    assert process.stderr is not None
    errors: list[str] = []
    # Readers never signal: they flag overflow and wake the main thread, which owns every kill.
    overflow = Event()
    wake = Event()

    def drain_stdout() -> None:
        """Bound stdout while preserving event-read timestamps for benchmarks."""
        total = 0
        stdout = process.stdout
        assert stdout is not None
        for line in iter(lambda: stdout.readline(MAX_OUTPUT_BYTES + 1), ""):
            total += len(line.encode())
            if total > MAX_OUTPUT_BYTES:
                overflow.set()
                wake.set()
                return
            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                noise.append(stripped)
                continue
            if isinstance(event, dict):
                event[SEEN_AT] = time.monotonic() - started
                events.append(event)
                first_event_s.setdefault(str(event.get("type")), event[SEEN_AT])

    def drain_stderr() -> None:
        """Drain stderr concurrently so loader diagnostics cannot deadlock stdout."""
        total = 0
        stderr = process.stderr
        assert stderr is not None
        for chunk in iter(lambda: stderr.read(4096), ""):
            total += len(chunk.encode())
            if total > MAX_OUTPUT_BYTES:
                overflow.set()
                wake.set()
                return
            errors.append(chunk)

    readers = [Thread(target=drain_stdout, daemon=True), Thread(target=drain_stderr, daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = finish_process(process, readers, timeout_s, wake, overflow)
    stderr = "".join(errors)
    if timed_out:
        raise TimeoutError(f"Pi exceeded {timeout_s}s deadline: {argv}; stderr={stderr[-2000:]}")
    if overflow.is_set():
        raise RuntimeError(f"Pi exceeded {MAX_OUTPUT_BYTES} output bytes: {argv}")
    return RunResult(
        argv=argv,
        returncode=process.returncode,
        events=events,
        stdout_noise=noise,
        stderr=stderr,
        duration_s=time.monotonic() - started,
        first_event_s=first_event_s,
    )


def finish_process(
    process: subprocess.Popen[str], readers: list[Thread], timeout_s: float, wake: Event, overflow: Event
) -> bool:
    """Wait with a deadline, kill the group when needed, join the pipe readers, then reap.

    The leader is reaped only after the last signal. Until then its zombie reserves the
    process-group number, so no kill here can reach a reused, foreign group. Precondition:
    nothing else reaps `process` or signals its group; readers only set `wake` and `overflow`.

    Parameters:
        process (subprocess.Popen[str]): real process session leader.
        readers (list[Thread]): concurrent pipe drainers.
        timeout_s (float): maximum process lifetime.
        wake (Event): set by a reader on overflow; also set here when the leader exits.
        overflow (Event): a reader exceeded the output cap.

    Returns:
        bool: whether the process exceeded its deadline.

    Raises:
        PermissionError: killing the group was refused and not explained as zombie-only, see
            `harness.process_group.kill_owned_group`.
        OSError: waiting for the leader's exit failed.
        RuntimeError: a process outside the group kept the output pipes open.
        subprocess.TimeoutExpired: the leader survived SIGKILL.

    On `PermissionError` or `OSError` the group may still be alive, so this neither reaps the
    leader nor closes the pipes: reaping could block and closing could race the readers. The
    leader stays a child of this process and the daemon readers end when the pipes do.
    """
    deadline = time.monotonic() + timeout_s
    exited = Event()

    watch_errors: list[OSError] = []

    def watch_leader() -> None:
        """Wake the main thread when the leader exits, leaving it unreaped as the PGID anchor."""
        try:
            # ECHILD only if something reaped it anyway; it has exited either way.
            with suppress(ChildProcessError):
                os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT)
        except OSError as error:
            watch_errors.append(error)
        finally:
            exited.set()
            wake.set()

    Thread(target=watch_leader, daemon=True).start()
    timed_out = not wake.wait(timeout_s)
    if watch_errors:
        raise watch_errors[0]
    killed = timed_out or overflow.is_set()
    if killed:
        process_group.kill_owned_group(process.pid, GROUP_LISTING_TIMEOUT_S)
        exited.wait(10)
    for reader in readers:
        reader.join(timeout=max(0, deadline - time.monotonic()))
    stuck = any(reader.is_alive() for reader in readers)
    # A descendant can overflow after the leader exited: that still kills the group, once.
    if stuck or (overflow.is_set() and not killed):
        timed_out = timed_out or stuck
        process_group.kill_owned_group(process.pid, GROUP_LISTING_TIMEOUT_S)
        for reader in readers:
            reader.join(timeout=2)
    # Reap only now: no signal follows, readers never send one.
    process.wait(timeout=10)
    if any(reader.is_alive() for reader in readers):
        raise RuntimeError("Pi left inherited output pipes open outside its process group")
    assert process.stdout is not None
    assert process.stderr is not None
    process.stdout.close()
    process.stderr.close()
    return timed_out
