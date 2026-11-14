/** Scheduler, schedule store and schedule menu branches: real stores, owned clock, stub manager/pi/ctx. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { getAgentConfig, NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { setModelTiers } from "../src/model-tiers.js";
import { ADMIT_CHANNEL } from "../src/quota-admission.js";
import { type ScheduleChangeEvent, SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";
import { showSchedulesMenu } from "../src/ui/schedule-menu.js";

let dir: string;
let registry: ModelRegistry;
const schedulers: SubagentScheduler[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "branch-scheduler-"));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider("fixture", { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret", models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  registerAgents(new Map());
});

afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
  registerAgents(new Map());
  setFallbackSubagent(undefined);
  setModelTiers(undefined, undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** `pi.events` that records schedule events and lets a test answer router admission by hand. */
function makePi() {
  const events: ScheduleChangeEvent[] = [];
  const admits: string[] = [];
  const handlers = new Map<string, (data: unknown) => void>();
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => {
        if (channel === "subagents:scheduled") events.push(data as ScheduleChangeEvent);
        if (channel === ADMIT_CHANNEL) admits.push((data as { requestId: string }).requestId);
      },
      on: (channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  } as unknown as ExtensionAPI;
  const reply = (data: unknown) => {
    const requestId = admits.shift();
    if (requestId === undefined) throw new Error("no admission request pending");
    handlers.get(`${ADMIT_CHANNEL}:reply:${requestId}`)?.(data);
  };
  return { pi, events, admits, reply, handlers };
}

function setup(opts: { clock?: FakeClock; spawn?: () => string; path?: string } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const spawn = vi.fn(opts.spawn ?? (() => "spawned"));
  const manager = { spawn, awaitStartup: async () => {}, getRecord: () => ({ status: "completed", promise: Promise.resolve("done") }) } as unknown as AgentManager;
  const { pi, events, admits, reply, handlers } = makePi();
  const ctx = { cwd: dir, modelRegistry: registry, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  const path = opts.path ?? join(dir, "jobs.json");
  const store = new ScheduleStore(path);
  const scheduler = new SubagentScheduler({ homeDir: dir, clock });
  schedulers.push(scheduler);
  scheduler.start(pi, ctx, manager, store);
  return { clock, events, admits, reply, handlers, spawn, pi, ctx, manager, store, path, scheduler };
}

const input = { name: "job", description: "job", schedule: "1s", subagent_type: "general-purpose", prompt: "work" };

/** Let settled admission promises run their `.then`/`.catch` handlers. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("scheduler branches", () => {
  it("leaves a disabled stored job unarmed on start", () => {
    const seed = new ScheduleStore(join(dir, "jobs.json"));
    const job: ScheduledSubagent = { ...new SubagentScheduler().buildJob(input), enabled: false };
    seed.add(job);
    const f = setup();
    expect(f.clock.pending).toBe(0);
    expect(f.scheduler.getNextRun(job.id)).toBeUndefined();
    f.clock.advance(5000);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("refuses to remove or update an unknown id without emitting", () => {
    const f = setup();
    expect(f.scheduler.removeJob("missing")).toBe(false);
    expect(f.scheduler.updateJob("missing", { enabled: false })).toBeUndefined();
    expect(f.events).toEqual([]);
  });

  it("reports a remove another process already made without a removed event", () => {
    const f = setup();
    const job = f.scheduler.addJob(input);
    new ScheduleStore(f.path).remove(job.id);
    expect(f.scheduler.removeJob(job.id)).toBe(false);
    expect(f.events.map(e => e.type)).toEqual(["added"]);
    expect(f.clock.pending).toBe(0);
  });

  it("skips a fire for a job another process disabled once the cache reloads", () => {
    const f = setup();
    const job = f.scheduler.addJob(input);
    new ScheduleStore(f.path).update(job.id, { enabled: false });
    f.scheduler.addJob({ ...input, name: "other", schedule: "0 0 9 * * 1" });
    expect(f.store.get(job.id)?.enabled).toBe(false);
    f.clock.advance(1000);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get(job.id)?.lastStatus).toBeUndefined();
  });

  it("drops a one-shot another process removed before it fired", () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, schedule: "+1s" });
    new ScheduleStore(f.path).remove(job.id);
    f.clock.advance(1000);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.events.map(e => e.type)).toEqual(["added"]);
    expect(JSON.parse(readFileSync(f.path, "utf-8")).jobs).toEqual([]);
  });

  it("does not fire an orphaned timer after stop when start ran twice", () => {
    const f = setup();
    f.scheduler.addJob(input);
    f.scheduler.start(f.pi, f.ctx, f.manager, f.store);
    f.scheduler.stop();
    expect(f.clock.pending).toBe(0);
    expect(() => f.clock.advance(1000)).not.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps no admission token for a job that never armed", () => {
    class FullClock extends FakeClock {
      override setInterval(): never { throw "timer table full"; }
    }
    const tokens = (s: SubagentScheduler) => (s as unknown as { scheduled: Map<string, object> }).scheduled;
    const full = setup({ clock: new FullClock(), path: join(dir, "full.json") });
    full.scheduler.addJob(input);
    expect(tokens(full.scheduler).size).toBe(0);
    const f = setup({ path: join(dir, "armed.json") });
    f.scheduler.addJob({ ...input, schedule: "5m" });
    expect(tokens(f.scheduler).size).toBe(1);
    f.store.add({ ...f.scheduler.buildJob({ ...input, name: "past-job" }), id: "past", scheduleType: "once", schedule: new Date(f.clock.now() - 1000).toISOString() });
    f.scheduler.stop();
    f.scheduler.start(f.pi, f.ctx, f.manager, f.store);
    expect(tokens(f.scheduler).size).toBe(1);
    expect(f.store.get("past")?.lastStatus).toBe("error");
  });

  it("reports a non-Error timer failure as its string", () => {
    class FullClock extends FakeClock {
      override setInterval(): never { throw "timer table full"; }
    }
    const f = setup({ clock: new FullClock() });
    const job = f.scheduler.addJob(input);
    expect(f.events).toContainEqual({ type: "error", jobId: job.id, error: "timer table full" });
  });

  it("reports a non-Error spawn failure as its string", () => {
    const f = setup({ spawn: () => { throw "spawn refused"; } });
    const job = f.scheduler.addJob(input);
    f.clock.advance(1000);
    expect(f.events).toContainEqual({ type: "error", jobId: job.id, error: "spawn refused" });
    expect(f.store.get(job.id)?.lastStatus).toBe("error");
  });

  it("finishes a one-shot fire quietly when the session stops during spawn", () => {
    let stop = () => {};
    const f = setup({ spawn: () => { stop(); return "spawned"; } });
    stop = () => f.scheduler.stop();
    const job = f.scheduler.addJob({ ...input, schedule: "+1s" });
    expect(() => f.clock.advance(1000)).not.toThrow();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.events.map(e => e.type)).toEqual(["added"]);
    expect(f.store.get(job.id)?.enabled).toBe(false);
  });

  it("does not spawn into a resumed session when admission resolves after the switch", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    expect(f.admits).toHaveLength(1);
    // /resume: same scheduler, a fresh store on the same file, a new context.
    f.scheduler.stop();
    const next = { ...makePi(), ctx: { cwd: dir, modelRegistry: registry, ui: { notify: vi.fn() } } as unknown as ExtensionContext };
    f.scheduler.start(next.pi, next.ctx, f.manager, new ScheduleStore(f.path));
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(next.events).toEqual([]);
    expect(f.scheduler.list().find(j => j.id === job.id)?.lastStatus).toBeUndefined();
  });

  it("ignores an admission failure that lands after the session switched", async () => {
    const f = setup();
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const find = registry.find.bind(registry);
    let reads = 0;
    let failed!: () => void;
    const failure = new Promise<void>(resolve => { failed = resolve; });
    vi.spyOn(registry, "find").mockImplementation((provider, id) => {
      if (++reads > 1) {
        failed();
        throw new Error("registry closed during admission");
      }
      return find(provider, id);
    });
    const job = f.scheduler.addJob({ ...input, model: "@cheap" });
    f.clock.advance(1000);
    f.scheduler.stop();
    const next = makePi();
    f.scheduler.start(next.pi, f.ctx, f.manager, new ScheduleStore(f.path));
    await failure;
    await flush();
    expect(next.events).toEqual([]);
    expect(f.events.filter(e => e.type === "error")).toEqual([]);
    expect(f.scheduler.list().find(j => j.id === job.id)?.lastStatus).toBeUndefined();
  });

  it("reports a non-Error admission failure as its string", async () => {
    const f = setup();
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const find = registry.find.bind(registry);
    let reads = 0;
    vi.spyOn(registry, "find").mockImplementation((provider, id) => {
      if (++reads > 1) throw "registry gone";
      return find(provider, id);
    });
    let reported!: () => void;
    const report = new Promise<void>(resolve => { reported = resolve; });
    const emit = f.pi.events.emit.bind(f.pi.events);
    vi.spyOn(f.pi.events, "emit").mockImplementation((channel, event) => {
      emit(channel, event);
      if ((event as ScheduleChangeEvent).type === "error") reported();
    });
    const job = f.scheduler.addJob({ ...input, model: "@cheap" });
    f.clock.advance(1000);
    await report;
    expect(f.events).toContainEqual({ type: "error", jobId: job.id, error: "registry gone" });
    expect(f.store.get(job.id)?.lastStatus).toBe("error");
  });

  it("leaves a job removed during admission removed instead of re-parking it", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, schedule: "+1s", model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    expect(f.scheduler.removeJob(job.id)).toBe(true);
    f.reply({ success: true, data: { ok: false, resetAt: f.clock.now() + 3_600_000 } });
    await flush();
    expect(f.store.get(job.id)).toBeUndefined();
    expect(f.events.map(e => e.type)).toEqual(["added", "updated", "removed"]);
    expect(f.clock.pending).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("does not dispatch or repark a job disabled during pending admission", async () => {
    for (const reply of [{ ok: true }, { ok: false, resetAt: Date.parse("2030-01-01T00:00:00Z") }]) {
      const f = setup({ path: join(dir, `jobs-${reply.ok}.json`) });
      const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
      f.clock.advance(1000);
      f.scheduler.updateJob(job.id, { enabled: false });
      f.reply({ success: true, data: reply });
      await flush();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.store.get(job.id)?.enabled).toBe(false);
      expect(f.clock.pending).toBe(0);
    }
  });

  it.each(["fixture/model", "@cheap"])("cancels pending admission resources on disable: %s", async model => {
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model, quotaParked: true });
    f.clock.advance(1000);
    expect(f.handlers.size).toBe(1);
    expect(f.clock.pending).toBe(3); // interval, admission timeout, lease renewal
    f.scheduler.updateJob(job.id, { enabled: false });
    expect(f.handlers.size).toBe(0);
    expect(f.clock.pending).toBe(0);
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("ignores an old reply after disable and re-enable but admits the new fire", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    f.scheduler.updateJob(job.id, { enabled: false });
    f.scheduler.updateJob(job.id, { enabled: true });
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.events.filter(e => e.type === "error")).toEqual([]);
    expect(f.store.get(job.id)?.lastStatus).toBeUndefined();
    f.clock.advance(1000);
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  describe("claimed fires", () => {
    /** A job whose first fire spawned a never-settling run, with a second fire's admission left pending. */
    const liveRunPlusPending = async () => {
      const f = setup();
      vi.spyOn(f.manager, "getRecord").mockReturnValue({ status: "running", promise: new Promise<string>(() => {}) } as never);
      const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
      f.clock.advance(1000);
      f.reply({ success: true, data: { ok: true } });
      await flush();
      expect(f.spawn).toHaveBeenCalledTimes(1);
      f.clock.advance(1000);
      expect(f.admits).toHaveLength(1);
      return { f, job };
    };

    it("keeps the owner when a pending admission is cancelled beside a live run", async () => {
      const { f, job } = await liveRunPlusPending();
      f.scheduler.updateJob(job.id, { enabled: false });
      expect(f.store.get(job.id)?.runOwner?.pid).toBe(process.pid);
    });

    it("keeps the owner when a refused admission ends beside a live run", async () => {
      const { f, job } = await liveRunPlusPending();
      f.reply({ success: true, data: { ok: false } });
      await flush();
      expect(f.store.get(job.id)).toMatchObject({ lastStatus: "error", runOwner: { pid: process.pid } });
    });

    it("skips a spawn whose job another process removed after the claim", async () => {
      const f = setup();
      const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
      f.clock.advance(1000);
      new ScheduleStore(f.path).remove(job.id);
      f.clock.advance(1000); // the next claim reloads the cache and finds the job gone
      f.reply({ success: true, data: { ok: true } });
      await flush();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.store.get(job.id)).toBeUndefined();
    });

    const foreign = () => ({ pid: process.ppid, leaseUntil: Date.parse("2020-01-01T00:00:00Z") + 600_000 });

    it("a run settling after another process took the claim leaves its status and owner", async () => {
      const f = setup();
      let finish!: () => void;
      vi.spyOn(f.manager, "getRecord").mockReturnValue({ status: "completed", promise: new Promise<void>(r => { finish = r; }) } as never);
      const job = f.scheduler.addJob({ ...input, schedule: "+1s" });
      f.clock.advance(1000);
      f.store.update(job.id, { runOwner: foreign() });
      finish();
      await flush();
      expect(f.store.get(job.id)).toMatchObject({ lastStatus: "running", runOwner: foreign(), runCount: 1 });
    });

    it("a failed spawn after another process took the claim keeps its status and owner", () => {
      const f = setup({ spawn: () => { throw new Error("boom"); } });
      const job = f.scheduler.addJob({ ...input, schedule: "+1s" });
      f.spawn.mockImplementation(() => {
        f.store.update(job.id, { runOwner: foreign() });
        throw new Error("boom");
      });
      f.clock.advance(1000);
      expect(f.store.get(job.id)).toMatchObject({ lastStatus: "running", runOwner: foreign() });
      expect(f.store.get(job.id)?.lastRun).toBeDefined();
    });

    it("a cancelled admission after another process took the claim leaves its status and owner", () => {
      const f = setup();
      const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
      f.clock.advance(1000);
      f.store.update(job.id, { runOwner: foreign() });
      f.scheduler.updateJob(job.id, { enabled: false });
      expect(f.store.get(job.id)).toMatchObject({ lastStatus: "running", runOwner: foreign() });
    });

    it("settling a fire whose registry entry is gone is harmless", async () => {
      const f = setup();
      let finish!: () => void;
      vi.spyOn(f.manager, "getRecord").mockReturnValue({ status: "completed", promise: new Promise<void>(r => { finish = r; }) } as never);
      const job = f.scheduler.addJob({ ...input, schedule: "+1s" });
      f.clock.advance(1000);
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:scheduled-runs")];
      finish();
      await flush();
      expect(f.store.get(job.id)?.lastStatus).toBe("success");
    });
  });

  it("cancels overlapping admissions while an already spawned run finishes after stop", async () => {
    const f = setup();
    let finish!: (value: string) => void;
    const promise = new Promise<string>(resolve => { finish = resolve; });
    vi.spyOn(f.manager, "getRecord").mockReturnValue({ status: "completed", promise } as never);
    const running = f.scheduler.addJob(input);
    f.scheduler.addJob({ ...input, name: "pending-a", model: "fixture/model", quotaParked: true });
    f.scheduler.addJob({ ...input, name: "pending-b", model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.handlers.size).toBe(2);
    expect(f.clock.pending).toBe(8); // adds the lease renewal of each of the three claimed fires
    f.scheduler.stop();
    expect(f.handlers.size).toBe(0);
    expect(f.clock.pending).toBe(1); // only the spawned run keeps renewing its lease
    finish("done");
    await flush();
    expect(f.clock.pending).toBe(0);
    expect(f.store.get(running.id)?.lastStatus).toBe("success");
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not revive an old admission after stop and restart with the same session", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    f.scheduler.stop();
    expect(f.clock.pending).toBe(0);
    f.scheduler.start(f.pi, f.ctx, f.manager, f.store);
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get(job.id)?.enabled).toBe(true);
    expect(f.clock.pending).toBe(1);
    expect(f.store.get(job.id)?.lastStatus).toBeUndefined();
    expect(f.events.filter(e => e.type === "error")).toEqual([]);
  });

  it("cancels overlapping admissions without clobbering a newer fire's running status", async () => {
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "@cheap" });
    f.store.update(job.id, { lastStatus: "success" });
    f.clock.advance(1000);
    f.clock.advance(1000);
    expect(f.admits).toHaveLength(2);
    expect(f.store.get(job.id)?.lastStatus).toBe("running");
    f.scheduler.updateJob(job.id, { enabled: false });
    expect(f.store.get(job.id)?.lastStatus).toBe("success");
    await flush();
    expect(f.store.get(job.id)?.lastStatus).toBe("success");
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps a status another writer set before a pending admission is cancelled", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    f.store.update(job.id, { lastStatus: "error" });
    f.scheduler.updateJob(job.id, { enabled: false });
    await flush();
    expect(f.store.get(job.id)?.lastStatus).toBe("error");
  });

  it("leaves a newer pending admission owning running when an older one settles", async () => {
    setModelTiers({ cheap: ["fixture/model"] }, undefined);
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "@cheap" });
    f.clock.advance(1000);
    f.clock.advance(1000);
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    f.scheduler.updateJob(job.id, { enabled: false });
    expect(f.store.get(job.id)?.lastStatus).toBe("success");
  });

  it("does not spawn a resolved admission disabled before its microtask runs", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    f.reply({ success: true, data: { ok: true } });
    f.scheduler.updateJob(job.id, { enabled: false });
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get(job.id)?.lastStatus).toBeUndefined();
    expect(f.events.filter(e => e.type === "error")).toEqual([]);
  });

  it("does not spawn a resolved admission stopped and restarted before its microtask runs", async () => {
    const f = setup();
    const job = f.scheduler.addJob({ ...input, model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    f.reply({ success: true, data: { ok: true } });
    f.scheduler.stop();
    f.scheduler.start(f.pi, f.ctx, f.manager, f.store);
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get(job.id)?.lastStatus).toBeUndefined();
    expect(f.events.filter(e => e.type === "error")).toEqual([]);
  });

  it("fails a fire whose agent type was disabled while admission was pending", async () => {
    setFallbackSubagent(NO_FALLBACK);
    const f = setup();
    const job = f.scheduler.addJob({ ...input, subagent_type: "Explore", model: "fixture/model", quotaParked: true });
    f.clock.advance(1000);
    const explore = getAgentConfig("Explore");
    if (!explore) throw new Error("Explore is a default agent");
    registerAgents(new Map([["Explore", { ...explore, enabled: false }]]));
    f.reply({ success: true, data: { ok: true } });
    await flush();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.store.get(job.id)?.lastStatus).toBe("error");
    expect(f.events).toContainEqual({ type: "error", jobId: job.id, error: expect.stringContaining('Unknown or disabled agent type: "Explore"') });
  });

  it("rejects an ISO-shaped schedule that is not a real date", () => {
    expect(() => SubagentScheduler.detectSchedule("2026-13-01T00:00:00Z")).toThrow(/Invalid schedule "2026-13-01T00:00:00Z"/);
  });
});

describe("schedule store branches", () => {
  it("loads a store file without a jobs array as empty", () => {
    const path = join(dir, "bare.json");
    writeFileSync(path, JSON.stringify({ version: 1 }));
    expect(new ScheduleStore(path).list()).toEqual([]);
  });

  it("returns undefined from update when another process removed the job", () => {
    const path = join(dir, "jobs.json");
    const a = new ScheduleStore(path);
    const job = new SubagentScheduler().buildJob(input);
    a.add(job);
    new ScheduleStore(path).remove(job.id);
    expect(a.update(job.id, { enabled: false })).toBeUndefined();
    expect(a.get(job.id)).toBeUndefined();
  });
});

describe("schedule menu rendering", () => {
  const NOW = Date.parse("2026-01-01T12:00:00.000Z");
  const iso = (offset: number) => new Date(NOW + offset).toISOString();
  const job = (over: Partial<ScheduledSubagent>): ScheduledSubagent => ({
    id: over.name ?? "id", name: "job", description: "d", schedule: "0 0 9 * * 1", scheduleType: "cron",
    subagent_type: "general-purpose", prompt: "go", enabled: true, createdAt: iso(0), runCount: 0, ...over,
  });

  function menu(jobs: ScheduledSubagent[], next: Record<string, string | undefined>, pick: number) {
    const removeJob = vi.fn();
    const scheduler = { isActive: () => true, list: () => jobs, getNextRun: (id: string) => next[id], removeJob };
    const select = vi.fn(async (_title: string, labels: string[]) => labels[pick]);
    const confirm = vi.fn(async (_title: string, _body: string) => false);
    const ctx = { ui: { select, confirm, notify: vi.fn() } };
    return { run: () => showSchedulesMenu(ctx as never, scheduler as never), select, confirm, removeJob };
  }

  it("formats relative times and status icons for every range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const jobs = [
      job({ name: "soon", lastRun: iso(-30_000) }),
      job({ name: "minutes", lastRun: iso(-5 * 60_000), enabled: false }),
      job({ name: "hours", lastRun: iso(-3 * 3_600_000), lastStatus: "error" }),
      job({ name: "days", lastRun: iso(-2 * 86_400_000), lastStatus: "running" }),
      job({ name: "garbled", lastRun: "not a date" }),
    ];
    const next = { soon: iso(30_000), minutes: iso(5 * 60_000), hours: iso(3 * 3_600_000), days: iso(2 * 86_400_000), garbled: undefined };
    const m = menu(jobs, next, 0);
    await m.run();
    const labels = m.select.mock.calls[0][1];
    expect(labels[0]).toMatch(/^1\. ✓ +soon .*next in <1m +last <1m ago/);
    expect(labels[1]).toMatch(/^2\. ✗ +minutes .*next in 5m +last 5m ago/);
    expect(labels[2]).toMatch(/^3\. ! +hours .*next in 3h +last 3h ago/);
    expect(labels[3]).toMatch(/^4\. ⋯ +days .*next in 2d +last 2d ago/);
    expect(labels[4]).toMatch(/^5\. ✓ +garbled .*next — +last —/);
  });

  it("truncates a long prompt and shows a missing next run in the cancel details", async () => {
    const long = job({ name: "long", prompt: "p".repeat(250) });
    const m = menu([long], { long: undefined }, 0);
    await m.run();
    const details = m.confirm.mock.calls[0][1];
    expect(details).toContain(`prompt:    ${"p".repeat(200)}…`);
    expect(details).toContain("next run:  —");
    expect(m.removeJob).not.toHaveBeenCalled();
  });
});
