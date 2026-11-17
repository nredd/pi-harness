"""Live tier helpers: real credentials by symlink, and a hard cost cap.

Credentials are SYMLINKED from the real home, never copied, so a token pi refreshes in the
sandbox is written through to the real file (`writeFileSync` follows the link) and no copy of a
secret is left in a temp dir. Anthropic runs on pi's native OAuth in `auth.json`; nothing under
`~/.claude` is read or linked.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from harness.headless import RunResult
    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)

LIVE_ENV = "HARNESS_LIVE"
COST_CAP_USD = 0.50


def live_enabled() -> bool:
    """Report whether the live tier was requested.

    Returns:
        bool: True when `HARNESS_LIVE=1`.
    """
    return os.environ.get(LIVE_ENV) == "1"


def link_real_credentials(box: Sandbox) -> None:
    """Replace the sandbox's fake `auth.json` with a symlink to the real one.

    Parameters:
        box (Sandbox): sandbox to wire to real providers.

    Raises:
        FileNotFoundError: the real `auth.json` does not exist.
    """
    supplied = os.environ.get("HARNESS_AUTH_FILE")
    if not supplied:
        raise ValueError(
            "Live runs require explicit `HARNESS_AUTH_FILE`; default credentials are never discovered"
        )
    real_auth = Path(supplied).resolve()
    if not real_auth.is_file():
        raise FileNotFoundError(f"No real credentials at '{real_auth}'")
    sandbox_auth = box.agent_dir / "auth.json"
    sandbox_auth.unlink(missing_ok=True)
    sandbox_auth.symlink_to(real_auth)
    LOGGER.info(f"Linked real credentials into '{box.home}'")


def message_cost(message: dict[str, Any]) -> float:
    """Return an assistant message's `usage.cost.total`.

    Parameters:
        message (dict[str, Any]): message object.

    Returns:
        float: priced USD subtotal. Consult `message_unpriced_calls` for unknown spend.
    """
    if message.get("role") != "assistant":
        return 0.0
    cost = (message.get("usage") or {}).get("cost") or {}
    return float(cost.get("total") or 0.0)


def message_unpriced_calls(message: dict[str, Any]) -> int:
    """Count unpriced assistant requests, preserving aggregate counts from core.

    Parameters:
        message (dict[str, Any]): recorded message object.

    Returns:
        int: unpriced request count, zero for unmarked or non-assistant records.
    """
    if message.get("role") != "assistant":
        return 0
    cost = (message.get("usage") or {}).get("cost") or {}
    return int(cost.get("unpricedCalls", 1)) if cost.get("unpriced") else 0


def event_cost(result: RunResult) -> float:
    """Sum the cost of every finished assistant message in a run's JSON events.

    Parameters:
        result (RunResult): headless run.

    Returns:
        float: USD.
    """
    return sum(message_cost(event.get("message") or {}) for event in result.of_type("message_end"))


def session_cost(agent_dir: Path, *, unpriced: bool = False) -> float:
    """Sum assistant cost over every session file under an agent dir, child sessions included.

    Symlinked extension dirs are not followed.

    Parameters:
        agent_dir (Path): sandbox agent dir.
        unpriced (bool): count unpriced calls instead of the priced USD subtotal.

    Returns:
        float: USD subtotal or unpriced request count.
    """
    total = 0.0
    for path in agent_dir.rglob("*.jsonl"):
        for line in path.read_text(errors="replace").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and entry.get("type") == "message":
                message = entry.get("message") or {}
                total += message_unpriced_calls(message) if unpriced else message_cost(message)
    return total


@dataclass
class CostLedger:
    """Running spend across the live session, failing once it passes the cap.

    Attributes:
        cap_usd (float): hard limit.
        charges (dict[str, float]): test name -> priced USD subtotal.
        unpriced_calls (dict[str, int]): test name -> requests whose spend is unknown.
    """

    cap_usd: float = COST_CAP_USD
    charges: dict[str, float] = field(default_factory=dict)
    unpriced_calls: dict[str, int] = field(default_factory=dict)

    @property
    def unpriced(self) -> int:
        """Requests whose spend is unknown, not zero."""
        return sum(self.unpriced_calls.values())

    @property
    def total(self) -> float:
        """USD spent so far."""
        return sum(self.charges.values())

    def require_headroom(self) -> None:
        """Fail before spending more once the cap is reached.

        Raises:
            AssertionError: the session has unknown spend or already reached `cap_usd`.
        """
        assert not self.unpriced, f"Live spend unknown: {self.unpriced} unpriced calls"
        assert self.total < self.cap_usd, f"Live spend ${self.total:.4f} reached the ${self.cap_usd:.2f} cap"

    def charge(self, name: str, result: RunResult, box: Sandbox) -> float:
        """Record a run's cost and fail when the session total passes the cap.

        The JSON events carry the main session; session files also carry child agents. The
        larger of the two is charged so neither source can hide spend.

        Parameters:
            name (str): test name.
            result (RunResult): the run.
            box (Sandbox): sandbox it ran in.

        Returns:
            float: USD charged for this run.

        Raises:
            AssertionError: the session has unknown spend or exceeds `cap_usd`.
        """
        cost = max(event_cost(result), session_cost(box.agent_dir))
        unpriced = max(
            sum(
                message_unpriced_calls(event.get("message") or {}) for event in result.of_type("message_end")
            ),
            int(session_cost(box.agent_dir, unpriced=True)),
        )
        self.unpriced_calls[name] = self.unpriced_calls.get(name, 0) + unpriced
        self.charges[name] = self.charges.get(name, 0.0) + cost
        if self.unpriced:
            LOGGER.warning(
                f"Live spend: '{name}' priced subtotal ${cost:.4f}, {self.unpriced} unpriced calls"
            )
        assert not self.unpriced, (
            f"Live spend unknown: {self.unpriced} unpriced calls; cap cannot be enforced"
        )
        LOGGER.warning(f"Live spend: '{name}' ${cost:.4f}, session ${self.total:.4f} of ${self.cap_usd:.2f}")
        assert self.total <= self.cap_usd, f"Live spend ${self.total:.4f} passed the ${self.cap_usd:.2f} cap"
        return cost
