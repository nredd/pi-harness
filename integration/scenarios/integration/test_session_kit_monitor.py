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
from harness.sandbox import Sandbox, enable_faux_models, local_overrides_from_env, package_name
from harness.session_kit import STATS_MODELS, kit_args, seed_stats_sessions

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

pytestmark = pytest.mark.integration

MESSAGE_TYPE = "session-kit:monitor"
TOOLS = ("monitor_start", "monitor_read", "monitor_stop")
# Longer than any scenario, so a child outliving its test is obvious in `ps`.
LONG_SLEEP_S = 900
PLAN_BLOCK = "plan mode"


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


def test_passive_output_is_coalesced_and_never_wakes(sandbox: Sandbox, tag: int) -> None:
    """Three lines inside the 2s window are ONE message; nothing matches, so no extra turn runs."""
    script = f"echo one; echo two; echo three; sleep {tag}"
    steps = [start("quiet", script), wait(5), {"text": "waiting"}, {"text": "SHOULD NOT RUN"}]
    result = run(sandbox, steps, ["go"])
    assert spoken(result) == ["waiting"], result.transcript()
    (message,) = monitor_messages(sandbox)
    body = message["content"]
    assert all(f"{n}: " in body for n in ("1", "2", "3")), body
    for word in ("one", "two", "three"):
        assert word in body, body
    assert message["display"] is True
    assert alive(tag) == [], alive(tag)
    assert pidfiles(sandbox) == []


def test_match_wakes_the_agent(sandbox: Sandbox, tag: int) -> None:
    """A line matching `match` wakes the agent: the follow-up turn runs after the first settles."""
    script = f"echo boot; sleep 1; echo READY now; sleep {tag}"
    steps = [
        start("srv", script, match="READY"),
        wait(5),
        {"text": "waiting"},
        tool("monitor_read", id="srv"),
        {"text": "woken and read"},
    ]
    result = run(sandbox, steps, ["go"])
    assert "woken and read" in spoken(result), result.transcript()
    bodies = [m["content"] for m in monitor_messages(sandbox)]
    assert any("READY now" in b and "match on" in b for b in bodies), bodies
    (read,) = outcomes(result, "monitor_read")
    assert not read.is_error, read
    assert "READY now" in read.text, read
    assert alive(tag) == []


def test_wake_true_wakes_on_every_batch(sandbox: Sandbox, tag: int) -> None:
    """`wake: true` without `match` still wakes."""
    steps = [
        start("loud", f"echo ping; sleep {tag}", wake=True),
        wait(5),
        {"text": "waiting"},
        {"text": "woken"},
    ]
    result = run(sandbox, steps, ["go"])
    assert "woken" in spoken(result), result.transcript()


def test_exit_wakes_and_reports_the_code(sandbox: Sandbox) -> None:
    """A process that exits wakes the agent with its exit code, even with no output pending."""
    steps = [start("short", "echo bye; exit 3"), wait(4), {"text": "waiting"}, {"text": "woken by exit"}]
    result = run(sandbox, steps, ["go"])
    assert "woken by exit" in spoken(result), result.transcript()
    bodies = "\n".join(m["content"] for m in monitor_messages(sandbox))
    assert "exited with code 3" in bodies, bodies


def test_read_since_returns_only_later_lines(sandbox: Sandbox, tag: int) -> None:
    """`monitor_read since=N` skips lines up to N; the result names the next cursor."""
    steps = [
        start("lines", f"echo a; echo b; echo c; sleep {tag}"),
        wait(1),
        tool("monitor_read", id="lines"),
        tool("monitor_read", id="m1", since=2),
        tool("monitor_read", id="lines", since=3),
        {"text": "end"},
    ]
    result = run(sandbox, steps, ["go"])
    full, later, none = outcomes(result, "monitor_read")
    assert "1: a" in full.text, full.text
    assert "3: c" in full.text, full.text
    assert "next since: 3" in full.text, full.text
    assert "1: a" not in later.text, later.text
    assert "2: b" not in later.text, later.text
    assert "3: c" in later.text, later.text
    assert "(no new output)" in none.text, none.text
    assert "next since: 3" in none.text, none.text


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


def test_five_monitors_at_most(sandbox: Sandbox, tag: int) -> None:
    """The sixth concurrent monitor is refused with a clear error; a duplicate name is refused too."""
    steps = [start(f"w{i}", f"sleep {tag}") for i in range(5)]
    steps += [start("w6", f"sleep {tag}"), tool("monitor_stop", id="w0"), start("w7", f"sleep {tag}")]
    steps += [start("w1", f"sleep {tag}"), {"text": "end"}]
    result = run(sandbox, steps, ["go"])
    started = outcomes(result, "monitor_start")
    assert [o.is_error for o in started] == [False] * 5 + [True, False, True], [o.text for o in started]
    assert "at most 5" in started[5].text, started[5].text
    assert "already named" in started[7].text, started[7].text
    assert alive(tag) == [], "every child dies when the session ends"


def test_timeout_kills_and_wakes(sandbox: Sandbox, tag: int) -> None:
    """`timeout_s` kills the process and wakes the agent with a timeout notice."""
    steps = [
        start("slow", f"echo up; sleep {tag}", timeout_s=2),
        wait(6),
        {"text": "waiting"},
        {"text": "woken by timeout"},
    ]
    result = run(sandbox, steps, ["go"])
    assert "woken by timeout" in spoken(result), result.transcript()
    assert any("timed out after" in m["content"] for m in monitor_messages(sandbox))
    assert alive(tag) == []


def test_children_die_when_pi_quits_mid_monitor(sandbox: Sandbox, tag: int) -> None:
    """Quitting with monitors running leaves no process and no pidfile (`ps` and the pidfile root)."""
    steps = [start("a", f"sleep {tag}"), start("b", f"sleep {tag}"), {"text": "started both"}]
    result = run(sandbox, steps, ["go"])
    assert "started both" in spoken(result)
    assert alive(tag) == [], alive(tag)
    assert pidfiles(sandbox) == []


def test_bad_arguments_are_errors_not_crashes(sandbox: Sandbox) -> None:
    """No shell: a missing binary, a bad regex and a bad name each fail the call with a message."""
    steps = [
        tool("monitor_start", argv=["/nonexistent/binary"], name="x"),
        tool("monitor_start", argv=["/bin/sleep", "1"], name="y", match="("),
        tool("monitor_start", argv=["/bin/sleep", "1"], name="bad name!"),
        tool("monitor_read", id="nope"),
        {"text": "end"},
    ]
    result = run(sandbox, steps, ["go"])
    errors = [o for o in result.tool_outcomes() if o.name.startswith("monitor_")]
    assert [o.is_error for o in errors] == [True] * 4, [o.text for o in errors]
    assert "cannot start" in errors[0].text
    assert "regex" in errors[1].text
    assert "name must match" in errors[2].text
    assert "no monitor" in errors[3].text


def test_plan_mode_admits_only_monitor_read(sandbox: Sandbox, tag: int) -> None:
    """Plan mode: `monitor_read` runs (readOnlyHint); `monitor_start` and `monitor_stop` are denied.

    Plan mode freezes its tool set at `/plan start` and a `search_tools` promotion does not survive
    that, so a deferred `monitor_read` is simply not there (`Tool monitor_read not found`; the same
    limit `test_plan_mode_policy.py` documents for the worktree tools). The live config therefore
    needs `monitor_read` in `alwaysActive` and `neverDefer`; the sandbox gets that here. Start and
    stop stay deferred, are promoted in the plan turn, and then meet the Plan policy.
    """
    deferred_path = sandbox.agent_dir / "deferred-tools.json"
    deferred = json.loads(deferred_path.read_text())
    for key in ("alwaysActive", "neverDefer"):
        deferred[key] = [*deferred[key], "monitor_read"]
    deferred_path.write_text(json.dumps(deferred, indent=2))
    steps = [
        start("pre", f"echo before-plan; sleep {tag}"),
        {"text": "started"},
        promote(),
        tool("monitor_read", id="pre"),
        start("during", f"sleep {tag}"),
        tool("monitor_stop", id="pre"),
        {"text": "plan turn done"},
    ]
    result = run(sandbox, steps, ["go", "/plan start", "inspect it"])
    (read,) = outcomes(result, "monitor_read")
    assert not read.is_error, read
    assert "before-plan" in read.text, read
    (start_plan,) = outcomes(result, "monitor_start")[1:]
    (stop,) = outcomes(result, "monitor_stop")
    assert start_plan.is_error, start_plan
    assert PLAN_BLOCK in start_plan.text.lower(), start_plan.text
    assert stop.is_error, stop
    assert PLAN_BLOCK in stop.text.lower(), stop.text
    assert alive(tag) == []


@pytest.mark.parametrize("kit_first", [False, True], ids=["configured-order", "kit-first"])
def test_subagents_do_not_get_monitor_tools(sandbox: Sandbox, kit_first: bool) -> None:
    """Real child package loads deny calls and schemas even after promotion and scope reset."""
    assert kit_args(sandbox) == [], "This regression must use package discovery, not root-only -e"
    override = local_overrides_from_env().get("pi-session-kit")
    if kit_first:
        packages = sandbox.settings()["packages"]
        kit = [
            package
            for package in packages
            if package_name(str(package.get("source", "")) if isinstance(package, dict) else str(package))
            == "pi-session-kit"
            or (override is not None and str(package) == str(override))
        ]
        assert len(kit) == 1, packages
        sandbox.patch_json("settings.json", {"packages": [*kit, *(p for p in packages if p not in kit)]})
    enable_faux_models(sandbox, ["faux/main", "kid/child"])
    probe = sandbox.agent_dir / "extensions" / "session-kit-child-scope.ts"
    probe.parent.mkdir(exist_ok=True)
    probe.write_text((FAUX_EXTENSION.parent.parent / "probes" / probe.name).read_text())
    deferred = json.loads((sandbox.agent_dir / "deferred-tools.json").read_text())
    for key in ("alwaysActive", "neverDefer"):
        deferred[key] = [*deferred[key], "session_kit_child_scope_probe"]
    sandbox.patch_json("deferred-tools.json", deferred)
    agent = {
        "subagent_type": "general-purpose",
        "description": "list tools",
        "prompt": "list",
        "model": "kid/child",
        "run_in_background": False,
    }
    steps = [tool("search_tools", query="background monitor", kind="tool"), {"listTools": True}]
    steps += [tool("Agent", **agent), {"text": "end"}]
    child_steps = [
        tool("session_kit_child_scope_probe"),
        tool("search_tools", query="background monitor", kind="tool"),
        # A scripted model can emit undeclared calls. Neither promotion nor stale declarations
        # authorize them; inspect the real child execution errors before the final schema snapshot.
        tool("monitor_read", id="parent"),
        tool("monitor_start", argv=["/bin/echo", "CHILD MUST NOT SPAWN"], name="child"),
        tool("monitor_stop", id="parent"),
        {"listTools": True},
    ]
    child = {"kid": {"models": ["child"], "steps": child_steps}}
    result = run(sandbox, steps, ["promote", "list", "spawn"], providers=child)
    parent_tools = next(t for t in result.assistant_texts() if t.startswith("TOOLS "))
    assert all(name in parent_tools for name in TOOLS), parent_tools
    (spawn,) = outcomes(result, "Agent")
    assert "TOOLS " in spawn.text, spawn.text
    assert not any(name in spawn.text for name in (*TOOLS, "goal_update")), spawn.text
    snapshot = json.loads((sandbox.workdir / "session-kit-child-scope.json").read_text())
    assert snapshot["name"].startswith("general-purpose#"), snapshot
    assert {entry["name"] for entry in snapshot["tools"]} == {*TOOLS, "goal_update"}, snapshot
    assert all(entry["exposure"] == "hidden" for entry in snapshot["tools"]), snapshot
    assert not {*TOOLS, "goal_update"} & set(snapshot["active"]), snapshot
    if override is not None:
        assert str(override) in json.dumps(snapshot["tools"]), snapshot
    denied = [
        json.loads(line)
        for line in (sandbox.workdir / "session-kit-child-calls.jsonl").read_text().splitlines()
    ]
    assert {call["name"] for call in denied} == set(TOOLS), denied
    assert all(call["isError"] for call in denied), denied
    assert all(
        "not available" in json.dumps(call["result"]) or "not found" in json.dumps(call["result"])
        for call in denied
    ), denied


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
