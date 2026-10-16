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
from typing import TYPE_CHECKING, Any

from harness.paths import LIVE_AGENT_DIR

if TYPE_CHECKING:
    from pathlib import Path

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
    real_auth = LIVE_AGENT_DIR / "auth.json"
    if not real_auth.is_file():
        raise FileNotFoundError(f"No real credentials at '{real_auth}'; log in with `pi` first")
    sandbox_auth = box.agent_dir / "auth.json"
    sandbox_auth.unlink(missing_ok=True)
    sandbox_auth.symlink_to(real_auth)
    LOGGER.info(f"Linked real credentials into '{box.home}'")


def message_cost(message: dict[str, Any]) -> float:
    """Return an assistant message's `usage.cost.total`.

    Parameters:
        message (dict[str, Any]): message object.

    Returns:
        float: cost in USD; 0 for non-assistant or unpriced messages.
    """
    if message.get("role") != "assistant":
        return 0.0
    cost = (message.get("usage") or {}).get("cost") or {}
    return float(cost.get("total") or 0.0)


def event_cost(result: RunResult) -> float:
    """Sum the cost of every finished assistant message in a run's JSON events.

    Parameters:
        result (RunResult): headless run.

    Returns:
        float: USD.
    """
    return sum(message_cost(event.get("message") or {}) for event in result.of_type("message_end"))


def session_cost(agent_dir: Path) -> float:
    """Sum assistant cost over every session file under an agent dir, child sessions included.

    Symlinked extension dirs are not followed.

    Parameters:
        agent_dir (Path): sandbox agent dir.

    Returns:
        float: USD.
    """
    total = 0.0
    for path in agent_dir.rglob("*.jsonl"):
        for line in path.read_text(errors="replace").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict) and entry.get("type") == "message":
                total += message_cost(entry.get("message") or {})
    return total


@dataclass
class CostLedger:
    """Running spend across the live session, failing once it passes the cap.

    Attributes:
        cap_usd (float): hard limit.
        charges (dict[str, float]): test name -> USD.
    """

    cap_usd: float = COST_CAP_USD
    charges: dict[str, float] = field(default_factory=dict)

    @property
    def total(self) -> float:
        """USD spent so far."""
        return sum(self.charges.values())

    def require_headroom(self) -> None:
        """Fail before spending more once the cap is reached.

        Raises:
            AssertionError: the session total already reached `cap_usd`.
        """
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
            AssertionError: the session total exceeds `cap_usd`.
        """
        cost = max(event_cost(result), session_cost(box.agent_dir))
        self.charges[name] = self.charges.get(name, 0.0) + cost
        LOGGER.warning(f"Live spend: '{name}' ${cost:.4f}, session ${self.total:.4f} of ${self.cap_usd:.2f}")
        assert self.total <= self.cap_usd, f"Live spend ${self.total:.4f} passed the ${self.cap_usd:.2f} cap"
        return cost
