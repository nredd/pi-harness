"""Live tier: real providers through `router/default`, opt-in with `HARNESS_LIVE=1` (`make verify-live`).

No faux provider is loaded. Credentials are symlinked from the real home (`harness/live.py`).
Every run is charged to a session-wide ledger summing `usage.cost.total`; the tier fails once it
passes $0.50. Prompts are the cheapest that prove the path, at thinking `off`.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, run_headless
from harness.live import CostLedger, link_real_credentials, live_enabled

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from harness.sandbox import Sandbox

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not live_enabled(), reason="live tier: set HARNESS_LIVE=1 (`make verify-live`)"),
]

ROUTER = "router/default"
CHEAP_ARGS = ["--thinking", "off"]
TIMEOUT_S = 300.0
UNUSED_SCRIPT: dict[str, Any] = {"providers": {}}


@pytest.fixture(scope="session")
def ledger() -> Iterator[CostLedger]:
    """One spend ledger for the whole live session.

    Yields:
        CostLedger: shared ledger; its total is logged at teardown.
    """
    book = CostLedger()
    yield book
    print(f"\nLive spend: ${book.total:.4f} of ${book.cap_usd:.2f} {book.charges}")


@pytest.fixture
def live(sandbox: Sandbox, ledger: CostLedger, request: pytest.FixtureRequest) -> Callable[..., RunResult]:
    """Return a runner for real-provider headless pi, charging every run to the ledger.

    Parameters:
        sandbox (Sandbox): sandbox, rewired to real credentials.
        ledger (CostLedger): session spend ledger.
        request (pytest.FixtureRequest): names the charge.

    Returns:
        Callable[..., RunResult]: `run(prompt, **run_headless kwargs)`.
    """
    link_real_credentials(sandbox)

    def run(prompt: str, **kwargs: Any) -> RunResult:
        ledger.require_headroom()
        result = run_headless(
            sandbox,
            UNUSED_SCRIPT,
            [prompt],
            model=ROUTER,
            extra_args=CHEAP_ARGS,
            load_faux=False,
            timeout_s=TIMEOUT_S,
            **kwargs,
        )
        ledger.charge(request.node.name, result, sandbox)
        assert result.returncode == 0, result.transcript()
        return result

    return run


def answering_providers(result: RunResult) -> list[str]:
    """Return the physical provider of every finished assistant message.

    Parameters:
        result (RunResult): headless run.

    Returns:
        list[str]: providers in order.
    """
    return [
        str(event["message"].get("provider"))
        for event in result.of_type("message_end")
        if event.get("message", {}).get("role") == "assistant"
    ]


def test_anthropic_with_only_pi_credentials(sandbox: Sandbox, ledger: CostLedger) -> None:
    """A minimal native Anthropic request succeeds without a Claude credential store."""
    link_real_credentials(sandbox)
    assert not (sandbox.home / ".claude").exists()
    ledger.require_headroom()
    result = run_headless(
        sandbox,
        UNUSED_SCRIPT,
        ["Reply with exactly: OK"],
        model="anthropic/claude-haiku-4-5",
        extra_args=CHEAP_ARGS,
        load_faux=False,
        timeout_s=TIMEOUT_S,
    )
    ledger.charge("anthropic_with_only_pi_credentials", result, sandbox)
    assert result.returncode == 0, result.transcript()
    assert set(answering_providers(result)) == {"anthropic"}, result.transcript()
    assert result.assistant_texts()[-1].strip() == "OK", result.transcript()
    assert not (sandbox.home / ".claude").exists()


def test_anthropic_through_router_and_subscription_usage(live: Callable[..., RunResult]) -> None:
    """`router/default` answers on Anthropic (chain head) and `subscription_usage` reports windows."""
    result = live("Call the subscription_usage tool once with no arguments, then reply with exactly: OK")
    assert set(answering_providers(result)) == {"anthropic"}, result.transcript()
    usage = [outcome for outcome in result.tool_outcomes() if outcome.name == "subscription_usage"]
    assert usage, "the model never called `subscription_usage`\n" + result.transcript()
    assert not usage[0].is_error, usage[0].text
    assert "anthropic" in usage[0].text, usage[0].text
    assert "OK" in result.assistant_texts()[-1], result.transcript()


def test_codex_through_router(live: Callable[..., RunResult], sandbox: Sandbox) -> None:
    """With the Codex entry first in the `default` chain, `router/default` answers on Codex."""
    path = sandbox.agent_dir / "subscription-router.json"
    config = json.loads(path.read_text())
    chain = config["profiles"]["default"]["chain"]
    codex = next(entry for entry in chain if entry["model"].startswith("openai-codex/"))
    config["profiles"]["default"]["chain"] = [codex, *(entry for entry in chain if entry is not codex)]
    path.write_text(json.dumps(config, indent=2))

    result = live("Reply with exactly: OK")
    assert set(answering_providers(result)) == {"openai-codex"}, result.transcript()
    assert "OK" in result.assistant_texts()[-1], result.transcript()


def test_background_subagent(live: Callable[..., RunResult]) -> None:
    """A background `general-purpose` child runs on a real model and its result comes back."""
    result = live(
        "Call the Agent tool once with subagent_type general-purpose, run_in_background true, "
        "description 'live probe', and prompt 'Reply with exactly: CHILD OK'. Then call "
        "get_subagent_result with wait true for that agent. Then reply with exactly: DONE"
    )
    names = [outcome.name for outcome in result.tool_outcomes()]
    assert "Agent" in names, result.transcript()
    fetched = [outcome for outcome in result.tool_outcomes() if outcome.name == "get_subagent_result"]
    assert fetched, result.transcript()
    assert not fetched[-1].is_error, fetched[-1].text
    assert "CHILD OK" in fetched[-1].text, fetched[-1].text
