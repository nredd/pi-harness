"""Session-kit child identity survives real rename/reload and stays session-bound.

References:
- https://github.com/nredd/pi-session-kit
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from harness.headless import run_headless
from harness.sandbox import enable_faux_models
from harness.session_kit import kit_args

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("child", [True, False], ids=["renamed-child-reload", "parent-reload"])
def test_child_identity_reload(sandbox: Sandbox, child: bool) -> None:
    """Probe hidden registration and direct execution across an actual runtime reload.

    Parameters:
        sandbox (Sandbox): isolated pi runtime and persisted session.
        child (bool): bootstrap a generated child name or an ordinary parent name.
    """
    enable_faux_models(sandbox, ["faux/main"])
    args = kit_args(sandbox, explicit=True)
    kit = str(args[-1]).removesuffix("index.ts")
    fixture = sandbox.root / "child-identity.ts"
    fixture.write_text(
        f"""
import {{ register as goal }} from {json.dumps(kit + "goal/index.ts")};
import {{ register as monitor }} from {json.dumps(kit + "monitor/index.ts")};
import {{ defaultConfig }} from {json.dumps(kit + "config.ts")};
export default function(pi) {{
    const tools = new Map();
    const registerTool = pi.registerTool.bind(pi);
    pi.registerTool = (tool) => {{ tools.set(tool.name, tool); registerTool(tool); }};
    // Runs before the kit's identity hook only on initial binding, never after reload.
    pi.on("session_start", (_event, ctx) => {{
        if (!ctx.sessionManager.getBranch().some(e => e.customType === "harness:identity-start")) {{
            pi.setSessionName({json.dumps("general-purpose#deadbeef" if child else "ordinary parent")});
            pi.appendEntry("harness:identity-start", {{}});
        }}
    }});
    goal(pi, defaultConfig());
    monitor(pi, defaultConfig());
    pi.registerCommand("kit-rename", {{ handler: async () => pi.setSessionName("renamed session") }});
    pi.registerCommand("kit-reload", {{ handler: async (_args, ctx) => ctx.reload() }});
    pi.registerCommand("kit-probe", {{ handler: async (_args, ctx) => {{
        const names = ["goal_update", "monitor_start", "monitor_read", "monitor_stop"];
        pi.setActiveTools([...pi.getActiveTools(), ...names]);
        const report = {{ name: pi.getSessionName(), active: pi.getActiveTools(), tools: [] }};
        for (const name of names) {{
            const tool = tools.get(name);
            let denied = false;
            try {{
                const params = {{id: "missing", argv: [], name: "probe"}};
                await tool.execute("probe", params, undefined, undefined, ctx);
            }}
            catch (error) {{
                denied = String(error).includes("not available in subagents");
                // Allowed parent execution reaches goal's ordinary business-state validation.
                if (!denied && !(name === "goal_update" && String(error).includes("no active goal"))) {{
                    throw error;
                }}
            }}
            report.tools.push({{ name, hidden: tool.exposure === "hidden", denied }});
        }}
        pi.appendEntry("harness:identity-probe", report);
    }} }});
}}
"""
    )
    result = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": [{"text": "finished"}]}}},
        ["/kit-probe", "/kit-rename", "/kit-reload", "/kit-probe", "finish"],
        extra_args=["--no-extensions", "-e", str(fixture)],
    )
    assert result.returncode == 0, result.transcript()
    entries = [
        json.loads(line)
        for path in (sandbox.agent_dir / "sessions").rglob("*.jsonl")
        for line in path.read_text().splitlines()
        if line.strip()
    ]
    reports = [entry["data"] for entry in entries if entry.get("customType") == "harness:identity-probe"]
    assert len(reports) == 2, result.transcript()
    assert reports[1]["name"] == "renamed session"
    for report in reports:
        assert len(report["tools"]) == 4
        assert all(tool["hidden"] == child and tool["denied"] == child for tool in report["tools"])
        assert all((tool["name"] not in report["active"]) == child for tool in report["tools"])
    markers = [entry for entry in entries if entry.get("customType") == "session-kit:child"]
    assert len(markers) == int(child)
