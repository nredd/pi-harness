import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("active implementation menus require UI at the public command boundary", async () => {
  for (const hasUI of [false, true]) {
    const mock = createMockPi({ activeTools: ["read"] });
    let loads = 0;
    planMode(mock.pi, {
      readSettings: async () => ({ kind: "missing" as const }),
      loadInteractiveUi: async () => {
        loads += 1;
        return import("../src/interactive-ui.js");
      },
    });
    const branch = [
      {
        type: "custom",
        customType: "plan-mode-state",
        data: {
          enabled: false,
          awaitingAction: false,
          activeImplementation: {
            id: "active",
            plan: "# Active plan",
            source: "plan_mode_complete",
            startedAt: 1,
            retention: "keep",
          },
        },
      },
    ];
    const context = createMockContext({
      mode: "rpc",
      hasUI,
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
      select: async (_title: string, choices: string[]) => {
        assert.ok(choices.includes("Show active implementation plan"));
        return "Show active implementation plan";
      },
    });
    await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
    if (hasUI) {
      await mock.commands.get("plan")?.handler("", context.ctx);
      assert.equal(loads, 1);
      assert.match(JSON.stringify(mock.sentMessages), /# Active plan/u);
    } else {
      await assert.rejects(
        async () => mock.commands.get("plan")?.handler("", context.ctx),
        /interactive \/plan menu is unavailable/u,
      );
      assert.equal(loads, 0);
      assert.deepEqual(mock.sentMessages, []);
    }
  }
});

test("disabled tool admission bypasses policy resolution before and after a workflow", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({ hasUI: true });
  const allTools = mock.rawPi.getAllTools;
  let policyReads = 0;
  const unavailableRegistry = () => {
    policyReads += 1;
    throw new Error("registry unavailable");
  };
  mock.rawPi.getAllTools = unavailableRegistry;
  const call = mock.events.get("tool_call")?.[0];
  assert.ok(call);
  assert.equal(await call({ toolName: "read", input: {} }, context.ctx), undefined);
  assert.equal(policyReads, 0);
  mock.rawPi.getAllTools = allTools;
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(await call({ toolName: "read", input: {} }, context.ctx), undefined);
  await mock.commands.get("plan")?.handler("off", context.ctx);
  mock.rawPi.getAllTools = unavailableRegistry;
  assert.equal(await call({ toolName: "read", input: {} }, context.ctx), undefined);
  assert.equal(policyReads, 0);
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

/** Drive the real RPC menu while a supported agent-start event invalidates its plan. */
test("implementing from an open menu after a run clears its plan warns without sending a handoff", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, choices: string[]) => {
      assert.ok(choices.includes("Implement here"));
      await mock.events.get("before_agent_start")?.[0]?.({ prompt: "revise the proposal" }, context.ctx);
      return "Implement here";
    },
  });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute;
  assert.equal(typeof complete, "function");
  await (complete as (...args: unknown[]) => Promise<unknown>)(
    "ready",
    { plan: "# Initial plan" },
    undefined,
    undefined,
    context.ctx,
  );
  await mock.commands.get("plan")?.handler("", context.ctx);
  assert.equal(
    context.notifications.at(-1)?.message,
    "Plan mode disabled. No proposed plan is available to implement.",
  );
  assert.deepEqual(mock.sentUserMessages, []);
  const state = mock.entries.at(-1)?.data as { enabled: boolean; latestPlan?: string };
  assert.equal(state.enabled, true);
  assert.equal(state.latestPlan, undefined);
});

/** A blocked runtime application has no pending-admission marker, but still owns queued inputs. */
test("failed runtime persistence keeps queued prompts protected after the application settles", async () => {
  let releaseModel!: () => void;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const branch = [
    {
      type: "custom",
      customType: "plan-mode-state",
      data: {
        enabled: false,
        awaitingAction: false,
        pendingImplementationRuntime: { version: 1, model: { provider: "fixture", modelId: "target" } },
      },
    },
  ];
  const mock = createMockPi();
  const setModel = mock.rawPi.setModel;
  mock.rawPi.setModel = async (model) => {
    modelStarted();
    await gate;
    return setModel(model);
  };
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({
    hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch, getEntry: () => undefined },
    modelRegistry: {
      find: () => ({ provider: "fixture", id: "target" }),
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
  const appendEntry = mock.rawPi.appendEntry;
  mock.rawPi.appendEntry = () => {
    throw new Error("disk full");
  };
  const input = mock.events.get("input")?.[0];
  assert.ok(input);
  const leading = Promise.resolve(input({ text: "implement", source: "rpc" }, context.ctx));
  await started;
  const follower = Promise.resolve(input({ text: "preserve this queued prompt", source: "rpc" }, context.ctx));
  releaseModel();
  assert.deepEqual(await Promise.all([leading, follower]), [{ action: "handled" }, { action: "handled" }]);
  const beforeTree = mock.events.get("session_before_tree")?.[0];
  assert.ok(beforeTree);
  assert.deepEqual(await beforeTree({ preparation: { targetId: "other" } }, context.ctx), { cancel: true });
  assert.match(context.notifications.at(-1)?.message ?? "", /admit the pending prompts before changing branches/u);
  mock.rawPi.appendEntry = appendEntry;
  await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
  const recovered = mock.sentMessages.filter(
    ({ message }) => (message as { customType?: string }).customType === "plan-mode-recovered-input",
  );
  assert.equal(recovered.length, 1);
  assert.equal((recovered[0]?.message as { content?: string } | undefined)?.content, "preserve this queued prompt");
  assert.deepEqual(mock.sentUserMessages, []);
});
