import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  answerPlanModeStateQueries,
  createChildToolPolicy,
  PLAN_MODE_GATE_QUERY,
  PLAN_MODE_STATE_QUERY,
  type PlanModeStateSnapshot,
} from "../src/child-policy.js";
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
    "Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: rm -rf x\nOffending token: rm (mutating command)",
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
    selected: new Map([
      ["lsp_diagnostics", extensionTool("lsp_diagnostics").sourceInfo.path],
      ["unloaded", undefined],
    ]),
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
  // Selected by name in the planner, but this copy comes from somewhere else: not the same tool.
  const projectCopy = {
    ...extensionTool("lsp_diagnostics"),
    sourceInfo: { source: "auto", scope: "project", path: "/repo/.pi/extensions/lsp.ts" },
  };
  assert.equal(
    evaluate(call("lsp_diagnostics", projectCopy)),
    "Plan mode blocks tool 'lsp_diagnostics' in a subagent started while planning because the Plan policy does not admit it.",
  );
  // A selection the planner could not resolve to a file admits nothing.
  assert.match(evaluate(call("unloaded", extensionTool("unloaded"))) ?? "", /does not admit it/u);
  // A project-scope readOnlyHint is not a trusted declaration.
  assert.match(
    evaluate(call("proj_read", { ...projectCopy, name: "proj_read", annotations: { readOnlyHint: true } })) ?? "",
    /does not admit it/u,
  );
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

test("a snapshot that throws answers active with a policy refusing every tool", () => {
  const mock = createMockPi();
  answerPlanModeStateQueries(mock.pi, () => {
    throw new Error("broken");
  });
  const [state] = query(mock);
  assert.equal(state?.active, true);
  assert.equal(
    state?.evaluate?.(call("read", builtinTool("read"))),
    "Plan mode blocks tool 'read' in a subagent started while planning because it could not build the child policy.",
  );
});

test("Plan refuses subagent tools unless a compatible gate answers, and announces itself at start", async () => {
  const mock = createMockPi({
    activeTools: ["read", "Agent", "SubagentWorkflow", "steer_subagent", "get_subagent_result"],
    allTools: [
      builtinTool("read"),
      extensionTool("Agent"),
      extensionTool("SubagentWorkflow"),
      extensionTool("steer_subagent"),
      extensionTool("get_subagent_result"),
    ],
  });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        defaultPlanTools: ["read", "Agent", "SubagentWorkflow", "steer_subagent", "get_subagent_result"],
      },
    }),
  });
  const asked: unknown[] = [];
  let gateVersion: number | undefined;
  mock.eventBus.on(PLAN_MODE_GATE_QUERY, (data) => {
    asked.push(data);
    if (gateVersion !== undefined) {
      (data as { reply: (answer: unknown) => void }).reply({ version: gateVersion, gate: "test" });
    }
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  assert.equal(asked.length, 1, "session start announces Plan mode to subagent gates");
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const hook = mock.events.get("tool_call")?.[0];

  for (const toolName of ["Agent", "SubagentWorkflow", "steer_subagent"]) {
    assert.deepEqual(await hook?.({ toolName, input: {} }, context.ctx), {
      block: true,
      reason: `Plan mode blocks '${toolName}' because no compatible subagent gate answered, so a child it starts would not plan. Install @nredd/pi-subagents with Plan support (see the pi-plan-mode README).`,
    });
  }
  // Only the tools that start or resume a child need the gate; the rest (reading a result, stopping) stay usable.
  const askedBefore = asked.length;
  assert.equal(await hook?.({ toolName: "get_subagent_result", input: {} }, context.ctx), undefined);
  assert.equal(asked.length, askedBefore, "a non-spawning subagent tool never asks for the gate");
  gateVersion = 2;
  const stale = (await hook?.({ toolName: "Agent", input: {} }, context.ctx)) as { block?: boolean } | undefined;
  assert.equal(stale?.block, true);
  gateVersion = 1;
  assert.equal(await hook?.({ toolName: "Agent", input: {} }, context.ctx), undefined);
});
