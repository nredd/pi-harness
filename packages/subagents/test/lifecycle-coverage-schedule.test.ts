/** Scheduler timer/admission failures with a real store and private model registry. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { setModelTiers } from "../src/model-tiers.js";
import { type ScheduleChangeEvent, SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { FakeClock } from "./helpers/fake-clock.js";

let dir: string;
let scheduler: SubagentScheduler;
let registry: ModelRegistry;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lifecycle-scheduler-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider("fixture", { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret", models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
});
afterEach(() => { scheduler?.stop(); setModelTiers(undefined, undefined); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const clock = new FakeClock();
  const events: ScheduleChangeEvent[] = [];
  const spawn = vi.fn(() => "spawned");
  const manager = { spawn, awaitStartup: async () => {}, getRecord: () => ({ status: "completed", promise: Promise.resolve("done") }) } as unknown as AgentManager;
  const pi = { events: { emit: (_channel: string, event: ScheduleChangeEvent) => events.push(event) } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, modelRegistry: registry, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  const store = new ScheduleStore(join(dir, "jobs.json"));
  scheduler = new SubagentScheduler({ homeDir: dir, clock });
  scheduler.start(pi, ctx, manager, store);
  return { clock, events, spawn, pi, store };
}

const input = { name: "job", description: "job", schedule: "1s", subagent_type: "general-purpose", prompt: "work" };

describe("scheduler lifecycle failures", () => {
  it("rejects an invalid six-field cron expression with the library diagnostic", () => {
    const result = SubagentScheduler.validateCronExpression("99 99 99 * * *");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/range|maximum|value/i);
  });

  it("reports a zero-interval timer configuration failure without inventing a next run", () => {
    const f = setup();
    const job = scheduler.addJob({ ...input, schedule: "0s" });
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
    expect(f.clock.pending).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ type: "error", jobId: job.id, error: expect.any(String) }));
  });

  it("persists an asynchronous tier-admission registry failure without spawning", async () => {
    const f = setup();
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const find = registry.find.bind(registry);
    let reads = 0;
    vi.spyOn(registry, "find").mockImplementation((provider, id) => {
      if (++reads > 1) throw new Error("registry closed during admission");
      return find(provider, id);
    });
    let reported!: () => void;
    const report = new Promise<void>(resolve => { reported = resolve; });
    vi.spyOn(f.pi.events, "emit").mockImplementation((_channel, event) => {
      f.events.push(event as ScheduleChangeEvent);
      if ((event as ScheduleChangeEvent).type === "error") reported();
    });
    const job = scheduler.addJob({ ...input, model: "@cheap" });
    f.clock.advance(1000);
    await report;
    expect(f.store.get(job.id)?.lastStatus).toBe("error");
    expect(f.events).toContainEqual({ type: "error", jobId: job.id, error: "registry closed during admission" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("fires a cron callback through the real Croner boundary and cancels it on stop", async () => {
    // Croner does not accept the owned Clock interface. Its external timer
    // boundary is controlled separately; all owned scheduler time stays injected.
    vi.useFakeTimers();
    const f = setup();
    vi.setSystemTime(f.clock.now());
    const job = scheduler.addJob({ ...input, schedule: "* * * * * *" });
    expect(SubagentScheduler.validateCronExpression("* * * * * *")).toEqual({ valid: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.events).toContainEqual({ type: "fired", jobId: job.id, agentId: "spawned", name: "job" });
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
  });
});
