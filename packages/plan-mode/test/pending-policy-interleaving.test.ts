import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { builtinTool, createPlanContext, createPlanPi } from "./support.js";

/** Commands can replace a workflow while first-input runtime application awaits the host model. */
for (const snapshotEnabled of [false, true]) {
  test(`runtime persistence rollback rejects ${snapshotEnabled ? "inconsistent" : "disabled"} pending policy`, async () => {
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
    const mock = createPlanPi({
      activeTools: ["read"],
      allTools: ["read", "find", "plan_mode_question", "plan_mode_complete"].map(builtinTool),
    });
    mock.pi.setModel = async () => {
      modelStarted();
      await gate;
      return true;
    };
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const context = createPlanContext({
      hasUI: true,
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
      modelRegistry: {
        find: () => ({ provider: "fixture", id: "target" }),
        getApiKeyAndHeaders: async () => ({ ok: true as const }),
      },
    });
    await mock.handlers.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
    const input = mock.handlers.get("input")?.[0];
    const command = mock.commands.get("plan");
    const transform = mock.handlers.get("context")?.[0];
    const call = mock.handlers.get("tool_call")?.[0];
    assert.ok(input && command && transform && call);
    const appendEntry = mock.pi.appendEntry;
    const leading = Promise.resolve(input({ text: "implement", source: "rpc" }, context.ctx));
    try {
      if (snapshotEnabled) {
        // No await: both public handlers run before runtime application's first microtask.
        const activation = command.handler("start", context.ctx);
        const resolution = transform({ messages: [] }, context.ctx);
        await Promise.all([activation, resolution]);
      }
      await started;
      if (snapshotEnabled) await command.handler("off", context.ctx);
      await command.handler("start", context.ctx);
      mock.pi.setActiveTools(["read", "find", "plan_mode_question", "plan_mode_complete"]);
      mock.pi.appendEntry = () => {
        throw new Error("disk full during runtime intent consumption");
      };
      releaseModel();
      assert.deepEqual(await leading, { action: "handled" });
      mock.pi.appendEntry = appendEntry;
      assert.match(context.notifications.at(-1)?.message ?? "", /one-shot state could not be consumed/u);
      const before = mock.entries.length;
      await transform({ messages: [] }, context.ctx);
      await transform({ messages: [] }, context.ctx);
      const admission = await call({ toolName: "find", input: {} }, context.ctx);
      if (snapshotEnabled) {
        assert.equal((admission as { block?: boolean })?.block, true, "rollback must not broaden frozen tools");
        assert.equal(await call({ toolName: "read", input: {} }, context.ctx), undefined);
      } else {
        assert.equal(admission, undefined, "disabled rollback must leave normal tool admission intact");
      }
      assert.equal(mock.entries.length, before, "rejected pending policy must not persist a new freeze");
    } finally {
      releaseModel();
      await Promise.allSettled([leading]);
      mock.pi.appendEntry = appendEntry;
      await mock.handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
    }
  });
}
