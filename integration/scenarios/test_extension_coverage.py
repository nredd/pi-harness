"""Behavioral canaries for third-party extensions in the installed, declared stack.

References:
- https://github.com/nredd/pi-harness/blob/main/integration/README.md
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import run_headless
from harness.stack import find_package, load_stack, package_manifest

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack
INVENTORY = Path(__file__).resolve().parents[1] / "providers/extension_inventory.ts"


def test_installed_extension_behavior(sandbox: Sandbox) -> None:
    """Exercise real memory, workflow and web tools after deferred discovery, without egress.

    Parameters:
        sandbox (Sandbox): stack installed by Pi from the selected stack document.
    """
    memory = sandbox.root / "memory"
    memory.mkdir()
    qmd = sandbox.shims_dir / "qmd"
    qmd.write_text("#!/bin/sh\nexit 1\n")
    qmd.chmod(0o700)
    sandbox.patch_json(
        "deferred-tools.json",
        {
            "alwaysActive": [
                "harness_extension_inventory",
                "search_tools",
                "memory_write",
                "memory_read",
                "fetch_content",
            ]
        },
    )
    sandbox.patch_json("web-search.json", {"allowBrowserCookies": False, "autoOpenBrowser": False})
    marker = "STACK-MEMORY-ROUNDTRIP"
    # Bound but not listening: a deterministic refused loopback connection, not a public URL
    # or a racy port chosen by closing a listener before the child starts.
    with socket.socket() as refused:
        refused.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{refused.getsockname()[1]}/offline"
        calls: list[dict[str, Any]] = [
            {"name": "harness_extension_inventory", "args": {}},
            {
                "name": "search_tools",
                "args": {"query": "workflow_control workflow runs list status", "kind": "tool"},
            },
            {"name": "workflow_control", "args": {"action": "list"}},
            {"name": "workflow_control", "args": {"action": "status", "runId": "missing-stack-run"}},
            {"name": "memory_write", "args": {"target": "long_term", "content": marker}},
            {"name": "memory_read", "args": {"target": "long_term"}},
            {"name": "memory_read", "args": {"target": "daily", "date": "../../outside"}},
            {"name": "fetch_content", "args": {"url": url, "mode": "raw", "proxy": ""}},
        ]
        script = {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        *({"tools": [call]} for call in calls),
                        {"text": "EXTENSIONS-SURVIVED"},
                    ],
                }
            }
        }
        result = run_headless(
            sandbox,
            script,
            ["exercise extensions"],
            extra_args=["--no-approve", "-e", str(INVENTORY)],
            env={"PI_MEMORY_DIR": str(memory), "PI_MEMORY_NO_SEARCH": "1", "PI_ALLOW_BROWSER_COOKIES": "0"},
        )
    assert result.returncode == 0, result.transcript()
    assert not result.stderr.strip(), result.transcript()
    assert not result.stdout_noise, result.transcript()
    outcomes = result.tool_outcomes()
    assert [outcome.name for outcome in outcomes] == [call["name"] for call in calls], result.transcript()
    registry = json.loads(outcomes[0].text)
    assert {
        "web_search",
        "fetch_content",
        "source_check",
        "get_search_content",
        "memory_read",
        "memory_write",
        "memory_search",
        "memory_forget",
        "memory_restore",
        "memory_status",
        "scratchpad",
        "workflow",
        "workflow_control",
        "search_tools",
    } <= set(registry["tools"])
    assert {
        "workflows",
        "workflows-trigger",
        "effort",
        "deferred",
        "websearch",
        "curator",
        "google-account",
        "search",
        "anthropic-auth:status",
    } <= set(registry["commands"])
    assert not outcomes[1].is_error, result.transcript()
    assert "workflow_control" in outcomes[1].text
    assert not outcomes[2].is_error
    assert "action=list result=ok runs=0" in outcomes[2].text
    # Upstream returns semantic failures in content/details, not the host isError flag.
    assert "result=error" in outcomes[3].text
    assert "run not found" in outcomes[3].text
    assert not outcomes[4].is_error
    assert "Appended to MEMORY.md" in outcomes[4].text
    assert not outcomes[5].is_error
    assert marker in outcomes[5].text
    assert marker in (memory / "MEMORY.md").read_text()
    assert outcomes[6].is_error
    assert "Invalid date format" in outcomes[6].text
    assert outcomes[7].is_error, result.transcript()
    assert "Tool fetch_content not found" not in outcomes[7].text
    assert outcomes[7].text.startswith("Error:"), outcomes[7].text
    failed = result.of_type("tool_execution_end")[-1]["result"]["details"]
    assert failed["urls"] == [url], failed
    assert failed["successful"] == 0, failed
    assert result.assistant_texts()[-1] == "EXTENSIONS-SURVIVED", result.transcript()


def test_computer_use_headless_exclusion(sandbox: Sandbox) -> None:
    """Require installed computer-use bytes but no discovered desktop capabilities or GUI app.

    Parameters:
        sandbox (Sandbox): private installed stack, including the reasoned exclusion.
    """
    packages = sandbox.settings()["packages"]
    directory = find_package("pi-computer-use", packages, sandbox.agent_dir)
    manifest = package_manifest(directory)
    assert manifest["pi"]["extensions"], manifest
    evidence = json.loads((sandbox.agent_dir / "stack-evidence.json").read_text())
    installed = next(item for item in evidence["packages"] if item["name"].endswith("pi-computer-use"))
    source = installed["source"]
    stack_path = Path(__file__).resolve().parents[1] / "stacks" / f"{evidence['stack']}.json"
    stack = load_stack(stack_path)
    original = next(
        declared
        for declared, resolved in zip(stack.sources, stack.resolved_sources(stack_path), strict=True)
        if resolved == source
    )
    assert evidence["disabled_extensions"].get(original), evidence
    assert {"source": source, "extensions": []} in packages
    sandbox.patch_json("deferred-tools.json", {"alwaysActive": ["harness_extension_inventory"]})
    script = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [
                    {"tools": [{"name": "harness_extension_inventory", "args": {}}]},
                    {"text": "HEADLESS-OK"},
                ],
            }
        }
    }
    result = run_headless(sandbox, script, ["inventory"], extra_args=["--no-approve", "-e", str(INVENTORY)])
    assert result.returncode == 0, result.transcript()
    assert not result.stderr.strip(), result.transcript()
    assert not result.stdout_noise, result.transcript()
    outcomes = result.tool_outcomes()
    assert len(outcomes) == 1, result.transcript()
    assert not outcomes[0].is_error, result.transcript()
    tools = set(json.loads(outcomes[0].text)["tools"])
    assert not tools & {"desktop_screenshot", "desktop_input", "act_ui", "look"}, tools
    assert not list((sandbox.home / "Applications").glob("*.app"))
    assert result.assistant_texts()[-1] == "HEADLESS-OK"
