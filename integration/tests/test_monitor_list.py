"""`monitor_list` reads the `/monitor` reply, not whichever notification came first.

A run that settles with a monitor running notifies `Run ended with 1 monitor running, armed: ...`
after `agent_end` (#292). `RpcProcess.prompt` returns at `agent_end`, so that notice is still queued
when the next command is sent.

References:
- https://github.com/nredd/pi-harness/issues/292
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from scenarios import test_monitor_lifetime as lifetime

if TYPE_CHECKING:
    from collections.abc import Callable

SETTLE = 'Run ended with 1 monitor running, armed: m1 "lifetime" on exit'
LISTING = 'm1 "lifetime" running 3s, 0 lines, pid 4242: /bin/sh -c /bin/sleep 7 & /bin/sleep 7'


def notify(message: str) -> dict[str, Any]:
    """Build an RPC notify request as Pi writes it.

    Parameters:
        message (str): notification text.

    Returns:
        dict[str, Any]: `extension_ui_request` record.
    """
    return {"type": "extension_ui_request", "id": f"ui-{message[:8]}", "method": "notify", "message": message}


class ScriptedOwner:
    """Replays stdout records in order; sends are recorded and answered by a matching `response`."""

    def __init__(
        self, before: list[dict[str, Any]], reply: list[dict[str, Any]], *, success: bool = True
    ) -> None:
        """Queue records already on stdout and the ones the command produces.

        Parameters:
            before (list[dict[str, Any]]): records written before the command was sent.
            reply (list[dict[str, Any]]): records the command writes before its response.
            success (bool): the command response's `success`.
        """
        self.before = before
        self.reply = reply
        self.success = success
        self.sent: list[dict[str, Any]] = []
        self.queue: list[dict[str, Any]] = list(before)

    def send(self, command: dict[str, Any]) -> None:
        """Record a command and append what Pi writes for it.

        Parameters:
            command (dict[str, Any]): RPC command.
        """
        self.sent.append(command)
        response = {"type": "response", "id": command.get("id"), "command": "prompt", "success": self.success}
        self.queue += [*self.reply, response]

    def receive(self, predicate: Callable[[dict[str, Any]], bool], timeout_s: float = 60) -> dict[str, Any]:
        """Consume records in order until one matches, like `RpcProcess.receive`.

        Parameters:
            predicate (Callable[[dict[str, Any]], bool]): desired record.
            timeout_s (float): unused, the script is finite.

        Returns:
            dict[str, Any]: matching record.

        Raises:
            AssertionError: the script ran out first.
        """
        del timeout_s
        while self.queue:
            event = self.queue.pop(0)
            if predicate(event):
                return event
        raise AssertionError("RPC deadline waiting for event")


def test_skips_a_settle_notice_queued_before_the_command() -> None:
    """The CI failure: the settle notice is first on stdout, the listing comes after it."""
    owner = ScriptedOwner([{"type": "agent_end"}, notify(SETTLE)], [notify(LISTING)])
    assert lifetime.monitor_list(owner) == LISTING
    assert [command["message"] for command in owner.sent] == ["/monitor"]


def test_reads_an_empty_listing() -> None:
    """`no monitors` is the whole reply for an owner with none."""
    owner = ScriptedOwner([], [notify("no monitors")])
    assert lifetime.monitor_list(owner) == "no monitors"


def test_refuses_a_command_without_a_listing() -> None:
    """A response with no listing fails loudly instead of returning the settle notice."""
    owner = ScriptedOwner([notify(SETTLE)], [])
    with pytest.raises(AssertionError, match="exactly one /monitor listing"):
        lifetime.monitor_list(owner)


def test_refuses_a_failed_command() -> None:
    """An unsuccessful `/monitor` response is not read as a listing."""
    owner = ScriptedOwner([], [notify("no monitors")], success=False)
    with pytest.raises(AssertionError, match="success"):
        lifetime.monitor_list(owner)
