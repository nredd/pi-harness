"""`pi-session-kit` path-scoped rules and auto-titles, using sandbox package selection.

References:
- `~/code/pi-session-kit/src/rules/index.ts`: path-scoped rule injection into tool results
- `~/code/pi-session-kit/src/titles/index.ts`: auto session titles (TUI only)
- `~/code/pi-harness-e2e/harness/headless.py`: `run_headless` faux-provider runner
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, run_headless
from harness.session_kit import kit_args

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

RULE_TEXT = "RULE-MARKER use tabs in TypeScript"
RULE_ENTRY = "session-kit:rule-injected"
TITLE_REPLY = "Skipme Title Words"


def run_kit(sandbox: Sandbox, steps: list[dict[str, Any]], prompts: list[str], *extra: str) -> RunResult:
    """Run headless pi with the kit loaded and `faux/main` scripted with `steps`.

    Parameters:
        sandbox (Sandbox): isolated agent dir and workdir for the run.
        steps (list[dict[str, Any]]): scripted `faux/main` steps, consumed in order.
        prompts (list[str]): user prompts sent to the session.
        *extra (str): additional pi CLI arguments, e.g. `--continue`.

    Returns:
        RunResult: the finished headless run.
    """
    script = {"providers": {"faux": {"models": ["main"], "steps": steps}}}
    return run_headless(sandbox, script, prompts, extra_args=[*kit_args(sandbox), *extra])


def session_entries(sandbox: Sandbox) -> list[dict[str, Any]]:
    """Every entry of every session file in the sandbox.

    Parameters:
        sandbox (Sandbox): sandbox whose `sessions` directory is read.

    Returns:
        list[dict[str, Any]]: parsed JSONL entries, files in sorted order.
    """
    entries: list[dict[str, Any]] = []
    for path in sorted((sandbox.agent_dir / "sessions").rglob("*.jsonl")):
        entries.extend(json.loads(line) for line in path.read_text().splitlines() if line.strip())
    return entries


def read_step(path: str) -> dict[str, Any]:
    """A faux step that makes the model call `read` on `path`.

    Parameters:
        path (str): path argument for the `read` tool call.

    Returns:
        dict[str, Any]: the scripted step.
    """
    return {"tools": [{"name": "read", "args": {"path": path}}]}


def write_rule(sandbox: Sandbox) -> None:
    """Write a project rule for `src/**/*.ts`, and the files it should (not) match.

    Parameters:
        sandbox (Sandbox): sandbox whose workdir receives `.pi/rules/ts.md` and the files.

    Returns:
        None
    """
    rules = sandbox.workdir / ".pi" / "rules"
    rules.mkdir(parents=True)
    (rules / "ts.md").write_text(f"---\npaths:\n  - src/**/*.ts\n---\n{RULE_TEXT}\n")
    (sandbox.workdir / "src").mkdir()
    for name in ("src/a.ts", "src/b.ts", "README.md"):
        (sandbox.workdir / name).write_text("content\n")


def test_rule_injected_once_on_matching_read(sandbox: Sandbox) -> None:
    """First read of a matching file carries the rule; the second and a non-matching read do not."""
    write_rule(sandbox)
    steps = [read_step("src/a.ts"), read_step("src/b.ts"), read_step("README.md"), {"text": "OK"}]
    result = run_kit(sandbox, steps, ["go"])
    assert result.returncode == 0, result.transcript()
    first, second, third = result.tool_outcomes()
    assert RULE_TEXT in first.text, result.transcript()
    assert RULE_TEXT not in second.text, result.transcript()
    assert RULE_TEXT not in third.text, result.transcript()
    injected = [e for e in session_entries(sandbox) if e.get("customType") == RULE_ENTRY]
    assert [e["data"]["rule"] for e in injected] == ["project:ts.md"], injected


def test_rule_not_injected_for_non_matching_path(sandbox: Sandbox) -> None:
    """A path no glob matches never triggers the rule or a session entry."""
    write_rule(sandbox)
    result = run_kit(sandbox, [read_step("README.md"), {"text": "OK"}], ["go"])
    (outcome,) = result.tool_outcomes()
    assert RULE_TEXT not in outcome.text, result.transcript()
    assert not [e for e in session_entries(sandbox) if e.get("customType") == RULE_ENTRY]


def test_rule_state_survives_resume(sandbox: Sandbox) -> None:
    """After `--continue`, the injection recorded in the session is remembered: no second injection."""
    write_rule(sandbox)
    first = run_kit(sandbox, [read_step("src/a.ts"), {"text": "OK"}], ["go"])
    assert RULE_TEXT in first.tool_outcomes()[0].text, first.transcript()
    second = run_kit(sandbox, [read_step("src/b.ts"), {"text": "OK"}], ["again"], "--continue")
    assert second.returncode == 0, second.transcript()
    assert RULE_TEXT not in second.tool_outcomes()[0].text, second.transcript()


def test_titles_skipped_in_print_mode(sandbox: Sandbox) -> None:
    """With the title model pointed at the scripted faux model, a non-TUI run still names nothing.

    A title call would consume the second step and set `Skipme Title Words`.
    """
    sandbox.patch_json("pi-session-kit.json", {"titles": {"enabled": True, "model": "faux/main"}})
    result = run_kit(sandbox, [{"text": "OK"}, {"text": TITLE_REPLY}], ["name this session please"])
    assert result.returncode == 0, result.transcript()
    assert result.assistant_texts() == ["OK"], result.transcript()
    entries = session_entries(sandbox)
    assert entries, "no session file was written"
    assert not [e for e in entries if e.get("type") == "session_info"], entries
    assert TITLE_REPLY not in json.dumps(entries)
