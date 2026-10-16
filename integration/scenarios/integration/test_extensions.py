"""Every configured extension loads cleanly and the model sees the expected tool set."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from harness.golden import assert_golden
from harness.headless import run_headless

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration


def test_extensions_load_without_warnings(sandbox: Sandbox) -> None:
    """The configured packages load, and pi prints nothing beyond sandbox noise."""
    result = run_headless(
        sandbox, {"providers": {"faux": {"models": ["main"], "steps": [{"text": "OK"}]}}}, ["hi"]
    )
    assert result.returncode == 0, result.transcript()
    assert result.assistant_texts() == ["OK"], result.transcript()
    stderr_lines = [line for line in result.stderr.splitlines() if line.strip()]
    assert not stderr_lines, "\n".join(stderr_lines)
    assert not result.stdout_noise, result.stdout_noise
    # Nothing may install a GUI helper under the sandbox `$HOME`; macOS prompts for each new copy.
    apps = list((sandbox.home / "Applications").glob("*.app"))
    assert not apps, f"sandbox launched GUI helper apps: {apps}"


def test_tool_set(sandbox: Sandbox) -> None:
    """The tools offered to the model match `golden/tools.txt`."""
    result = run_headless(
        sandbox, {"providers": {"faux": {"models": ["main"], "steps": [{"listTools": True}]}}}, ["hi"]
    )
    texts = [text for text in result.assistant_texts() if text.startswith("TOOLS ")]
    assert texts, result.transcript()
    tools = texts[0].removeprefix("TOOLS ").split(",")
    assert_golden("tools.txt", "\n".join(tools) + "\n")


def test_workflows_trigger_does_not_arm_on_mentions(sandbox: Sandbox) -> None:
    """Mentioning workflows (e.g. `.github/workflows`) must not arm workflows mode or rewrite the prompt."""
    prompt = "check .github/workflows and the dynamic workflows docs"
    result = run_headless(
        sandbox, {"providers": {"faux": {"models": ["main"], "steps": [{"text": "OK"}]}}}, [prompt]
    )
    users = [
        event["message"]
        for event in result.of_type("message_end")
        if event.get("message", {}).get("role") == "user"
    ]
    assert users, result.transcript()
    content = users[0].get("content")
    text = content if isinstance(content, str) else "".join(block.get("text", "") for block in content)
    assert text == prompt, f"User message was rewritten:\n{text}"
