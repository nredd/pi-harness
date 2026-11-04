"""Stdlib-only stand-in for `pi`, so the live-session drivers run without a real Pi process.

Run as a script through `PI_BIN`-style argv (`stub_pi_command()`); imported, it only exposes
that command. It speaks the three surfaces the drivers consume:

- `--mode json -p <prompts>`: the JSON event stream `harness.headless` parses
- `--mode rpc`: JSONL commands on stdin, `response`/agent events on stdout (`harness.rpc`)
- no `--mode`: a line-based TUI on a tty, for `harness.tmux`/`harness.interactive`, that also
  writes the render (`HARNESS_PROBE_OUT`) and latency (`PI_LATENCY_PROBE`) probe records

The model side is the `HARNESS_SCRIPT` the drivers write (`providers/faux.ts` format: `text` and
`tools` steps). Stub-only tool fields: `result` (text), `isError`, `endError`, `structured`.
Deterministic by construction: no clocks in any payload except the latency `t` stamp.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import sys
import termios
import time
import tty
from pathlib import Path
from typing import Any

STUB = Path(__file__).resolve()
MOUSE_REPORT = re.compile(rb"\x1b\[<(\d+);(\d+);(\d+)([Mm])")
LATENCY_INDEX = re.compile(r"latency-(\d+)")
BYTES_PER_MB = 1024 * 1024
# Stub exit status for an explicit early exit; distinct from any signal-derived code.
EARLY_EXIT = 3
FLOOD_BYTES = 4096
# The footer styles the model name, so a styled capture differs from a plain one.
BOLD = "\x1b[1m"
RESET = "\x1b[0m"


def stub_pi_command() -> list[str]:
    """Return the argv prefix that launches this stub with the running interpreter.

    Returns:
        list[str]: `[python, stub_pi.py]`.
    """
    return [sys.executable, str(STUB)]


def emit(event: dict[str, Any]) -> None:
    """Write one JSON record to stdout and flush.

    Parameters:
        event (dict[str, Any]): record.
    """
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def script_steps() -> list[dict[str, Any]]:
    """Read the faux steps from `HARNESS_SCRIPT`, none when unset.

    Returns:
        list[dict[str, Any]]: `providers.faux.steps`.
    """
    path = os.environ.get("HARNESS_SCRIPT")
    if not path:
        return []
    return json.loads(Path(path).read_text())["providers"]["faux"].get("steps", [])


def option(argv: list[str], flag: str) -> str | None:
    """Return the value following `flag`, if present.

    Parameters:
        argv (list[str]): stub arguments.
        flag (str): e.g. `--mode`.

    Returns:
        str | None: the value, or None.
    """
    return argv[argv.index(flag) + 1] if flag in argv else None


def assistant_turn(step: dict[str, Any], index: int) -> None:
    """Emit one scripted assistant turn: its message, then each tool execution.

    Parameters:
        step (dict[str, Any]): faux step.
        index (int): step position, used for tool call ids.
    """
    content: list[dict[str, Any]] = [{"type": "text", "text": step["text"]}] if "text" in step else []
    tools = step.get("tools", [])
    content += [
        {"type": "toolCall", "name": tool["name"], "arguments": tool.get("args", {})} for tool in tools
    ]
    emit({"type": "message_end", "message": {"role": "assistant", "content": content}})
    for offset, tool in enumerate(tools):
        call = f"call-{index}-{offset}"
        emit(
            {
                "type": "tool_execution_start",
                "toolCallId": call,
                "toolName": tool["name"],
                "args": tool.get("args", {}),
            }
        )
        result: dict[str, Any] = {"content": [{"type": "text", "text": tool.get("result", "")}]}
        if tool.get("isError"):
            result["isError"] = True
        if "structured" in tool:
            result["structuredContent"] = tool["structured"]
        emit(
            {
                "type": "tool_execution_end",
                "toolCallId": call,
                "toolName": tool["name"],
                "isError": bool(tool.get("endError")),
                "result": result,
            }
        )


def run_json(argv: list[str]) -> int:
    """Answer `--mode json -p`: noise, the scripted turns, a stderr line, then exit.

    Parameters:
        argv (list[str]): stub arguments.

    Returns:
        int: `STUB_PI_EXIT`, default 0.
    """
    prompts = argv[argv.index("-p") + 1 :]
    print("stub pi banner, not JSON")
    print()
    emit({"type": "session", "argv": argv})
    for prompt in prompts:
        emit({"type": "message_end", "message": {"role": "user", "content": prompt}})
    for index, step in enumerate(script_steps()):
        assistant_turn(step, index)
    sys.stdout.flush()
    sys.stderr.write("stub stderr line\n")
    return int(os.environ.get("STUB_PI_EXIT", "0"))


def run_rpc() -> int:
    """Answer RPC commands on stdin until EOF.

    Prompts: `/exit` exits early without a response, `/reject` is refused, `/flood` (stdout) and
    `/flood-stderr` write one oversized line; any other prompt is accepted and answered with the
    next scripted text.

    Returns:
        int: 0 at EOF, `EARLY_EXIT` on `/exit`.
    """
    sys.stderr.write("stub rpc ready\n")
    sys.stderr.flush()
    if os.environ.get("STUB_PI_NOISE"):
        print("stub rpc banner, not JSON")
        print(json.dumps(["not", "an", "event"]), flush=True)
    replies = iter(step.get("text", "") for step in script_steps())
    for line in sys.stdin:
        command = json.loads(line)
        message = command.get("message", "")
        if message == "/exit":
            sys.stderr.write("stub rpc early exit\n")
            return EARLY_EXIT
        if message in {"/flood", "/flood-stderr"}:
            stream = sys.stderr if message == "/flood-stderr" else sys.stdout
            print("x" * FLOOD_BYTES, file=stream, flush=True)
            continue
        accepted = message != "/reject"
        emit(
            {"type": "response", "id": command.get("id"), "command": command.get("type"), "success": accepted}
        )
        if accepted:
            emit({"type": "agent_start"})
            text = next(replies, "DONE")
            emit(
                {
                    "type": "message_end",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
                }
            )
            emit({"type": "agent_end"})
    return 0


class Tui:
    """Line-based TUI: paints a footer, echoes submitted lines and mouse reports, writes probes."""

    def __init__(self) -> None:
        """Read probe destinations from the environment."""
        self.probe_out = os.environ.get("HARNESS_PROBE_OUT")
        latency = os.environ.get("PI_LATENCY_PROBE")
        self.latency_out = Path(latency) if latency else None
        match = LATENCY_INDEX.search(latency or "")
        self.pane_index = int(match.group(1)) if match else 0

    def paint(self, text: str) -> None:
        """Write one screen line.

        Parameters:
            text (str): line content.
        """
        os.write(1, f"{text}\r\n".encode())

    def footer(self) -> None:
        """Paint the footer naming the model and the terminal size."""
        size = shutil.get_terminal_size()
        self.paint(f"stub pi model {BOLD}main{RESET} {size.columns}x{size.lines}")

    def record_latency(self) -> None:
        """Append one latency `summary` window whose figures depend only on the pane index."""
        if self.latency_out is None:
            return
        i = self.pane_index
        record = {
            "kind": "summary",
            "t": time.time() * 1000,
            "window_s": 0.5,
            "loop_lag_ms": {"p99": 1.0 + i, "max": 10.0 + i},
            "stalls": [],
            "write": {"bytes": 100, "max_block_ms": 3.0 + i},
            "input_to_paint_ms": [4.0 + i],
        }
        with self.latency_out.open("a") as handle:
            handle.write(json.dumps(record) + "\n")

    def record_probe(self, frames: int) -> None:
        """Append one render-probe reading with frame times `1..frames` ms.

        Parameters:
            frames (int): frames requested by `/harness-probe`.
        """
        if self.probe_out is None:
            return
        record = {
            "frames_ms": list(range(1, frames + 1)),
            "steady_frames_ms": [value / 2 for value in range(1, frames + 1)],
            "heap_used": 3 * BYTES_PER_MB,
            "gc": True,
        }
        with Path(self.probe_out).open("a") as handle:
            handle.write(json.dumps(record) + "\n")

    def submit(self, text: str) -> int | None:
        """Handle one submitted line.

        Parameters:
            text (str): line without control bytes.

        Returns:
            int | None: exit status when the line ends the session.
        """
        self.record_latency()
        if text == "quit":
            return EARLY_EXIT
        if text.startswith("/harness-probe"):
            self.record_probe(int(text.split()[1]))
        self.paint(f"> {text}")
        return None

    def run(self) -> int:
        """Read raw tty input until EOF or `quit`.

        Returns:
            int: 0 at EOF, `EARLY_EXIT` on `quit`.
        """
        tty.setcbreak(0, termios.TCSANOW)
        signal.signal(signal.SIGWINCH, lambda *_: self.footer())
        if self.latency_out is not None:
            with self.latency_out.open("a") as handle:
                handle.write(json.dumps({"kind": "start", "t": time.time() * 1000}) + "\n")
        self.footer()
        buffer = b""
        while chunk := os.read(0, 4096):
            buffer += chunk
            for report in MOUSE_REPORT.finditer(buffer):
                button, column, row, kind = report.groups()
                self.paint(f"mouse b={int(button)} x={int(column)} y={int(row)} {kind.decode()}")
            buffer = MOUSE_REPORT.sub(b"", buffer)
            while (end := buffer.find(b"\n")) >= 0:
                line, buffer = buffer[:end], buffer[end + 1 :]
                status = self.submit(line.replace(b"\x1b", b"").replace(b"\r", b"").decode())
                if status is not None:
                    return status
        return 0


def main(argv: list[str]) -> int:
    """Dispatch on `--mode`.

    Parameters:
        argv (list[str]): stub arguments.

    Returns:
        int: exit status.
    """
    mode = option(argv, "--mode")
    if mode == "json":
        return run_json(argv)
    if mode == "rpc":
        return run_rpc()
    return Tui().run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
