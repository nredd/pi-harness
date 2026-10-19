"""pi-session-kit `/monitor` end to end: lifecycle, wakeups, caps, timeout, shutdown, Plan mode, subagents.

Real pi, faux providers, the installed fleet (pi-plan-mode, pi-subagents, pi-deferred-context-engine,
...) plus the kit selected from sandbox package settings (or `HARNESS_LOCAL=pi-session-kit`).
Print mode runs a prompt to completion and exits, so the scripts keep the turn
open with a `bash sleep` while the monitors produce output; a monitor message that wakes the agent is
delivered as a follow-up turn after that turn settles. Every monitor child carries a unique number in
its command line, so `ps` proves what died. `TMPDIR` points into the sandbox, so pidfiles are per test.

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
- `src/monitor/index.ts`: tools, wake policy, shutdown; `src/monitor/pidfiles.ts`: orphan sweep
"""

from __future__ import annotations

import json
import random
import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, ToolOutcome, run_headless
from harness.paths import FAUX_EXTENSION, GIT_BIN, pi_command
from harness.session_kit import STATS_MODELS, kit_args, seed_stats_sessions

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

MESSAGE_TYPE = "session-kit:monitor"
TOOLS = ("monitor_start", "monitor_read", "monitor_stop")
# Longer than any scenario, so a child outliving its test is obvious in `ps`.
LONG_SLEEP_S = 900


def tool(name: str, /, **args: Any) -> dict[str, Any]:
    """A faux step calling one tool.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux step.
    """
    return {"tools": [{"name": name, "args": args}]}


def wait(seconds: int) -> dict[str, Any]:
    """A faux step holding the turn open (monitors keep running and delivering meanwhile).

    Parameters:
        seconds (int): how long the `bash` call sleeps.

    Returns:
        dict[str, Any]: faux step.
    """
    return tool("bash", command=f"/bin/sleep {seconds}")


def start(name: str, script: str, **extra: Any) -> dict[str, Any]:
    """A faux step calling `monitor_start` on `sh -c <script>`.

    Parameters:
        name (str): monitor name.
        script (str): shell script, usually ending in a unique `sleep`.
        **extra (Any): `match`, `wake`, `timeout_s`.

    Returns:
        dict[str, Any]: faux step.
    """
    return tool(
        "monitor_start", argv=["/bin/sh", "-c", script.replace("sleep ", "/bin/sleep ")], name=name, **extra
    )


@pytest.fixture
def tag() -> int:
    """A number unique to this test, used as a `sleep` duration so `ps` can find the children.

    Returns:
        int: seconds of the long sleep, e.g. 912345.
    """
    return LONG_SLEEP_S * 1000 + random.randint(0, 99_999)


@pytest.fixture(autouse=True)
def reap(tag: int) -> Iterator[None]:
    """Kill any child still carrying this test's tag, so a failure never leaks processes.

    Parameters:
        tag (int): the test's unique number.

    Yields:
        None: the test runs.
    """
    yield
    subprocess.run(["/usr/bin/pkill", "-f", f"/bin/sleep {tag}"], check=False)


def promote() -> dict[str, Any]:
    """A faux step doing what a model must do first: `search_tools` for the deferred monitor tools.

    The live config defers every tool outside `alwaysActive` (`deferred-tools.json`), and calling a
    deferred tool fails with `Tool ... not found` until it is promoted.

    Returns:
        dict[str, Any]: faux step.
    """
    return tool("search_tools", query="background monitor process watcher", kind="tool")


def run(box: Sandbox, steps: list[dict[str, Any]], prompts: list[str], **extra: Any) -> RunResult:
    """One headless run with the kit loaded and a sandbox `TMPDIR` (pidfile root).

    The first step promotes the monitor tools, so `steps` are exactly the monitor calls under test.

    Parameters:
        box (Sandbox): sandbox.
        steps (list[dict[str, Any]]): parent faux steps.
        prompts (list[str]): prompts and commands in order.
        **extra (Any): further `run_headless` keywords; `providers` adds faux providers.

    Returns:
        RunResult: the run, after a clean exit.
    """
    promote_first = extra.pop("promote_first", True)
    providers = {
        "faux": {"models": ["main"], "steps": [*([promote()] if promote_first else []), *steps]}
    } | extra.pop("providers", {})
    extra_args = [*kit_args(box), *extra.pop("extra_args", [])]
    tmp = box.root / "tmp"
    tmp.mkdir(exist_ok=True)
    env = {"TMPDIR": str(tmp)} | extra.pop("env", {})
    result = run_headless(box, {"providers": providers}, prompts, extra_args=extra_args, env=env, **extra)
    assert result.returncode == 0, result.transcript()
    return result


def monitor_messages(box: Sandbox) -> list[dict[str, Any]]:
    """Every persisted monitor message, oldest first.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[dict[str, Any]]: `custom_message` entries.
    """
    entries = [
        json.loads(line)
        for path in sorted((box.agent_dir / "sessions").rglob("*.jsonl"))
        for line in path.read_text().splitlines()
        if line.strip()
    ]
    return [e for e in entries if e.get("customType") == MESSAGE_TYPE]


def outcomes(result: RunResult, name: str) -> list[ToolOutcome]:
    """Settled outcomes of one tool.

    Parameters:
        result (RunResult): run.
        name (str): tool name.

    Returns:
        list[ToolOutcome]: matching outcomes in order.
    """
    return [o for o in result.tool_outcomes() if o.name == name]


def spoken(result: RunResult) -> list[str]:
    """Assistant text turns, without the tool-call-only messages.

    Parameters:
        result (RunResult): run.

    Returns:
        list[str]: texts.
    """
    return [t for t in result.assistant_texts() if t and not t.startswith("<call")]


def alive(tag: int) -> list[str]:
    """Process lines (`ps`) of children carrying this test's number.

    Parameters:
        tag (int): the test's unique number.

    Returns:
        list[str]: `pid command` lines, empty when nothing is left.
    """
    out = subprocess.run(
        ["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True
    ).stdout
    return [line.strip() for line in out.splitlines() if f"sleep {tag}" in line]


def pidfiles(box: Sandbox) -> list[Path]:
    """Pidfiles under the sandbox `TMPDIR`.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[Path]: files, empty after a clean shutdown.
    """
    return sorted((box.root / "tmp").glob("pi-monitors-*/*/*.json"))


def test_tools_are_deferred_then_promoted_by_search_tools(sandbox: Sandbox) -> None:
    """Keep monitor_read active for Plan mode and promote start/stop only on demand."""
    steps = [{"listTools": True}, promote(), {"listTools": True}]
    result = run(sandbox, steps, ["before", "search"], promote_first=False)
    before, after = (t.removeprefix("TOOLS ").split(",") for t in spoken(result))
    assert "monitor_read" in before, before
    assert not {"monitor_start", "monitor_stop"} & set(before), before
    assert set(TOOLS) <= set(after), after
    (found,) = outcomes(result, "search_tools")
    assert all(name in found.text for name in ("monitor_start", "monitor_stop")), found.text


def test_stop_kills_the_process_group_and_stays_quiet(sandbox: Sandbox, tag: int) -> None:
    """`monitor_stop` ends the child and its descendants; a requested stop never wakes the agent."""
    steps = [
        start("victim", f"sleep {tag} & sleep {tag}"),
        wait(1),
        tool("monitor_stop", id="victim"),
        wait(3),
        {"text": "after stop"},
        {"text": "SHOULD NOT RUN"},
    ]
    result = run(sandbox, steps, ["go"])
    (stopped,) = outcomes(result, "monitor_stop")
    assert not stopped.is_error, stopped
    assert "stopped" in stopped.text, stopped
    assert spoken(result) == ["after stop"], result.transcript()
    assert alive(tag) == [], alive(tag)
    assert pidfiles(sandbox) == []
    again = run(sandbox, [tool("monitor_stop", id="victim"), {"text": "x"}], ["go"])
    assert outcomes(again, "monitor_stop")[0].is_error


def test_children_die_when_pi_quits_mid_monitor(sandbox: Sandbox, tag: int) -> None:
    """Quitting with monitors running leaves no process and no pidfile (`ps` and the pidfile root)."""
    steps = [start("a", f"sleep {tag}"), start("b", f"sleep {tag}"), {"text": "started both"}]
    result = run(sandbox, steps, ["go"])
    assert "started both" in spoken(result)
    assert alive(tag) == [], alive(tag)
    assert pidfiles(sandbox) == []


def test_diff_prints_the_stat_outside_the_tui(sandbox: Sandbox) -> None:
    """`/diff` in print mode (no UI, so `notify` is a no-op) prints the stat and reports errors.

    Core diverts an extension's `process.stdout` writes to stderr in print mode, so the stat is asserted
    on the combined output; what matters is that something is printed and the exit stays 0.

    Lives here because it is headless; the overlay scenarios are `tui/test_session_kit_monitor_diff.py`.
    """
    repo = sandbox.workdir
    git = [
        GIT_BIN,
        "-c",
        "user.name=h",
        "-c",
        "user.email=h@h",
        "-c",
        "commit.gpgsign=false",
        "-C",
        str(repo),
    ]
    subprocess.check_call([*git, "init", "-q"])
    (repo / "a.txt").write_text("x\n")
    subprocess.check_call([*git, "add", "."])
    subprocess.check_call([*git, "commit", "-q", "-m", "init"])
    (repo / "a.txt").write_text("y\n")
    (repo / "new.txt").write_text("z\n")
    script = sandbox.root / "diff-script.json"
    script.write_text(json.dumps({"providers": {"faux": {"models": ["main"], "steps": []}}}))
    env = sandbox.env({"HARNESS_SCRIPT": str(script)})

    def diff(argument: str) -> subprocess.CompletedProcess[str]:
        argv = [
            *pi_command(),
            "-e",
            str(FAUX_EXTENSION),
            "--model",
            "faux/main",
            *kit_args(sandbox),
            "-p",
            argument,
        ]
        return subprocess.run(
            argv, cwd=repo, env=env, capture_output=True, text=True, timeout=60, check=False
        )

    good = diff("/diff")
    assert good.returncode == 0, good.stderr
    shown = good.stdout + good.stderr
    assert "a.txt" in shown
    assert "?? new.txt" in shown
    bad = diff("/diff no-such-ref-xyz")
    assert bad.returncode == 0, bad.stderr
    assert "/diff: " in bad.stdout + bad.stderr


def test_stats_prints_the_model_table_outside_the_tui(sandbox: Sandbox) -> None:
    """`/stats` in print mode prints the per-model table over the seeded history, and nothing it must skip.

    Same stdout-to-stderr diversion as `/diff`, so the combined output is asserted. The seed's `faux`,
    `router` and tool-result rows would dominate the totals if counted.
    """
    seed_stats_sessions(sandbox.agent_dir)
    script = sandbox.root / "stats-script.json"
    script.write_text(json.dumps({"providers": {"faux": {"models": ["main"], "steps": []}}}))
    argv = [
        *pi_command(),
        "-e",
        str(FAUX_EXTENSION),
        "--model",
        "faux/main",
        *kit_args(sandbox),
        "-p",
        "/stats",
    ]
    result = subprocess.run(
        argv,
        cwd=sandbox.workdir,
        env=sandbox.env({"HARNESS_SCRIPT": str(script)}),
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    shown = result.stdout + result.stderr
    assert "tokens (in + out + cache), all time" in shown, shown
    header = next((line for line in shown.splitlines() if line.startswith("provider ")), "")
    assert header.split() == [
        "provider",
        "model",
        "in",
        "out",
        "cache",
        "read",
        "cache",
        "write",
        "cost",
        "%",
    ], shown
    rows = [
        line.split()[:2] for line in shown.splitlines() if line.startswith(("anthropic ", "openai-codex "))
    ]
    assert rows[0] == ["anthropic", "claude-opus-5-5"], shown
    assert sorted(model for _, model in rows) == sorted(model for _, model, _ in STATS_MODELS), shown
    assert "faux" not in shown.split("all time", 1)[1], shown
    assert "router" not in shown, shown
    assert (sandbox.agent_dir / "pi-session-kit" / "stats-cache.json").is_file()
