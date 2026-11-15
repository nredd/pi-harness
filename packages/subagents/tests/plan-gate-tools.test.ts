/**
 * plan-gate-tools.test.ts -- the Agent and steer_subagent tools refuse work that would outlive Plan
 * unrestricted (#437), driven by a recording `pi` whose bus answers Plan's state query. The same paths run
 * against the real pi-plan-mode in `integration/inprocess/plan-mode-subagents.test.ts` (#867); this keeps
 * the package's own signal at zero without it.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import {
  PLAN_MODE_STATE_QUERY,
  PLAN_PARK_REFUSAL,
  PLAN_SCHEDULE_REFUSAL,
  planSteerRefusal,
} from "../src/plan-mode-children.js";
import { ADMIT_CHANNEL } from "../src/quota-admission.js";
import { bootPi, ctx, flush, hermeticDir, textOf } from "../test/helpers/boot-extension.js";

type ToolActivity = { type: "start" | "end"; toolName: string };

let restore: (() => void) | undefined;
let shutdown: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  restore?.();
  restore = undefined;
});

/** Boot the real extension on an EventEmitter bus; Plan answers `planning`, the router answers `admit`. */
async function boot(planning: boolean, admit: { ok: boolean; resetAt?: number } = { ok: true }) {
  const hermetic = hermeticDir();
  restore = hermetic.restore;
  const { pi, tools, lifecycle } = bootPi();
  const emitter = new EventEmitter();
  pi.events = {
    emit: (channel: string, data: unknown) => emitter.emit(channel, data),
    on: (channel: string, handler: (data: unknown) => void) => {
      emitter.on(channel, handler);
      return () => emitter.off(channel, handler);
    },
  };
  const plan = { active: planning };
  pi.events.on(PLAN_MODE_STATE_QUERY, (data: unknown) =>
    (data as { reply(state: unknown): void }).reply({ version: 1, active: plan.active, evaluate: () => "blocked" }),
  );
  pi.events.on(ADMIT_CHANNEL, (raw: unknown) => {
    const { requestId } = raw as { requestId: string };
    emitter.emit(`${ADMIT_CHANNEL}:reply:${requestId}`, { success: true, data: admit });
  });
  subagentsExtension(pi);
  const c = ctx({ model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet" } });
  await lifecycle.get("session_start")?.({}, c);
  const run = (name: string, params: Record<string, unknown>, onUpdate?: (update: unknown) => void) =>
    tools.get(name).execute("tc", { prompt: "go", description: "work", ...params }, undefined, onUpdate, c);
  shutdown = async () => {
    await lifecycle.get("session_shutdown")?.({}, c);
  };
  return { run, plan };
}

describe("while Plan is active", () => {
  it("refuses a scheduled agent", async () => {
    const { run } = await boot(true);
    expect(textOf(await run("Agent", { subagent_type: "general-purpose", schedule: "0 3 * * * *" }))).toBe(
      PLAN_SCHEDULE_REFUSAL,
    );
  });

  it("refuses to park a quota-blocked background dispatch", async () => {
    const { run } = await boot(true, { ok: false, resetAt: Date.now() + 3_600_000 });
    await expect(run("Agent", { subagent_type: "general-purpose", run_in_background: true })).rejects.toThrow(
      PLAN_PARK_REFUSAL,
    );
  });

  it("refuses to steer a running agent that started before Plan, and steers once Plan is off", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { run, plan } = await boot(false);
    const started = await run("Agent", { subagent_type: "general-purpose", run_in_background: true });
    await flush();
    const id = /Agent ID: (\S+)/.exec(textOf(started))?.[1] ?? "";
    plan.active = true;
    expect(textOf(await run("steer_subagent", { agent_id: id, message: "EDIT" }))).toBe(planSteerRefusal(id));
    plan.active = false;
    expect(textOf(await run("steer_subagent", { agent_id: id, message: "EDIT" }))).toContain("Steering message queued");
  });
});

describe("tool activity tracking", () => {
  it("ends the tool that matches, leaving other running tools tracked", async () => {
    vi.mocked(runAgent).mockImplementation(async (_context, _type, _prompt, options) => {
      for (const activity of [
        { type: "start", toolName: "read" },
        { type: "start", toolName: "grep" },
        { type: "end", toolName: "grep" },
        { type: "end", toolName: "read" },
      ] satisfies ToolActivity[])
        options?.onToolActivity?.(activity);
      return { responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false } as never;
    });
    const { run } = await boot(false);
    const updates: { toolUses: number; activity: string }[] = [];
    const result = await run("Agent", { subagent_type: "general-purpose", run_in_background: false }, (update) => {
      const { details } = update as { details: { toolUses: number; activity: string } };
      updates.push({ toolUses: details.toolUses, activity: details.activity });
    });
    expect(result.details.toolUses).toBe(2);
    // Ending `grep` leaves `read` running; ending `read` leaves nothing.
    expect(updates).toEqual([
      { toolUses: 0, activity: "thinking…" },
      { toolUses: 0, activity: "reading…" },
      { toolUses: 0, activity: "reading, searching…" },
      { toolUses: 1, activity: "reading…" },
      { toolUses: 2, activity: "thinking…" },
    ]);
  });
});
