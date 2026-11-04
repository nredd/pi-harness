import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createChildToolPolicy, PLAN_MODE_STATE_QUERY, type PlanModeStateSnapshot } from "../src/child-policy.js";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

function query(mock: ReturnType<typeof createMockPi>) {
  const replies: PlanModeStateSnapshot[] = [];
  mock.eventBus.emit(PLAN_MODE_STATE_QUERY, {
    version: 1,
    reply: (state: PlanModeStateSnapshot) => replies.push(state),
  });
  return replies;
}

function call(toolName: string, tool: unknown, input: unknown = {}) {
  return { toolName, input, cwd: "/repo", tool: tool as ToolInfo | undefined };
}

test("Plan mode answers state queries with a frozen child policy while planning", async () => {
  const mock = createMockPi({
    activeTools: ["read", "bash", "edit", "write"],
    allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("edit"), builtinTool("write")],
  });
  planMode(mock.pi);
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

  assert.deepEqual(query(mock), [{ version: 1, active: false, sessionId: "test-session" }]);

  await mock.commands.get("plan")?.handler("start", context.ctx);
  const [planning] = query(mock);
  assert.equal(planning?.active, true);
  assert.equal(planning?.sessionId, "test-session");
  const evaluate = planning?.evaluate;
  assert.ok(evaluate);

  assert.equal(
    evaluate(call("write", builtinTool("write"))),
    "Plan mode blocks mutating tool 'write' in a subagent started while planning.",
  );
  assert.equal(
    evaluate(call("edit", builtinTool("edit"))),
    "Plan mode blocks mutating tool 'edit' in a subagent started while planning.",
  );
  assert.equal(evaluate(call("bash", builtinTool("bash"), { command: "git status" })), undefined);
  assert.equal(
    evaluate(call("bash", builtinTool("bash"), { command: "rm -rf x" })),
    "Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: rm -rf x",
  );
  // A child's own safe built-ins run even when the planner never activated them.
  assert.equal(evaluate(call("grep", builtinTool("grep"))), undefined);

  // Leaving Plan does not loosen a policy a child already holds; new queries see Normal mode.
  await mock.commands.get("plan")?.handler("exit", context.ctx);
  assert.deepEqual(query(mock), [{ version: 1, active: false, sessionId: "test-session" }]);
  assert.match(evaluate(call("write", builtinTool("write"))) ?? "", /blocks mutating tool 'write'/u);
});

test("a shut-down planner still answers active, with no session and no opt-in tools", async () => {
  const mock = createMockPi({
    activeTools: ["read", "lsp_diagnostics"],
    allTools: [builtinTool("read"), extensionTool("lsp_diagnostics")],
  });
  planMode(mock.pi);
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);

  const [stale] = query(mock);
  assert.equal(stale?.active, true);
  assert.equal(stale?.sessionId, undefined);
  assert.equal(
    stale?.evaluate?.(call("lsp_diagnostics", extensionTool("lsp_diagnostics"))),
    "Plan mode blocks tool 'lsp_diagnostics' in a subagent started while planning because the Plan policy does not admit it.",
  );
  assert.equal(stale?.evaluate?.(call("read", builtinTool("read"))), undefined);
});

test("malformed state queries get no answer", () => {
  const mock = createMockPi();
  planMode(mock.pi);
  let replied = false;
  for (const payload of [undefined, null, {}, { version: 2, reply: () => (replied = true) }, { version: 1 }]) {
    mock.eventBus.emit(PLAN_MODE_STATE_QUERY, payload);
  }
  assert.equal(replied, false);
});

test("the child policy admits what Plan would and nothing else", () => {
  const evaluate = createChildToolPolicy({
    selectedNames: ["lsp_diagnostics"],
    settings: { safeSubcommands: { ssh: ["nas"] } },
    homeDir: "/home/u",
  });
  const annotated = { ...extensionTool("git_status"), annotations: { readOnlyHint: true } };

  assert.equal(
    evaluate(call("update_plan", extensionTool("update_plan"))),
    "Plan mode blocks mutating tool 'update_plan' in a subagent started while planning.",
  );
  assert.equal(
    evaluate(call("mystery", undefined)),
    "Plan mode blocks tool 'mystery' in a subagent started while planning because its safe policy metadata is unavailable.",
  );
  assert.equal(
    evaluate(call("danger", builtinTool("danger"))),
    "Plan mode blocks tool 'danger' in a subagent started while planning because the Plan policy does not admit it.",
  );
  assert.equal(
    evaluate(call("deploy", extensionTool("deploy"))),
    "Plan mode blocks tool 'deploy' in a subagent started while planning because the Plan policy does not admit it.",
  );
  assert.equal(evaluate(call("lsp_diagnostics", extensionTool("lsp_diagnostics"))), undefined);
  assert.equal(evaluate(call("git_status", annotated)), undefined);
  assert.equal(evaluate(call("powershell", builtinTool("powershell"), { command: "Get-ChildItem" })), undefined);
  assert.equal(
    evaluate(call("powershell", builtinTool("powershell"), { command: "Remove-Item x" })),
    "Plan mode blocks PowerShell commands outside its reviewed inspection policy or containing explicitly unsafe syntax.\nBlocked command: Remove-Item x",
  );
  const sshExec = extensionTool("ssh_exec");
  assert.equal(evaluate(call("ssh_exec", sshExec, { host: "nas", command: "uptime" })), undefined);
  assert.match(
    evaluate(call("ssh_exec", sshExec, { host: "nas", command: "rm -rf /" })) ?? "",
    /^Plan mode blocks ssh_exec calls outside its reviewed remote inspection policy\.\nBlocked: /u,
  );
});

for (const reason of ["reload", "resume"] as const) {
  test(`a Plan workflow restored on ${reason} answers state queries as active`, async () => {
    const stateEntry = {
      type: "custom",
      customType: "plan-mode-state",
      data: { enabled: true, awaitingAction: false, selectedToolNames: ["read", "bash"] },
    };
    const mock = createMockPi({
      activeTools: ["read", "bash", "write"],
      allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("write")],
    });
    planMode(mock.pi);
    assert.deepEqual(query(mock), [{ version: 1, active: false, sessionId: undefined }]);
    const context = createMockContext({
      sessionManager: {
        getSessionId: () => "restored-session",
        getBranch: () => [stateEntry],
        getEntries: () => [stateEntry],
      },
    });
    await mock.events.get("session_start")?.[0]?.({ reason }, context.ctx);

    const [restored] = query(mock);
    assert.equal(restored?.active, true);
    assert.equal(restored?.sessionId, "restored-session");
    assert.match(restored?.evaluate?.(call("write", builtinTool("write"))) ?? "", /blocks mutating tool 'write'/u);
  });
}
