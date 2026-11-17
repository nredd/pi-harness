"""Real native-adapter cold-start and one built-in read-only child wire ledger.

References:
- https://github.com/nredd/pi-harness/issues/1004
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from harness.anthropic_mock import AUTH_GUARD_EXTENSION, AnthropicMock, anthropic_env
from harness.headless import run_headless
from harness.paths import ARTIFACTS_DIR, REPO_ROOT
from harness.request_ledger import request_ledger
from harness.sandbox import build_sandbox

if TYPE_CHECKING:
    from harness.anthropic_mock import RecordedRequest
    from harness.request_ledger import Ledger
    from harness.sandbox import Sandbox

LOGGER = logging.getLogger(__name__)
pytestmark = pytest.mark.stack
ISO_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
MODEL = "anthropic/claude-haiku-4-5"


def _capture(box: Sandbox) -> tuple[list[RecordedRequest], list[dict[str, Any]]]:
    """Run the actual installed stack and one built-in child through the native adapter.

    Parameters:
        box (Sandbox): isolated copy of the explicitly supplied stack.

    Returns:
        tuple[list[RecordedRequest], list[dict[str, Any]]]: ordered wire calls and parent registries.
    """
    (box.agent_dir / "auth.json").write_text(
        json.dumps({"anthropic": {"type": "api_key", "key": "harness-fake-key"}})
    )
    box.patch_json("settings.json", {"enabledModels": [MODEL]})
    box.patch_json(
        "subagents.json", {"packageAgents": False, "agentModels": {}, "modelTiers": {}, "maxSubagentDepth": 2}
    )
    registry = box.root / "registry.jsonl"
    call = {
        "name": "Agent",
        "input": {
            "subagent_type": "Explore",
            "description": "ledger child",
            "prompt": "Return a concise ledger child reply, do not call tools.",
            "model": MODEL,
            "run_in_background": False,
        },
    }
    with AnthropicMock(message_tools=[call]) as mock:
        result = run_headless(
            box,
            {},
            ["Spawn exactly one ledger child."],
            model=MODEL,
            load_faux=False,
            extra_args=[
                "--no-approve",
                "--thinking",
                "off",
                "-e",
                str(AUTH_GUARD_EXTENSION),
                "-e",
                str(REPO_ROOT / "probes/request-ledger.ts"),
            ],
            env=anthropic_env(mock, box) | {"HARNESS_LEDGER_REGISTRY": str(registry)},
        )
    assert result.returncode == 0, result.transcript()
    outcomes = [outcome for outcome in result.tool_outcomes() if outcome.name == "Agent"]
    assert len(outcomes) == 1, result.transcript()
    assert not outcomes[0].is_error, result.transcript()
    assert len(mock.messages) == 3, result.transcript()
    body = mock.messages[1].body
    assert isinstance(body, dict)
    offered = {tool["name"] for tool in body["tools"]}
    assert {"read", "grep", "find", "ls"} <= offered
    assert offered <= {"read", "grep", "find", "ls", "SubagentWorkflow"}
    evidence = [json.loads(line) for line in registry.read_text().splitlines()]
    assert len(evidence) == 2, evidence
    return mock.messages, evidence


def _normalized(value: str, box: Sandbox) -> str:
    """Normalize only sandbox/workspace locations and absolute ISO timestamps."""
    value = value.replace(str(box.root), "/sandbox").replace(
        str(Path(__file__).resolve().parents[3]), "/workspace"
    )
    return ISO_TIME.sub("2000-01-01T00:00:00.000Z", value)


def _measure(box: Sandbox, run: int) -> tuple[list[dict[str, Any]], list[Ledger]]:
    """Build additive original ledgers and separately normalized comparison ledgers.

    Parameters:
        box (Sandbox): isolated installed stack.
        run (int): artifact run number.

    Returns:
        tuple[list[dict[str, Any]], list[Ledger]]: original rows and normalized comparison.
    """
    requests, evidence = _capture(box)
    rows: list[dict[str, Any]] = []
    stable_rows: list[Ledger] = []
    for index, request in enumerate(requests):
        child = index == 1
        metadata = {} if child else evidence[0 if index == 0 else 1]
        owners = {tool["name"]: tool["sourceInfo"]["source"] for tool in metadata.get("tools", [])}
        provenance = metadata.get("provenance", {})
        ledger = request_ledger(
            request.raw_body,
            owners=owners,
            provenance=provenance,
            previous=requests[index - 1].raw_body if index else None,
            parent=requests[0].raw_body if child else None,
        )
        assert sum(ledger["buckets"].values()) == len(request.raw_body.encode())
        rows.append(
            {
                "run": run,
                "session": "child" if child else "parent",
                "request": index,
                **ledger,
                "synthetic": {"provider": "loopback", "usage": "scripted, excluded from byte totals"},
            }
        )
        stable = _normalized(request.raw_body, box)
        stable_rows.append(
            request_ledger(
                stable,
                owners={name: _normalized(owner, box) for name, owner in owners.items()},
                provenance={_normalized(value, box): category for value, category in provenance.items()},
                previous=_normalized(requests[index - 1].raw_body, box) if index else None,
                parent=_normalized(requests[0].raw_body, box) if child else None,
            )
        )
    return rows, stable_rows


def test_cold_stack_and_explicit_child_ledger(
    tmp_path: Path, template_home: Path, request: pytest.FixtureRequest
) -> None:
    """Assert exact sums and deterministic normalized ledgers for two actual cold starts.

    Parameters:
        tmp_path (Path): per-test scratch.
        template_home (Path): explicitly installed full stack, with its declared exclusions.
        request (pytest.FixtureRequest): explicit runtime artifact identity.
    """
    first, normalized_first = _measure(build_sandbox(tmp_path / "run-0", template_home), 0)
    second, normalized_second = _measure(build_sandbox(tmp_path / "run-1", template_home), 1)
    stack = (template_home / ".pi/agent/stack-name").read_text().strip()
    runtime = request.config.getoption("--runtime")
    destination = ARTIFACTS_DIR / f"request-ledger-{stack}-{runtime}.jsonl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("".join(json.dumps(line, sort_keys=True) + "\n" for line in [*first, *second]))
    assert normalized_first == normalized_second
    cold = first[0]
    LOGGER.info(
        f"Cold-start request: {cold['request_bytes']} bytes; buckets={cold['buckets']}; "
        f"bytes only, no offline vocabulary. Ledger: {destination}"
    )
