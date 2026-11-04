"""`run_headless` and `RunResult` against the stub `pi` JSON event stream.

The stub exits on its own, so `finish_process` never reaches a group kill here; deadline and
overflow kills stay covered by injected killers in `test_headless_deadlines.py`.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness import headless
from harness.headless import RunResult, ToolOutcome, content_text, run_headless
from harness.paths import FAUX_EXTENSION
from tests.stub_pi import stub_pi_command
from tests.stub_pi_session import stub_sandbox

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {"text": "thinking out loud"},
                {
                    "text": "calling",
                    "tools": [
                        {"name": "bash", "args": {"command": "ls"}, "result": "a\nb"},
                        {"name": "deny", "result": "blocked", "isError": True},
                        {"name": "edit", "result": "bad", "endError": True},
                        {"name": "typed", "result": "{}", "structured": {"ok": 1}},
                    ],
                },
                {"text": "done"},
            ],
        }
    }
}


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Sandbox:
    """Bare sandbox, with `run_headless` launching the stub.

    Parameters:
        tmp_path (Path): test scratch.
        monkeypatch (pytest.MonkeyPatch): test patcher.

    Returns:
        Sandbox: fresh home.
    """
    monkeypatch.setattr(headless, "pi_command", stub_pi_command)
    return stub_sandbox(tmp_path)


def test_run_headless_parses_the_event_stream(box: Sandbox) -> None:
    """Events, noise, stderr and the evidence files all come from one real child run."""
    result = run_headless(box, SCRIPT, ["first", "/second"])
    assert result.returncode == 0
    assert result.argv == [
        *stub_pi_command(),
        "-e",
        str(FAUX_EXTENSION),
        "--model",
        "faux/main",
        "--mode",
        "json",
        "-p",
        "first",
        "/second",
    ]
    assert result.stdout_noise == ["stub pi banner, not JSON"]
    assert result.stderr == "stub stderr line\n"
    session = result.of_type("session")[0]
    assert session["argv"] == result.argv[2:]
    assert all(headless.SEEN_AT in event for event in result.events)
    assert set(result.first_event_s) == {
        "session",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
    }
    (script,) = box.root.glob("script-*.json")
    assert json.loads(script.read_text()) == SCRIPT
    logged = [json.loads(line) for line in script.with_suffix(".events.jsonl").read_text().splitlines()]
    assert logged == result.events
    assert script.with_suffix(".stderr").read_text() == result.stderr
    assert script.with_suffix(".noise.txt").read_text() == "stub pi banner, not JSON"


def test_run_headless_flags_and_exit_status(box: Sandbox, tmp_path: Path) -> None:
    """Session/faux toggles, extra args and env reach the child; a failing exit is returned."""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = run_headless(
        box,
        SCRIPT,
        ["go"],
        model="faux/other",
        extra_args=["--thinking", "off"],
        env={"STUB_PI_EXIT": "7"},
        cwd=elsewhere,
        persist_session=False,
        load_faux=False,
    )
    assert result.returncode == 7
    assert result.argv[2:] == [
        "--no-session",
        "--model",
        "faux/other",
        "--thinking",
        "off",
        "--mode",
        "json",
        "-p",
        "go",
    ]


def test_tool_outcomes_pair_starts_and_ends(box: Sandbox) -> None:
    """Each end pairs with its start by call id; errors come from the end or the result."""
    outcomes = run_headless(box, SCRIPT, ["go"]).tool_outcomes()
    assert [(o.name, o.args, o.is_error, o.text, o.structured) for o in outcomes] == [
        ("bash", {"command": "ls"}, False, "a\nb", None),
        ("deny", {}, True, "blocked", None),
        ("edit", {}, True, "bad", None),
        ("typed", {}, False, "{}", {"ok": 1}),
    ]
    assert all(outcome.duration_s >= 0 for outcome in outcomes)


def test_assistant_texts_and_transcript(box: Sandbox) -> None:
    """Assistant text skips user turns; the transcript renders messages, tools and stderr."""
    result = run_headless(box, SCRIPT, ["go"])
    assert result.assistant_texts() == [
        "thinking out loud",
        'calling<call bash {"command": "ls"}><call deny {}><call edit {}><call typed {}>',
        "done",
    ]
    lines = result.transcript().split("\n")
    assert lines[0] == f"$ {' '.join(result.argv)}"
    assert lines[1].startswith("exit 0 in ")
    assert "[user] go" in lines
    assert "[assistant] done" in lines
    assert "  -> bash error=False a" in lines
    assert "  -> edit error=True bad" in lines
    assert lines[-3:] == ["--- stderr", "stub stderr line", ""]


def test_tool_outcome_without_a_start_or_result() -> None:
    """An orphan end keeps its own name, empty args, and a zero duration."""
    result = RunResult(
        argv=[],
        returncode=0,
        events=[{"type": "tool_execution_end", "toolCallId": "x", "toolName": "orphan", "result": None}],
        stdout_noise=[],
        stderr="",
        duration_s=0.0,
    )
    assert result.tool_outcomes() == [ToolOutcome(name="orphan", args={}, is_error=False, text="")]


@pytest.mark.parametrize(
    ("content", "text"),
    [
        ("plain", "plain"),
        (None, ""),
        ({"type": "text"}, ""),
        (["skip", {"type": "image"}, {"type": "text", "text": "a"}, {"type": "text"}], "a"),
        ([{"type": "toolCall", "name": "t", "arguments": [1]}], "<call t [1]>"),
    ],
)
def test_content_text_flattens_blocks(content: object, text: str) -> None:
    """Strings pass through, non-lists are empty, unknown and non-dict blocks are skipped."""
    assert content_text(content) == text
