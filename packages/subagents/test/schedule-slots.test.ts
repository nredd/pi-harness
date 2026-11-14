/** Slot claims: processes sharing a session fire each repeating slot once, and stale timers never fire. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

let dir: string;
let path: string;
const schedulers: SubagentScheduler[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slot-scheduler-"));
  path = join(dir, "jobs.json");
  registerAgents(new Map());
  setFallbackSubagent(NO_FALLBACK);
});

afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
  setFallbackSubagent(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** One simulated pi process: its own scheduler and store over the shared file. */
function process_(clock: FakeClock) {
  const spawn = vi.fn(() => "agent");
  const manager = { spawn, awaitStartup: async () => {}, getRecord: () => ({ status: "completed", promise: Promise.resolve("done") }) } as unknown as AgentManager;
  const pi = { events: { emit: vi.fn(), on: () => () => {} } } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] }, ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  const store = new ScheduleStore(path);
  const scheduler = new SubagentScheduler({ homeDir: dir, clock });
  schedulers.push(scheduler);
  scheduler.start(pi, ctx, manager, store);
  return { spawn, store, scheduler };
}

/** A clock whose first timeout runs `late` ms after it was due, like a callback delayed by load or sleep. */
class LateClock extends FakeClock {
  constructor(private late: number, start?: number) { super(start); }
  override setTimeout(callback: () => void, ms: number) {
    const lateness = this.late;
    this.late = 0;
    return super.setTimeout(callback, ms + lateness);
  }
}

const input = { name: "job", description: "job", schedule: "10s", subagent_type: "general-purpose", prompt: "work" };

describe("slot claims", () => {
  it("two processes fire an interval job exactly once per interval", () => {
    const clock = new FakeClock();
    const a = process_(clock);
    const job = a.scheduler.addJob(input);
    clock.advance(7000); // B joins off the interval grid
    const b = process_(clock);
    clock.advance(5 * 10_000 - 7000);
    expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(5);
    expect(a.store.get(job.id)).toBeDefined();
    expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(Date.parse(job.createdAt) + 5 * 10_000);
  });

  it("a lone process keeps firing every interval, whatever phase it resumed at", () => {
    const clock = new FakeClock();
    const seed = process_(clock);
    seed.scheduler.addJob(input);
    seed.scheduler.stop();
    clock.advance(123_456);
    const resumed = process_(clock);
    clock.advance(6 * 10_000);
    expect(resumed.spawn).toHaveBeenCalledTimes(6);
  });

  it("a timer armed before another process edited the schedule never fires", () => {
    const clock = new FakeClock();
    const a = process_(clock);
    const job = a.scheduler.addJob(input);
    const b = process_(clock); // loads the job and arms the 10s grid
    a.scheduler.updateJob(job.id, { schedule: "20s", intervalMs: 20_000 });
    expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBeUndefined();
    clock.advance(10_000);
    expect(a.spawn).not.toHaveBeenCalled();
    expect(b.spawn).not.toHaveBeenCalled();
    clock.advance(10_000); // b's stale 20s slot loses to a's real one
    expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(1);
  });

  it("a stale one-shot timer does not fire after another process re-parked the job", () => {
    const clock = new FakeClock();
    const a = process_(clock);
    const job = a.scheduler.addJob({ ...input, schedule: "+10s" });
    const b = process_(clock);
    const later = new Date(clock.now() + 60_000).toISOString();
    a.scheduler.updateJob(job.id, { schedule: later, quotaParked: false });
    clock.advance(10_000);
    expect(a.spawn).not.toHaveBeenCalled();
    expect(b.spawn).not.toHaveBeenCalled();
    clock.advance(50_000);
    expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(1);
  });

  it("a one-shot armed by two processes fires once", () => {
    const clock = new FakeClock();
    const a = process_(clock);
    a.scheduler.addJob({ ...input, schedule: "+10s" });
    const b = process_(clock);
    clock.advance(10_000);
    expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(1);
  });

  it("an edit to a new schedule restarts slot numbering", () => {
    const clock = new FakeClock();
    const a = process_(clock);
    const job = a.scheduler.addJob({ ...input, schedule: "+10s" });
    clock.advance(10_000);
    expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBeDefined();
    a.scheduler.updateJob(job.id, { enabled: true, schedule: new Date(clock.now() + 5000).toISOString() });
    clock.advance(5000);
    expect(a.spawn).toHaveBeenCalledTimes(2);
  });

  it("a late interval callback claims its own slot, not the next one", () => {
    const clock = new LateClock(6000);
    const a = process_(clock);
    const job = a.scheduler.addJob(input);
    const created = Date.parse(job.createdAt);
    const store = new ScheduleStore(path);
    clock.advance(10_000);
    // Another process fired slot 1 on time; this one's callback runs 6s late.
    expect(store.claim(job.id, { pid: process.ppid, leaseUntil: 0 }, clock.now(), { at: created + 10_000, schedule: job.schedule })).toBeDefined();
    clock.advance(6000);
    expect(a.spawn).not.toHaveBeenCalled();
    clock.advance(4000); // the real slot 2
    expect(a.spawn).toHaveBeenCalledTimes(1);
    expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(created + 20_000);
  });

  it("fires its late slot once after a sleep, skips the missed ones and resumes on the grid", () => {
    const clock = new LateClock(25_000);
    const a = process_(clock);
    const job = a.scheduler.addJob(input);
    const created = Date.parse(job.createdAt);
    clock.advance(35_000);
    expect(a.spawn).toHaveBeenCalledTimes(1);
    clock.advance(5000);
    expect(a.spawn).toHaveBeenCalledTimes(2);
    expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(created + 40_000);
  });

  describe("cron", () => {
    const t0 = Date.UTC(2030, 0, 1);
    const cron = { ...input, schedule: "*/10 * * * * *" };

    it("two processes fire a cron job exactly once per tick", () => {
      const clock = new FakeClock(t0);
      const a = process_(clock);
      const job = a.scheduler.addJob(cron);
      clock.advance(3000);
      const b = process_(clock);
      clock.advance(47_000);
      expect(a.spawn.mock.calls.length + b.spawn.mock.calls.length).toBe(5);
      expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(t0 + 50_000);
    });

    it("a late callback claims its armed tick, not the one it woke up in", () => {
      const clock = new LateClock(6000, t0);
      const a = process_(clock);
      const job = a.scheduler.addJob(cron);
      clock.advance(10_000);
      // Another process fired the 10s tick on time; this one's callback runs 6s late.
      expect(new ScheduleStore(path).claim(job.id, { pid: process.ppid, leaseUntil: 0 }, clock.now(), { at: t0 + 10_000, schedule: job.schedule })).toBeDefined();
      clock.advance(6000);
      expect(a.spawn).not.toHaveBeenCalled();
      clock.advance(4000);
      expect(a.spawn).toHaveBeenCalledTimes(1);
      expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(t0 + 20_000);
    });

    it("fires its late tick once after a sleep and skips the missed ones", () => {
      const clock = new LateClock(25_000, t0);
      const a = process_(clock);
      const job = a.scheduler.addJob(cron);
      clock.advance(35_000);
      expect(a.spawn).toHaveBeenCalledTimes(1);
      clock.advance(5000);
      expect(a.spawn).toHaveBeenCalledTimes(2);
      expect(new ScheduleStore(path).get(job.id)?.lastSlot).toBe(t0 + 40_000);
    });

    it("waits out a tick beyond the timer range in steps", () => {
      // Cron fields are local time: pick local midnights so the test holds in any zone.
      const start = new Date(2030, 0, 1, 12).getTime();
      const tick = new Date(2030, 1, 1).getTime();
      const clock = new FakeClock(start);
      const a = process_(clock);
      const job = a.scheduler.addJob({ ...input, schedule: "0 0 0 1 * *" });
      expect(tick - start).toBeGreaterThan(2_147_483_647);
      clock.advance(tick - start - 1);
      expect(a.spawn).not.toHaveBeenCalled();
      clock.advance(1);
      expect(a.spawn).toHaveBeenCalledTimes(1);
      expect(a.scheduler.getNextRun(job.id)).toBe(new Date(2030, 2, 1).toISOString());
    });

    it("re-arms a capped timer that wakes before its tick", () => {
      class EarlyClock extends FakeClock {
        private woken = false;
        override setTimeout(callback: () => void, ms: number) {
          // The first timer is claimed to be due, but fires 1s ahead of the tick.
          if (!this.woken && ms > 1000) {
            this.woken = true;
            return super.setTimeout(callback, ms - 1000);
          }
          return super.setTimeout(callback, ms);
        }
      }
      const clock = new EarlyClock(t0);
      const a = process_(clock);
      a.scheduler.addJob(cron);
      clock.advance(10_000);
      expect(a.spawn).toHaveBeenCalledTimes(1);
    });
  });
});
