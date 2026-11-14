import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createPlanContext, createPlanPi } from "./support.js";

async function emit(
  events: ReadonlyMap<string, Array<(...args: never[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  for (const handler of events.get(name) ?? []) await (handler as (...args: unknown[]) => unknown)(...args);
}

test("declared generated entry preserves registration and partial lifecycle cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-plan-mode-generated-entry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const { default: extension } = await import("../dist/index.js");
    const mock = createPlanPi();
    await extension(mock.pi);
    assert.equal(mock.flags.has("plan"), false);
    assert.ok(mock.commands.has("plan"));
    assert.ok(mock.handlers.has("session_start"));
    assert.ok(mock.handlers.has("session_shutdown"));
    const sessionManager = {
      getSessionId: () => "generated-entry-session",
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    };
    const context = createPlanContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager,
    });
    await emit(mock.handlers, "session_start", { reason: "startup" }, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const activeAttempt = {
      session: sessionManager,
      group: "agent-workflow",
      busy: false,
    };
    mock.bus.emit("workflow:mutex:v1", activeAttempt);
    assert.equal(activeAttempt.busy, true);

    await emit(mock.handlers, "session_shutdown", { reason: "quit" }, context.ctx);
    const releasedAttempt = { ...activeAttempt, busy: false };
    mock.bus.emit("workflow:mutex:v1", releasedAttempt);
    assert.equal(releasedAttempt.busy, false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});
