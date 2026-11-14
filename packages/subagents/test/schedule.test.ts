/**
 * schedule.test.ts — SubagentScheduler engine.
 *
 * Tests:
 *   - Static format parsers (cron / relative / interval / detection)
 *   - Job lifecycle (add / update / remove / cleanup)
 *   - Fire path (interval, one-shot) with mocked AgentManager + fake timers
 *   - Past-timestamp rejection
 *   - One-shot auto-disable
 *   - Concurrency-bypass option flows through to manager.spawn
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  return {
    spawn: spawnFn,
    awaitStartup: vi.fn(async () => {}),
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  } as any;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as any;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as any;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    // Bare digits / wrong unit / no plus → null
    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();   // relative isn't an interval
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);  // 5 fields
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "general-purpose", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0].enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  // Regression: getNextRun on a freshly-created interval used to return undefined
  // (the lastRun-based branch needs lastRun, which is undefined before first fire),
  // surfacing as "Next run: (unknown)" in the agent's create-response.
  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    // Should be ~now + 1h, with a small tolerance for the time spent in the call
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  // `lastRun` does not move the next run: it stays on the createdAt grid armInterval aims at.
  it("getNextRun ignores lastRun for interval jobs and stays on the createdAt grid", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    scheduler.updateJob(job.id, { lastRun });
    expect(scheduler.getNextRun(job.id)).toBe(new Date(Date.parse(job.createdAt) + 3_600_000).toISOString());
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/in the past/);
    // No dead-on-arrival record left behind
    expect(scheduler.list()).toEqual([]);
  });

  // The safety net in scheduleJob's past-branch only fires on store reload —
  // a once-job persisted with a future ISO whose time has now passed (process
  // restart after the trigger window). detectSchedule rejects past timestamps
  // at create time, so this is the only remaining production path.
  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Direct store insert bypasses addJob's upfront validation, mimicking a
    // record that was valid when written but is now stale on reload.
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    // Re-arm: stop drops timers, start re-reads store.list() and calls scheduleJob
    // for every enabled job → the past-branch fires for our seeded record.
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "reload-test", error: expect.stringMatching(/in the past/),
    }));
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    // Module-global: restore here, not at the end of a test body, so a failing
    // assertion can't leak strict dispatch into every test that follows.
    setFallbackSubagent(undefined);
    registerAgents(new Map());
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });

    expect(manager.spawn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("refuses at fire time when the job's agent type no longer resolves", () => {
    // The registry is what production populates at activation; a job outliving
    // its agent must not silently run something else (#183).
    registerAgents(new Map());
    setFallbackSubagent(NO_FALLBACK);
    const job = scheduler.addJob({
      name: "gone", description: "vanished agent", schedule: "+1s",
      subagent_type: "deleted-since", prompt: "run",
    });

    vi.advanceTimersByTime(2_000);

    expect(manager.spawn).not.toHaveBeenCalled();
    const stored = store.get(job.id);
    expect(stored?.lastStatus).toBe("error");
    // Pin WHY it failed — "didn't spawn" alone would be satisfied by any
    // unrelated pre-spawn throw.
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:scheduled",
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("Unknown or disabled agent type"),
      }),
    );
  });

  it("one-shot fires once and auto-disables", async () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });

    vi.advanceTimersByTime(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // The auto-disable update happens synchronously inside the timer callback
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    // Subsequent ticks shouldn't fire again
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("deadline job fires on cadence, then disables without firing at the deadline", () => {
    const job = scheduler.addJob({
      name: "poll", description: "poll", schedule: "10s until +35s",
      subagent_type: "general-purpose", prompt: "poll",
    });
    expect(job.until).toBeDefined();
    expect(job.schedule).toBe("10s");

    vi.advanceTimersByTime(35_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
    expect(store.get(job.id)?.enabled).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("a tick exactly at the deadline does not fire", () => {
    const job = scheduler.addJob({
      name: "edge", description: "edge", schedule: "10s until +20s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("getNextRun is undefined once the next tick passes the deadline", () => {
    const job = scheduler.addJob({
      name: "cap", description: "cap", schedule: "10s until +15s",
      subagent_type: "general-purpose", prompt: "x",
    });
    expect(scheduler.getNextRun(job.id)).toBeDefined();
    vi.advanceTimersByTime(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  it("a sparse job is disabled at the deadline, not at its next tick", () => {
    const job = scheduler.addJob({
      name: "sparse", description: "sparse", schedule: "1h until +90s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(89_000);
    expect(store.get(job.id)?.enabled).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(store.get(job.id)?.enabled).toBe(false);
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("an expired deadline job releases its name; a paused one before its deadline does not", () => {
    const add = (name: string) =>
      scheduler.addJob({ name, description: name, schedule: "1h until +5m", subagent_type: "general-purpose", prompt: "x" });
    const paused = add("paused");
    scheduler.updateJob(paused.id, { enabled: false });
    expect(() => add("paused")).toThrow(/already exists/);
    const expiring = add("expiring");
    vi.advanceTimersByTime(6 * 60_000);
    expect(add("expiring").id).not.toBe(expiring.id);
  });

  it("a one-shot disabled before it ever ran keeps its name", () => {
    const job = scheduler.addJob({ name: "idle", description: "idle", schedule: "+1h", subagent_type: "general-purpose", prompt: "x" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(() => scheduler.addJob({ name: "idle", description: "idle", schedule: "+1h", subagent_type: "general-purpose", prompt: "x" })).toThrow(/already exists/);
  });

  it("a job stays disabled after a far deadline passes", async () => {
    const job = scheduler.addJob({
      name: "far", description: "far", schedule: "1h until +40d",
      subagent_type: "general-purpose", prompt: "x",
    });
    expect(store.get(job.id)?.enabled).toBe(true);
    // Async so each fired run settles; a never-settling run would renew its lease every 30s.
    await vi.advanceTimersByTimeAsync(41 * 86_400_000);
    expect(store.get(job.id)?.enabled).toBe(false);
    const fired = manager.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(manager.spawn).toHaveBeenCalledTimes(fired);
  }, 30_000);

  it("a deadline beyond the timer range fires on time, not at the next tick", () => {
    // Yearly cron: the next tick is months away, so only the deadline timer can disable it.
    const job = scheduler.addJob({
      name: "far-exact", description: "far-exact", schedule: "0 0 0 1 1 * until +40d",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(40 * 86_400_000 - 1_000);
    expect(store.get(job.id)?.enabled).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(store.get(job.id)?.enabled).toBe(false);
  }, 30_000);

  it("a tick landing exactly on the deadline disables the job without firing", () => {
    const job = scheduler.addJob({
      name: "edge", description: "edge", schedule: "1m until +60s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("a run finishing after a restart on the same store does not corrupt the count", async () => {
    let resolve!: () => void;
    manager.getRecord.mockImplementation(() => ({ status: "completed", promise: new Promise<string>(r => { resolve = () => r(""); }) }));
    const input = { name: "restart", description: "restart", schedule: "1m", subagent_type: "general-purpose" as const, prompt: "x" };
    const job = scheduler.addJob(input);
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.start(pi, ctx, manager, store);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.updateJob(job.id, { enabled: false });
    expect(store.get(job.id)?.lastStatus).toBe("success");
  });

  it("never arms a native timer beyond its range, and re-arms until the deadline", () => {
    const delays: number[] = [];
    let now = 0;
    const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
    const clock = {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => {
        delays.push(ms);
        const t = { at: now + ms, cb, live: true };
        timers.push(t);
        return { cancel: () => { t.live = false; } };
      },
      setInterval: () => ({ cancel: () => {} }),
    };
    const s = new SubagentScheduler({ clock });
    const st = new ScheduleStore(join(tmp, "clock.json"));
    s.start(pi, ctx, manager, st);
    const job = s.addJob({ name: "huge", description: "huge", schedule: "0 0 0 1 1 * until +60d", subagent_type: "general-purpose", prompt: "x" });
    // The cron job runs on croner's own timer; every clock timer here is a deadline timer.
    while (st.get(job.id)?.enabled) {
      const next = timers.filter(t => t.live).sort((x, y) => x.at - y.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.cb();
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647);
    expect(delays.length).toBeGreaterThan(1);
    expect(st.get(job.id)?.enabled).toBe(false);
    expect(now).toBe(60 * 86_400_000);
    s.stop();
  });

  it("an enabled job past its deadline and left running is errored on restart", () => {
    const old = scheduler.buildJob({ name: "exp", description: "exp", schedule: "1m until +1h", subagent_type: "general-purpose", prompt: "x" });
    store.add({ ...old, until: new Date(Date.now() - 1000).toISOString(), lastStatus: "running" });
    scheduler.start(pi, ctx, manager, store);
    expect(store.get(old.id)).toMatchObject({ enabled: false, lastStatus: "error" });
    expect(() => scheduler.addJob({ name: "exp", description: "exp", schedule: "1m", subagent_type: "general-purpose", prompt: "x" })).not.toThrow();
  });

  it("a disabled job left running by a previous process frees its name on restart", () => {
    const old = scheduler.buildJob({ name: "cut", description: "cut", schedule: "+1h", subagent_type: "general-purpose", prompt: "x" });
    store.add({ ...old, enabled: false, lastRun: new Date().toISOString(), lastStatus: "running" });
    scheduler.start(pi, ctx, manager, store);
    expect(store.get(old.id)?.lastStatus).toBe("error");
    expect(() => scheduler.addJob({ name: "cut", description: "cut", schedule: "+1h", subagent_type: "general-purpose", prompt: "x" })).not.toThrow();
  });

  it("overlapping interval runs keep the name until the last one finishes", async () => {
    const resolvers: Array<() => void> = [];
    const records = new Map<string, { status: string; promise: Promise<string> }>();
    manager.spawn.mockImplementation(() => {
      const id = `agent-${records.size}`;
      records.set(id, { status: "completed", promise: new Promise<string>(r => resolvers.push(() => r(""))) });
      return id;
    });
    manager.getRecord.mockImplementation((id: string) => records.get(id));
    const input = { name: "ovl", description: "ovl", schedule: "1m until +150s", subagent_type: "general-purpose" as const, prompt: "x" };
    scheduler.addJob(input);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(manager.spawn).toHaveBeenCalledTimes(2);
    expect(store.list()[0].enabled).toBe(false);
    resolvers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => scheduler.addJob(input)).toThrow(/already exists/);
    resolvers[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => scheduler.addJob(input)).not.toThrow();
  });

  it("an expired deadline job found at start is disabled, never armed", () => {
    const job = scheduler.addJob({
      name: "old", description: "old", schedule: "10s until +5s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.stop();
    vi.advanceTimersByTime(60_000);
    scheduler.start(pi, ctx, manager, store);
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(store.get(job.id)?.enabled).toBe(false);
  });

  it("a fired one-shot releases its name once it settles", async () => {
    scheduler.addJob({
      name: "Monitor", description: "Monitor", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(scheduler.list()[0]?.lastStatus).toBe("success"));
    const again = scheduler.addJob({
      name: "Monitor", description: "Monitor", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "again",
    });
    expect(scheduler.list().map(j => j.id)).toEqual([again.id]);
  });

  it("a rejected add leaves a finished same-name job in place", async () => {
    const first = scheduler.addJob({
      name: "Keep", description: "Keep", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });
    vi.advanceTimersByTime(2_000);
    await vi.waitFor(() => expect(scheduler.list()[0]?.lastStatus).toBe("success"));
    expect(() => scheduler.addJob({
      name: "Keep", description: "Keep", schedule: "garbage",
      subagent_type: "general-purpose", prompt: "x",
    })).toThrow(/Invalid schedule/);
    expect(scheduler.list().map(j => j.id)).toEqual([first.id]);
  });

  it("armed jobs and a running one-shot keep their names", () => {
    const add = (name: string, schedule: string) =>
      scheduler.addJob({ name, description: name, schedule, subagent_type: "general-purpose", prompt: "x" });
    add("armed", "+1h");
    expect(() => add("armed", "+1h")).toThrow(/already exists/);
    add("rec", "1h until +5h");
    expect(() => add("rec", "1h")).toThrow(/already exists/);
    const stale = add("plain", "1h");
    scheduler.updateJob(stale.id, { enabled: false });
    // disabled but never bounded: not finished, name still held
    expect(() => add("plain", "1h")).toThrow(/already exists/);
    add("run", "+1s");
    vi.advanceTimersByTime(2_000);
    // fired and disabled, but its agent has not settled yet
    expect(() => add("run", "+1h")).toThrow(/already exists/);
  });

  describe("re-bind while a fired run is live", () => {
    const path = () => join(tmp, "s.json");
    const input = { name: "Rebind", description: "Rebind", schedule: "+1h", subagent_type: "general-purpose" as const, prompt: "x" };
    /** Production activation: a NEW manager (which has never seen the old agents), scheduler and store. */
    const activate = () => {
      scheduler.stop();
      const fresh = makeMockManager();
      fresh.getRecord.mockImplementation(() => undefined);
      const next = new SubagentScheduler();
      next.start(pi, ctx, fresh, new ScheduleStore(path()));
      scheduler = next;
      return next;
    };
    const fireOneShot = () => {
      const job = scheduler.addJob({ ...input, schedule: "+1s" });
      vi.advanceTimersByTime(2_000);
      expect(scheduler.list()[0]?.lastStatus).toBe("running");
      return job;
    };

    it("a hung one-shot keeps its name across a re-bind with a fresh manager", () => {
      manager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
      const job = fireOneShot();
      const next = activate();
      expect(next.list()[0]).toMatchObject({ id: job.id, lastStatus: "running" });
      expect(() => next.addJob(input)).toThrow(/already exists/);
    });

    it("overlapping runs across a re-bind hold the name until the last settles", async () => {
      const resolvers: Array<() => void> = [];
      const records = new Map<string, { status: string; promise: Promise<string> }>();
      manager.spawn.mockImplementation(() => {
        const id = `agent-${records.size}`;
        records.set(id, { status: "completed", promise: new Promise<string>(r => resolvers.push(() => r(""))) });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      const job = scheduler.addJob({ ...input, name: "Ovl", schedule: "1m until +150s" });
      await vi.advanceTimersByTimeAsync(150_000);
      expect(manager.spawn).toHaveBeenCalledTimes(2);
      const next = activate();
      resolvers[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => next.addJob({ ...input, name: "Ovl" })).toThrow(/already exists/);
      expect(new ScheduleStore(path()).get(job.id)?.lastStatus).toBe("running");
      resolvers[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => next.addJob({ ...input, name: "Ovl" })).not.toThrow();
    });

    it("a live run holds the name whatever the persisted status says", () => {
      manager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
      const job = fireOneShot();
      scheduler.updateJob(job.id, { enabled: false });
      store.update(job.id, { lastStatus: "success" });
      expect(() => scheduler.addJob(input)).toThrow(/already exists/);
    });

    it("a run that finished during the gap frees its name", async () => {
      let finish: () => void = () => {};
      const settled = new Promise<void>(r => { finish = r; });
      manager.getRecord.mockImplementation(() => ({ status: "completed", promise: settled }));
      fireOneShot();
      scheduler.stop();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      const next = activate();
      expect(next.list()[0]?.lastStatus).toBe("success");
      expect(() => next.addJob(input)).not.toThrow();
    });

    it("a run settling after a re-bind frees the name for the new scheduler", async () => {
      let finish: () => void = () => {};
      const settled = new Promise<void>(r => { finish = r; });
      manager.getRecord.mockImplementation(() => ({ status: "completed", promise: settled }));
      fireOneShot();
      const next = activate();
      expect(() => next.addJob(input)).toThrow(/already exists/);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => next.addJob(input)).not.toThrow();
    });

    describe("a second process on the same session", () => {
      const lease = () => Date.now() + 120_000;
      /** Simulate another process: fresh registry, same store file, owner as persisted. */
      const secondProcess = (ownerFor: () => { pid: number; leaseUntil: number }) => {
        manager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
        const job = fireOneShot();
        expect(new ScheduleStore(path()).get(job.id)?.runOwner).toMatchObject({ pid: process.pid });
        store.update(job.id, { runOwner: ownerFor() });
        delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:scheduled-runs")];
        return { job, next: activate() };
      };

      it("keeps the name of a run whose owner is alive with a valid lease", () => {
        const { job, next } = secondProcess(() => ({ pid: process.ppid, leaseUntil: lease() }));
        expect(next.list().find(j => j.id === job.id)?.lastStatus).toBe("running");
        expect(() => next.addJob(input)).toThrow(/already exists/);
      });

      it("frees the name of a run whose owner pid is dead", () => {
        const { job, next } = secondProcess(() => ({ pid: 2 ** 31 - 2, leaseUntil: lease() }));
        expect(next.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
        expect(() => next.addJob(input)).not.toThrow();
      });

      it("a live pid stays authoritative while its lease lapsed by less than three leases (host sleep)", () => {
        const { next } = secondProcess(() => ({ pid: process.ppid, leaseUntil: Date.now() - 3 * 120_000 + 1_000 }));
        expect(() => next.addJob(input)).toThrow(/already exists/);
      });

      it("frees the name of a run whose lease lapsed by more than three leases even though the pid is alive (pid reuse)", () => {
        const { job, next } = secondProcess(() => ({ pid: process.ppid, leaseUntil: Date.now() - 3 * 120_000 - 1 }));
        expect(next.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
        expect(() => next.addJob(input)).not.toThrow();
      });

      it("addJob errors a kept run once its owner dies or its lease lapses", () => {
        const { job, next } = secondProcess(() => ({ pid: process.ppid, leaseUntil: lease() }));
        expect(() => next.addJob(input)).toThrow(/already exists/);
        store.update(job.id, { runOwner: { pid: 2 ** 31 - 2, leaseUntil: lease() } });
        expect(() => next.addJob(input)).not.toThrow();
        expect(new ScheduleStore(path()).get(job.id)).toBeUndefined();
      });

      it("a lease lapsing after start frees the name without another start()", () => {
        const { job, next } = secondProcess(() => ({ pid: process.ppid, leaseUntil: Date.now() + 1_000 }));
        expect(() => next.addJob(input)).toThrow(/already exists/);
        vi.advanceTimersByTime(4 * 120_000);
        expect(() => next.addJob(input)).not.toThrow();
        expect(new ScheduleStore(path()).get(job.id)).toBeUndefined();
      });

      it("clears the owner when the run finalizes", async () => {
        let finish: () => void = () => {};
        const settled = new Promise<void>(r => { finish = r; });
        manager.getRecord.mockImplementation(() => ({ status: "completed", promise: settled }));
        const job = fireOneShot();
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(new ScheduleStore(path()).get(job.id)?.runOwner).toBeUndefined();
      });

      it("renews its lease while a run is live and stops when it settles", async () => {
        let finish: () => void = () => {};
        const settled = new Promise<void>(r => { finish = r; });
        manager.getRecord.mockImplementation(() => ({ status: "completed", promise: settled }));
        const job = fireOneShot();
        const first = new ScheduleStore(path()).get(job.id)!.runOwner!.leaseUntil;
        await vi.advanceTimersByTimeAsync(30_000);
        const renewed = new ScheduleStore(path()).get(job.id)!.runOwner!.leaseUntil;
        expect(renewed).toBeGreaterThan(first);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe("two processes firing the same job", () => {
      const spec = { name: "Dup", description: "Dup", schedule: "1m", subagent_type: "general-purpose" as const, prompt: "x" };
      /** A second scheduler on the same store file; `asPid` makes its claims look foreign. */
      const otherProcess = () => {
        const otherManager = makeMockManager();
        otherManager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
        const other = new SubagentScheduler();
        other.start(pi, ctx, otherManager, new ScheduleStore(path()));
        return { other, otherManager };
      };

      it("exactly one fires: the loser sees the winner's claim under the lock", async () => {
        manager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
        const job = scheduler.addJob(spec);
        // The other process never saw the add as enabled-and-claimed: it has a stale cache.
        const { other, otherManager } = otherProcess();
        // Another live pid wins the claim first, under the lock, with a valid lease.
        expect(new ScheduleStore(path()).claim(job.id, { pid: process.ppid, leaseUntil: Date.now() + 120_000 }, Date.now(), { at: 1, schedule: job.schedule })).toBeDefined();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(manager.spawn).not.toHaveBeenCalled();
        expect(otherManager.spawn).not.toHaveBeenCalled();
        other.stop();
      });

      it("a claim is refused while a live foreign owner holds it, granted once it lapses", () => {
        const job = scheduler.addJob(spec);
        const a = new ScheduleStore(path());
        const b = new ScheduleStore(path());
        const now = Date.now();
        const slot = (at: number) => ({ at, schedule: job.schedule });
        expect(a.claim(job.id, { pid: process.ppid, leaseUntil: now + 120_000 }, now, slot(1))).toBeDefined();
        expect(b.claim(job.id, { pid: process.pid, leaseUntil: now + 120_000 }, now, slot(1))).toBeUndefined();
        expect(b.claim(job.id, { pid: process.pid, leaseUntil: now + 600_000 }, now + 120_000 + 360_000 + 1, slot(2))?.job.runOwner?.pid).toBe(process.pid);
      });

      it("a claim is refused for a job disabled or removed by another process", () => {
        const job = scheduler.addJob(spec);
        const stale = new ScheduleStore(path());
        const slot = (at: number) => ({ at, schedule: job.schedule });
        new ScheduleStore(path()).update(job.id, { enabled: false });
        expect(stale.claim(job.id, { pid: process.pid, leaseUntil: 1 }, 0, slot(3))).toBeUndefined();
        new ScheduleStore(path()).remove(job.id);
        expect(stale.claim(job.id, { pid: process.pid, leaseUntil: 1 }, 0, slot(3))).toBeUndefined();
      });

      it("a stale-cache fire of a job another process disabled is skipped", async () => {
        const job = scheduler.addJob(spec);
        new ScheduleStore(path()).update(job.id, { enabled: false });
        expect(store.get(job.id)?.enabled).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(manager.spawn).not.toHaveBeenCalled();
      });

      it("the claim and owner are written together before the spawn", () => {
        const job = scheduler.addJob({ ...spec, schedule: "+1s" });
        manager.spawn.mockImplementation(() => {
          expect(new ScheduleStore(path()).get(job.id)).toMatchObject({ lastStatus: "running", runOwner: { pid: process.pid } });
          return "agent-x";
        });
        manager.getRecord.mockImplementation(() => ({ status: "running", promise: new Promise(() => {}) }));
        vi.advanceTimersByTime(2_000);
        expect(manager.spawn).toHaveBeenCalledTimes(1);
      });

      it("the name frees only after the claimant's run settles, and addJob refuses while live", async () => {
        let finish: () => void = () => {};
        const settled = new Promise<void>(r => { finish = r; });
        manager.getRecord.mockImplementation(() => ({ status: "completed", promise: settled }));
        scheduler.addJob({ ...spec, schedule: "+1s" });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(() => scheduler.addJob(spec)).toThrow(/already exists/);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(() => scheduler.addJob(spec)).not.toThrow();
      });

      it("a throw between the claim and the spawn frees the claim and the lease", async () => {
        const job = scheduler.addJob({ ...spec, schedule: "+1s" });
        Object.defineProperty(ctx, "modelRegistry", { get: () => { throw new Error("registry gone"); } });
        await vi.advanceTimersByTimeAsync(2_000);
        const after = new ScheduleStore(path()).get(job.id);
        expect(after?.lastStatus).toBe("error");
        expect(after?.runOwner).toBeUndefined();
        expect(after?.lastRun).toBeDefined();
        const held = [...(globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi-subagents:scheduled-runs")].keys()];
        expect(held.filter(key => key.includes(job.id))).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "error", error: "registry gone" }));
      });

      it("a non-Error throw before the spawn is reported as text", async () => {
        scheduler.addJob({ ...spec, schedule: "+1s" });
        Object.defineProperty(ctx, "modelRegistry", { get: () => { throw "plain"; } });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "error", error: "plain" }));
      });

      it("the orphan reap re-checks the job under the lock", () => {
        const reap = (scheduler as unknown as { reapOrphan(s: ScheduleStore, j: unknown): { lastStatus?: string } }).reapOrphan.bind(scheduler);
        const base = scheduler.buildJob(spec);
        const stale = { ...base, enabled: false, lastStatus: "running" as const, runOwner: { pid: 2 ** 31 - 2, leaseUntil: 1 } };
        const put = (patch: object) => {
          const other = new ScheduleStore(path());
          other.add({ ...stale, ...patch });
          store.reload();
        };
        // Another process claimed it with a live pid since our cache loaded: keep it.
        put({ runOwner: { pid: process.ppid, leaseUntil: Date.now() + 120_000 } });
        expect(reap(store, stale).lastStatus).toBe("running");
        expect(store.get(base.id)?.lastStatus).toBe("running");
        // Re-enabled or already settled under the lock: leave it.
        put({ enabled: true });
        expect(reap(store, stale).lastStatus).toBe("running");
        expect(store.get(base.id)?.lastStatus).toBe("running");
        put({ enabled: false, lastStatus: "success" });
        reap(store, stale);
        expect(store.get(base.id)?.lastStatus).toBe("success");
        // Still an orphan under the lock: error it.
        put({ lastStatus: "running" });
        expect(reap(store, stale).lastStatus).toBe("error");
      });

      it("an error path before spawn releases the claim", async () => {
        const job = scheduler.addJob({ ...spec, schedule: "+1s" });
        manager.spawn.mockImplementation(() => { throw new Error("boom"); });
        await vi.advanceTimersByTimeAsync(2_000);
        const after = new ScheduleStore(path()).get(job.id);
        expect(after?.lastStatus).toBe("error");
        expect(after?.runOwner).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("a previous-process run left running is errored on start", () => {
      const old = scheduler.buildJob({ ...input, name: "Cut" });
      store.add({ ...old, enabled: false, lastRun: new Date().toISOString(), lastStatus: "running" });
      const next = activate();
      expect(next.list().find(j => j.id === old.id)?.lastStatus).toBe("error");
      expect(() => next.addJob({ ...input, name: "Cut" })).not.toThrow();
    });
  });

  it("rejects bad deadlines", () => {
    const bad = (schedule: string) => () =>
      scheduler.addJob({ name: schedule, description: "d", schedule, subagent_type: "general-purpose", prompt: "x" });
    expect(bad("10s until nonsense")).toThrow(/Invalid deadline/);
    expect(bad("10s until 2000-01-01T00:00:00Z")).toThrow(/in the past/);
    expect(bad("10s until +1h until +2h")).toThrow(/Only one "until"/);
    expect(bad("+10m until +1h")).toThrow(/only applies to cron or interval/);
    expect(bad("0 0 9 * * 1 until +0s")).toThrow(/in the past/);
  });

  it("cron deadline jobs parse", () => {
    const d = SubagentScheduler.detectSchedule("0 */15 * * * * until 2099-01-01T00:00:00Z");
    expect(d).toMatchObject({ type: "cron", normalized: "0 */15 * * * *", until: "2099-01-01T00:00:00.000Z" });
  });

  it("fire passes bypassQueue: true to manager.spawn", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("fire passes the job's configuration as the invocation snapshot", () => {
    // A scheduled run has no tool call to build one, so without this the
    // conversation viewer can say nothing about how the job was configured.
    // The model is left out on purpose: agent-manager fills in the effective one
    // once the session reports it.
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
      thinking: "high", max_turns: 12, isolated: true,
    });

    vi.advanceTimersByTime(1_000);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.invocation).toEqual({
      thinking: "high",
      maxTurns: 12,
      isolated: true,
      runInBackground: true,
      isolation: undefined,
    });
  });

  it("fire normalizes an unlimited turn budget out of the snapshot", () => {
    // 0 means unlimited; "max turns: 0" would read as a limit of none.
    scheduler.addJob({
      name: "unlimited", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x", max_turns: 0,
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn.mock.calls[0][4].invocation.maxTurns).toBeUndefined();
  });

  it("disabled jobs do not fire", () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "fired", name: "fire-once", agentId: expect.stringMatching(/^agent-/),
    }));
  });

  it("records lastStatus error and emits when manager.spawn throws", async () => {
    manager.spawn.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);

    // Update is synchronous in the spawn-throw path
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  it("records lastStatus error when the agent fails to start after spawn returns", async () => {
    // Under isolation: "worktree" the agent is not running when spawn() returns
    // — the repo copy is awaited. A failure there must be recorded as a failed
    // run, not as the success the missing run promise would otherwise imply.
    manager.awaitStartup.mockRejectedValueOnce(new Error('Cannot run with isolation: "worktree"'));
    const job = scheduler.addJob({
      name: "no-worktree", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x", isolation: "worktree",
    });
    vi.advanceTimersByTime(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
  });

  // ── Status reflection from record.status (regression for bug #1) ────
  // The real AgentManager's promise *always* resolves (its .catch returns ""),
  // so the schedule's success/error must be inferred from `record.status`,
  // not from promise resolution. These two tests model that contract.
  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      manager.spawn.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      expect(manager.spawn).toHaveBeenCalledTimes(1);

      // The agent ran and ended in error — same shape the real AgentManager produces.
      const r = [...records.values()][0];
      r.status = "error";
      r.resolve();

      // Flush microtasks so .then(finalize) runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      const r = [...records.values()][0];
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("waits out a fired job queued on the process budget instead of finalizing it at once", async () => {
      // `bypassQueue` skips the pool, not `maxActiveSubagents`: the record can
      // come back "queued" with a start gate and no promise yet.
      let openGate!: () => void;
      const startGate = new Promise<void>(r => { openGate = r; });
      let resolveRun!: () => void;
      const record: { status: string; startGate?: Promise<void>; promise?: Promise<string> } = {
        status: "queued",
        startGate,
      };
      manager.spawn.mockImplementation(() => "agent-queued");
      manager.getRecord.mockImplementation(() => record);
      const job = scheduler.addJob({
        name: "queued-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("running");

      record.status = "running";
      record.promise = new Promise<string>(r => { resolveRun = () => r(""); });
      openGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("running");

      record.status = "completed";
      resolveRun();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(3_000);
      const recs = [...records.values()];
      recs[0].status = "aborted";
      recs[0].resolve();
      recs[1].status = "stopped";
      recs[1].resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});
