import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { classifyPlanModeTool, findBlockedSshExecCall, isAnnotatedReadOnlyTool } from "../src/tool-policy.js";
import { defaultPlanModeToolNames, toolPolicyLabel } from "../src/tool-selection.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

function annotated(name: string, readOnlyHint?: boolean) {
  return { ...extensionTool(name), annotations: { readOnlyHint } } as ToolInfo;
}

test("extension tools that declare readOnlyHint classify as read-only", () => {
  assert.equal(isAnnotatedReadOnlyTool(annotated("git_status", true)), true);
  assert.equal(classifyPlanModeTool(annotated("git_status", true)), "read-only");
  assert.equal(toolPolicyLabel(annotated("git_status", true)), "read-only (annotated)");
  // Only an explicit true counts; mutating tools stay unannotated and opt-in.
  assert.equal(classifyPlanModeTool(annotated("git_commit", false)), "user-opt-in");
  assert.equal(classifyPlanModeTool(annotated("git_commit", undefined)), "user-opt-in");
  assert.equal(classifyPlanModeTool(extensionTool("plain") as ToolInfo), "user-opt-in");
  // Built-ins keep their own policy regardless of annotations.
  assert.equal(
    classifyPlanModeTool({ ...builtinTool("write"), annotations: { readOnlyHint: true } } as ToolInfo),
    "blocked",
  );
  assert.equal(toolPolicyLabel(builtinTool("read") as ToolInfo), "built-in read-only");
  // Native MCP and other built-in extensions keep needing explicit opt-in; their hints are third-party.
  assert.equal(
    classifyPlanModeTool({
      ...builtinTool("mcp__docs__read"),
      sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level", path: "builtin:mcp" },
      annotations: { readOnlyHint: true },
    } as ToolInfo),
    "user-opt-in",
  );
  // Package-installed extensions carry their package source string, not "extension".
  assert.equal(
    classifyPlanModeTool({
      ...extensionTool("py_test"),
      sourceInfo: { source: "git:github.com/nredd/pi-dev-tools@v0.2.0", scope: "user", origin: "package", path: "/x" },
      annotations: { readOnlyHint: true },
    } as ToolInfo),
    "read-only",
  );
  // Missing source metadata is never trusted, annotation or not.
  assert.equal(classifyPlanModeTool({ name: "x", annotations: { readOnlyHint: true } } as ToolInfo), "blocked");
});

test("annotated read-only tools are admitted by default alongside configured defaultPlanTools", () => {
  const tools = [
    builtinTool("read"),
    builtinTool("bash"),
    annotated("git_status", true),
    annotated("git_commit", false),
  ] as ToolInfo[];
  assert.deepEqual(defaultPlanModeToolNames(tools, undefined), ["read", "bash", "git_status"]);
  assert.deepEqual(defaultPlanModeToolNames(tools, ["read", "ls"]), ["read", "ls", "git_status"]);
  assert.deepEqual(defaultPlanModeToolNames(tools, ["git_status"]), ["git_status"]);
});

test("ssh_exec is gated on a configured host and the remote reviewed policy", () => {
  const safe = { ssh: ["home", "nas"] };
  assert.equal(findBlockedSshExecCall({ host: "home", command: "ls /config" }, safe), undefined);
  assert.equal(
    findBlockedSshExecCall({ host: "home", command: "ha core check" }, { ssh: ["home"], ha: ["core check"] }),
    undefined,
  );
  assert.match(findBlockedSshExecCall({ host: "evil", command: "ls" }, safe) ?? "", /not a configured ssh prefix/);
  assert.match(findBlockedSshExecCall({ command: "ls" }, safe) ?? "", /host is required/);
  assert.match(findBlockedSshExecCall({ host: "home", command: "rm -rf ~" }, safe) ?? "", /remote command: rm -rf ~/);
  assert.match(findBlockedSshExecCall({ host: "home", command: "ls; rm x" }, safe) ?? "", /remote command: rm x/);
  assert.match(
    findBlockedSshExecCall({ host: "home", command: "cd /config && ls" }, safe) ?? "",
    /remote command: cd \/config/,
  );
  assert.match(findBlockedSshExecCall({ host: "home", command: "" }, safe) ?? "", /remote command: \(empty command\)/);
  assert.match(findBlockedSshExecCall({ host: "home", command: "ls $(id)" }, safe) ?? "", /remote command/);
  assert.match(findBlockedSshExecCall({ host: "home" }, {}) ?? "", /not a configured ssh prefix/);
});

test("active Plan mode admits annotated tools and gates ssh_exec at the tool hook", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "plan-annotated-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await writeFile(join(agentDir, "pi-plan-mode.json"), JSON.stringify({ safeSubcommands: { ssh: ["home"] } }));
    const mock = createMockPi({
      activeTools: ["read", "git_status", "git_commit", "ssh_exec"],
      allTools: [
        builtinTool("read"),
        annotated("git_status", true),
        annotated("git_commit", false),
        annotated("ssh_exec", true),
      ],
    });
    planMode(mock.pi);
    const context = createMockContext();
    const hook = mock.events.get("tool_call")?.[0];
    assert.ok(hook);
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);

    assert.equal(await hook({ toolName: "git_status", input: {} }, context.ctx), undefined);
    assert.match(
      (await hook({ toolName: "git_commit", input: {} }, context.ctx))?.reason ?? "",
      /not selected by the Plan policy/,
    );
    assert.equal(
      await hook({ toolName: "ssh_exec", input: { host: "home", command: "ls /config" } }, context.ctx),
      undefined,
    );
    for (const [input, expected] of [
      [{ host: "home", command: "rm -rf ~" }, /Blocked: remote command: rm -rf ~/],
      [{ host: "home", command: "ls; rm x" }, /Blocked: remote command: rm x/],
      [{ host: "evil", command: "ls" }, /not a configured ssh prefix/],
    ] as const) {
      const result = await hook({ toolName: "ssh_exec", input }, context.ctx);
      assert.equal(result?.block, true, JSON.stringify(input));
      assert.match(result?.reason ?? "", /^Plan mode blocks ssh_exec/);
      assert.match(result?.reason ?? "", expected);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});
