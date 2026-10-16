"""Real subscription-router quota recovery/admission with session-kit goals and loops.

Only router e2e faux providers run. Its usage stub seeds the REAL router's shared
tracker before the router loads; no provider-error stand-in or live credentials.
RPC keeps timers alive after settlement, unlike print mode. Only the loop's exact
30000 ms interval is shortened; admission reset times and the goal wake stay real.

References:
- https://github.com/nredd/pi-subscription-router/tree/main/e2e
- https://github.com/nredd/pi-session-kit
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
"""

from __future__ import annotations

import json
import subprocess
import time
from contextlib import contextmanager
from queue import Empty, Queue
from threading import Thread
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, run_headless
from harness.paths import FAUX_EXTENSION, pi_command
from harness.pinned import pinned_checkout
from harness.quota import fixture_env
from harness.sandbox import enable_faux_models, local_overrides_from_env
from harness.session_kit import kit_args
from scenarios.integration.test_session_kit_goal import goal_states, nudges

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

QUOTA_ERROR = "insufficient_quota: You exceeded your current quota"
CHAIN = ["spike-a/sonnet-a", "spike-b/terra-b"]


def extensions(box: Sandbox, fixture: str, *, kit_first: bool = False, children: bool = False) -> list[str]:
    """Load the quota seed first, then the real router and kit in either hook order.

    Parameters:
        box (Sandbox): isolated settings used to resolve pins.
        fixture (str): router e2e fixture filename.
        kit_first (bool): register kit settle hooks before the router's hooks.
        children (bool): load the real subagent admission client too.

    Returns:
        list[str]: explicit extensions, with configured package loading disabled.
    """
    packages = box.settings().get("packages", [])
    overrides = local_overrides_from_env()
    router = pinned_checkout("pi-subscription-router", packages, overrides)
    assert (router / "e2e" / fixture).is_file(), f"Missing quota fixture: '{router / 'e2e' / fixture}'"
    kit = kit_args(box, explicit=True)
    routed = ["-e", str(router / "src" / "index.ts")]
    args = ["--no-extensions", "-e", str(router / "e2e" / fixture)]
    if children:
        subagents = pinned_checkout("pi-subagents", packages, overrides)
        args += ["-e", str(subagents / "src" / "index.ts")]
    return args + (kit + routed if kit_first else routed + kit)


def profile(box: Sandbox, chain: list[str], policy: str = "wait") -> None:
    """Replace only sandbox router profiles with an all-faux chain.

    Parameters:
        box (Sandbox): isolated agent directory.
        chain (list[str]): faux physical model refs.
        policy (str): router admission exhaustion policy.
    """
    (box.agent_dir / "subscription-router.json").write_text(
        json.dumps(
            {"profiles": {"spike": {"chain": [{"model": m} for m in chain], "exhaustionPolicy": policy}}}
        )
    )


def assistants(result: RunResult) -> list[dict[str, Any]]:
    """Return settled physical assistant messages, including quota errors.

    Parameters:
        result (RunResult): recorded pi events.

    Returns:
        list[dict[str, Any]]: assistant messages in order.
    """
    return [e["message"] for e in result.of_type("message_end") if e["message"].get("role") == "assistant"]


@pytest.mark.parametrize("kit_first", [False, True], ids=["router-first", "kit-first"])
def test_settled_chain_exhaustion_pauses_goal_without_spin(sandbox: Sandbox, kit_first: bool) -> None:
    """A fresh quota confirmation exhausts the entire chain; no nudge or repeat request follows."""
    profile(sandbox, CHAIN[:1], "fail")
    result = run_headless(
        sandbox,
        {},
        ["/goal finish quota work --turns 10", "go"],
        model="router/spike",
        load_faux=False,
        extra_args=extensions(sandbox, "faux-quota.ext.ts", kit_first=kit_first),
        env={"SPIKE_ERROR": QUOTA_ERROR},
    )
    assert result.returncode == 0, result.transcript()
    messages = assistants(result)
    assert len(messages) == 2, result.transcript()
    assert [m["provider"] for m in messages] == ["spike-a", "spike-a"]
    assert messages[-1]["errorMessage"] == QUOTA_ERROR
    assert "usage.get spike-a -> confirmed=true" in result.stderr, result.transcript()
    assert len(result.of_type("agent_settled")) == 1, result.events
    assert nudges(sandbox) == []
    goal = goal_states(sandbox)[-1]
    assert goal is not None
    assert (goal["status"], goal["reason"], goal["turns"]) == ("paused", "provider error", 2), goal


@pytest.mark.parametrize(
    "error", [QUOTA_ERROR, "429 Too Many Requests: rate_limit_error"], ids=["settle", "retry"]
)
def test_router_recovery_owns_continuation_before_goal(sandbox: Sandbox, error: str) -> None:
    """Router recovery advances once, without a goal nudge on the failed quota boundary."""
    profile(sandbox, CHAIN)
    sandbox.patch_json("settings.json", {"retry": {"enabled": True, "maxRetries": 1, "baseDelayMs": 10}})
    result = run_headless(
        sandbox,
        {},
        ["/goal finish quota work --turns 4", "go"],
        model="router/spike",
        load_faux=False,
        extra_args=extensions(sandbox, "faux-quota.ext.ts"),
        env={"SPIKE_ERROR": error},
    )
    assert result.returncode == 0, result.transcript()
    messages = assistants(result)
    assert [m["provider"] for m in messages] == ["spike-a", "spike-a", "spike-b", "spike-b"], (
        result.transcript()
    )
    assert messages[1]["errorMessage"] == error
    assert "usage.get spike-a -> confirmed=true" in result.stderr, result.transcript()
    assert len(result.of_type("auto_retry_start")) == (1 if error.startswith("429") else 0), result.events
    assert len(nudges(sandbox)) == 1, nudges(sandbox)
    # Both recovered calls have the same user count only until the successful settle:
    # the first sees the original user + tool result, never a premature goal nudge.
    roles = [line for line in result.stderr.splitlines() if "spike-b request roles:" in line]
    assert len(roles) == 2, result.stderr
    assert roles[0].split("roles: ")[1].split(",").count("user") == 1, roles
    assert roles[1].split("roles: ")[1].split(",").count("user") == 2, roles
    goal = goal_states(sandbox)[-1]
    assert goal is not None
    assert (goal["status"], goal["turns"]) == ("budget", 4), goal


class Rpc:
    """Bounded JSON RPC reader; stdout is drained even while timers are being observed."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        """Attach a queue reader to a running faux pi process.

        Parameters:
            process (subprocess.Popen[str]): process with piped stdout/stdin.
        """
        self.process = process
        self.events: list[dict[str, Any]] = []
        self.queue: Queue[dict[str, Any]] = Queue()
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        """Drain JSON stdout until process exit; non-JSON diagnostics are not RPC events."""
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                self.queue.put(event)

    def wait(self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 30) -> dict[str, Any]:
        """Collect events until a predicate matches, with an absolute deadline.

        Parameters:
            predicate (Callable[[dict[str, Any]], bool]): matching event condition.
            timeout (float): maximum seconds.

        Returns:
            dict[str, Any]: matched event.
        """
        for event in self.events:
            if predicate(event):
                return event
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.queue.get(timeout=max(0.001, deadline - time.monotonic()))
            except Empty:
                break
            self.events.append(event)
            if predicate(event):
                return event
        pytest.fail(f"RPC deadline expired; exit={self.process.poll()}, events={self.events}")

    def command(self, text: str) -> None:
        """Execute an actual extension slash command and await RPC acknowledgement.

        Parameters:
            text (str): command including slash.
        """
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"id": text, "type": "prompt", "message": text}) + "\n")
        self.process.stdin.flush()
        reply = self.wait(lambda e: e.get("type") == "response" and e.get("id") == text)
        assert reply.get("success"), reply

    def observe(self, seconds: float) -> None:
        """Drain all events for a fixed observation window, including several real timer ticks.

        Parameters:
            seconds (float): duration to observe.
        """
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                self.events.append(self.queue.get(timeout=max(0.001, deadline - time.monotonic())))
            except Empty:
                break
        assert self.process.poll() is None, self.events


@contextmanager
def rpc(box: Sandbox, args: list[str], model: str, env: dict[str, str]) -> Iterator[Rpc]:
    """Keep a real RPC session alive, then terminate it without leaking parked children.

    Parameters:
        box (Sandbox): isolated home.
        args (list[str]): explicit extension flags.
        model (str): faux or faux-chain virtual model.
        env (dict[str, str]): fixture settings.

    Yields:
        Rpc: live client.
    """
    stderr_path = box.root / "quota-rpc.stderr"
    with stderr_path.open("w") as stderr:
        process = subprocess.Popen(
            [*pi_command(), *args, "--model", model, "--mode", "rpc"],
            cwd=box.workdir,
            env=box.env(fixture_env(None, {30_000: 500}) | env),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )
        client = Rpc(process)
        try:
            yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            client.reader.join(timeout=5)
            if process.stdin is not None:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()


def test_live_loop_and_goal_pause_after_confirmed_quota_failure(sandbox: Sandbox) -> None:
    """Leave the session alive after exhaustion: neither loop ticks nor goal wake restart it."""
    profile(sandbox, CHAIN[:1], "fail")
    with rpc(
        sandbox, extensions(sandbox, "faux-quota.ext.ts"), "router/spike", {"SPIKE_ERROR": QUOTA_ERROR}
    ) as client:
        client.command("/loop 30s quota-loop --max 10")
        client.command("/goal finish quota work --turns 10")
        client.wait(lambda e: e.get("type") == "agent_settled")
        client.observe(5)
        client.command("/loop list")
        listing = client.wait(
            lambda e: e.get("type") == "extension_ui_request" and "0/10 runs" in e.get("message", "")
        )
        assert "paused: provider error" in listing["message"], listing
        assert len([e for e in client.events if e.get("type") == "agent_start"]) == 1, client.events
        assert nudges(sandbox) == []
        goal = goal_states(sandbox)[-1]
        assert goal is not None
        assert (goal["status"], goal["reason"]) == ("paused", "provider error"), goal
    assert "usage.get spike-a -> confirmed=true" in (sandbox.root / "quota-rpc.stderr").read_text()


@pytest.mark.parametrize("policy", ["wait", "fail"])
def test_goal_and_loop_do_not_duplicate_router_dispatch_wait(sandbox: Sandbox, policy: str) -> None:
    """A real Agent is parked/refused by router admission; kit never creates a second dispatch."""
    profile(sandbox, CHAIN, policy)
    args = [*extensions(sandbox, "faux-admission.ext.ts", children=True), "-e", str(FAUX_EXTENSION)]
    enable_faux_models(sandbox, [*CHAIN, "router/spike", "faux/main"])
    # The router's driver fixture has only two responses. Use the harness driver
    # instead so a spurious nudge cannot be masked by script exhaustion errors.
    script_path = sandbox.root / "admission-driver.json"
    script_path.write_text(
        json.dumps(
            {
                "providers": {
                    "faux": {
                        "models": ["main"],
                        "steps": [
                            {
                                "tools": [
                                    {
                                        "name": "Agent",
                                        "args": {
                                            "subagent_type": "general-purpose",
                                            "description": "quota admission",
                                            "prompt": "say hi",
                                            "model": "router/spike",
                                            "run_in_background": True,
                                        },
                                    }
                                ]
                            },
                            {"text": "ADMISSION SETTLED"},
                            {"text": "SHOULD NOT CONTINUE AFTER QUOTA ADMISSION"},
                        ],
                    }
                }
            }
        )
    )
    with rpc(
        sandbox, args, "faux/main", {"SPIKE_BLOCKED": "1", "HARNESS_SCRIPT": str(script_path)}
    ) as client:
        client.command("/loop 30s quota-loop --max 10")
        client.command("/goal wait for quota work --turns 10")
        client.wait(lambda e: e.get("type") == "agent_settled")
        client.observe(5)
        tools = [
            e for e in client.events if e.get("type") == "tool_execution_end" and e.get("toolName") == "Agent"
        ]
        assert len(tools) == 1, client.events
        text = str(tools[0]["result"])
        assert ("Queued" if policy == "wait" else "was not started") in text, text
        assert "ANSWERED on spike-b" not in str(client.events), client.events
        assert nudges(sandbox) == [], f"Goal duplicated router-owned quota waiting: {nudges(sandbox)}"
        assert "SHOULD NOT CONTINUE" not in str(client.events), client.events
        goal = goal_states(sandbox)[-1]
        assert goal is not None
        reason = "quota parked" if policy == "wait" else "quota refused"
        assert (goal["status"], goal["reason"]) == ("paused", reason), goal
        assert len([e for e in client.events if e.get("type") == "agent_start"]) == 1, client.events
        client.command("/loop list")
        listing = client.wait(
            lambda e: e.get("type") == "extension_ui_request" and "0/10 runs" in e.get("message", "")
        )
        assert f"paused: {reason}" in listing["message"], listing
        if policy == "wait":
            client.command("/goal resume")
            client.command("/loop resume all")
            client.observe(5)
            refused = [e for e in client.events if "quota dispatch is still parked" in e.get("message", "")]
            assert len(refused) == 2, client.events
            assert nudges(sandbox) == []
            assert len([e for e in client.events if e.get("type") == "agent_start"]) == 1, client.events
