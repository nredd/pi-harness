/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { normalizeMaxTurns } from "./agent-runner.js";
import { getAgentConfig, resolveSpawnType } from "./agent-types.js";
import { type Clock, realClock, type TimerHandle } from "./clock.js";
import { admitModelSelection, type ModelSelection, selectModel } from "./model-selection.js";
import { checkAdmission, describeBlock, mayPark, modelRef, PARKED_RESUME_DELAY_MS, QUOTA_RESTART_GRACE_MS } from "./quota-admission.js";
import { type FireSlot, foreignOwnerLive, LEASE_MS, LEASE_RENEW_MS, type ScheduleStore } from "./schedule-store.js";
import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.js";

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
  /** Set by quota admission; see `ScheduledSubagent.quotaParked`. */
  quotaParked?: boolean;
}

/** Longest delay a native timer honors (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Process-global registry of claimed, unsettled scheduled fires, keyed by store
 * path + job id. Schedulers, stores and managers are rebuilt on every activation
 * (/resume, /new, /reload) while runs outlive them, so liveness lives here. While
 * a job has any fire, one timer renews this process's lease on it.
 */
const LIVE_RUNS = Symbol.for("pi-subagents:scheduled-runs");

interface LiveFires {
  fires: Set<string>;
  /** The subset of `fires` whose agent was spawned (the rest are pending admissions). */
  spawned: Set<string>;
  lease?: TimerHandle;
}

function liveRuns(): Map<string, LiveFires> {
  const g = globalThis as { [LIVE_RUNS]?: Map<string, LiveFires> };
  const existing = g[LIVE_RUNS];
  if (existing) return existing;
  const created = new Map<string, LiveFires>();
  g[LIVE_RUNS] = created;
  return created;
}

function runKey(store: ScheduleStore, jobId: string): string {
  return `${store.path}\0${jobId}`;
}

let fireSeq = 0;

/** Another process holds the claim: this process's settling must not touch the owner or status. */
function lostClaim(job: ScheduledSubagent): boolean {
  return job.runOwner !== undefined && job.runOwner.pid !== process.pid;
}

/** Register a claimed fire; the first one for a job starts its lease renewal. */
function holdFire(store: ScheduleStore, clock: Clock, jobId: string): string {
  const token = `fire-${++fireSeq}`;
  const key = runKey(store, jobId);
  const entry = liveRuns().get(key) ?? { fires: new Set<string>(), spawned: new Set<string>() };
  entry.fires.add(token);
  liveRuns().set(key, entry);
  if (!entry.lease) {
    entry.lease = clock.setInterval(() => {
      try {
        store.renewLease(jobId, { pid: process.pid, leaseUntil: clock.now() + LEASE_MS });
      } catch { /* a failed renewal is retried next tick; the lease only lapses after LEASE_MS */ }
    }, LEASE_RENEW_MS);
    entry.lease.unref?.();
  }
  return token;
}

/** Drop a fire. Returns how many fires remain, and how many of those spawned. The last one stops the lease renewal. */
function releaseFire(store: ScheduleStore, jobId: string, token: string): { fires: number; spawned: number } {
  const key = runKey(store, jobId);
  const entry = liveRuns().get(key);
  if (!entry) return { fires: 0, spawned: 0 };
  entry.fires.delete(token);
  entry.spawned.delete(token);
  if (entry.fires.size > 0) return { fires: entry.fires.size, spawned: entry.spawned.size };
  entry.lease?.cancel();
  liveRuns().delete(key);
  return { fires: 0, spawned: 0 };
}

/** What `start()` binds, captured by a fire so a later session switch cannot leak into it. */
interface BoundSession {
  store: ScheduleStore;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
}

/** Optional in-process scheduling dependencies; omitted clock uses native time. */
export interface SubagentSchedulerOptions {
  homeDir?: string;
  clock?: Clock;
}

export class SubagentScheduler {
  private readonly clock: Clock;
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, TimerHandle>();
  private deadlines = new Map<string, TimerHandle>();
  private scheduled = new Map<string, object>();
  private admissions = new Map<string, Set<AbortController>>();
  /** Newest pending admission per job that wrote "running", with the status it replaced. */
  private pendingRuns = new Map<string, { token: AbortController; prior: ScheduledSubagent["lastStatus"] }>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  constructor(private readonly options: SubagentSchedulerOptions = {}) {
    this.clock = options.clock ?? realClock;
  }

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.stop();
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) this.scheduleJob(job);
      this.reapOrphan(store, { ...job, ...store.get(job.id) });
    }
  }

  /**
   * A disabled job left "running" with no live run in this process and no live
   * foreign owner (dead pid or lapsed lease) was cut off; nothing can finalize it,
   * so it must not hold its name forever. A run this process still owns (a /resume,
   * /new or /reload re-bind) is in the registry and settles itself. A run owned by
   * another LIVE process on the same session is not ours to error. Returns the
   * job as it stands afterwards.
   */
  private reapOrphan(store: ScheduleStore, job: ScheduledSubagent): ScheduledSubagent {
    if (job.enabled || job.lastStatus !== "running") return job;
    if (this.hasLiveRun(store, job.id)) return job;
    // Re-check under the lock: another process may have claimed the job since our cache loaded.
    const now = this.clock.now();
    store.update(job.id, fresh =>
      fresh.enabled || fresh.lastStatus !== "running" || foreignOwnerLive(fresh.runOwner, now)
        ? {}
        : { lastStatus: "error", runOwner: undefined });
    return { ...job, ...store.get(job.id) };
  }

  /** Is any fire of this job, in this process, claimed and not yet settled? */
  private hasLiveRun(store: ScheduleStore, jobId: string): boolean {
    return (liveRuns().get(runKey(store, jobId))?.fires.size ?? 0) > 0;
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) t.cancel();
    this.intervals.clear();
    for (const t of this.deadlines.values()) t.cancel();
    this.deadlines.clear();
    for (const admissions of this.admissions.values()) for (const admission of admissions) admission.abort();
    this.admissions.clear();
    this.pendingRuns.clear();
    this.scheduled.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule, this.clock.now());
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      until: detected.until,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      quotaParked: input.quotaParked,
      enabled: true,
      createdAt: new Date(this.clock.now()).toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    // A run finalized by a pre-re-bind scheduler wrote through its own store.
    store.reload();
    const sameName = store.list().filter(old => old.name === input.name);
    if (sameName.some(old => !this.isFinished(old))) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    // Validate before reaping: a rejected add must not delete anything.
    const job = this.buildJob(input);
    // A finished job only holds its name for display; the new job takes it over.
    for (const old of sameName) this.removeJob(old.id);
    store.add(job);
    this.scheduleJob(job); // buildJob always creates an enabled job
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  updateJob(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const store = this.requireStore();
    // A new schedule restarts slot numbering; the old one's last slot would block it.
    const updated = store.update(id, job => patch.schedule !== undefined && patch.schedule !== job.schedule ? { ...patch, lastSlot: undefined } : patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /**
   * True once a job can never fire again and is not mid-run: a fired one-shot,
   * or a repeating job whose `until` deadline passed. Its name is reusable.
   */
  private isFinished(old: ScheduledSubagent): boolean {
    if (old.enabled) return false;
    if (this.hasLiveRun(this.requireStore(), old.id)) return false;
    // A run whose owner died or lapsed since we last looked frees the name now.
    const job = this.reapOrphan(this.requireStore(), old);
    if (job.lastStatus === "running") return false;
    if (job.scheduleType === "once") return job.lastRun !== undefined || job.lastStatus === "error";
    return this.pastDeadline(job);
  }

  /** Next-run time as ISO, or undefined if not currently armed or past the deadline. */
  getNextRun(jobId: string): string | undefined {
    const next = this.nextRunUnbounded(jobId);
    const until = this.store?.get(jobId)?.until;
    return next && until && new Date(next).getTime() >= new Date(until).getTime() ? undefined : next;
  }

  private nextRunUnbounded(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : this.clock.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.requireStore();
    if (this.pastDeadline(job)) {
      this.expireJob(job);
      return;
    }
    this.scheduled.set(job.id, {});
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        this.intervals.set(job.id, this.armInterval(job, job.intervalMs));
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        let delay = target - this.clock.now();
        // A quota-parked job whose reset passed while pi was closed still owes a
        // dispatch: re-admit it shortly after start instead of erroring it.
        if (delay <= 0 && job.quotaParked) delay = PARKED_RESUME_DELAY_MS;
        if (delay > 0) {
          const t = this.clock.setTimeout(() => {
            this.executeJob(job.id, { at: target, schedule: job.schedule });
            // Auto-disable one-shots after they fire (mirrors pi-cron-schedule)
            // Unless another process re-parked or edited the job meanwhile: this timer is stale.
            store.update(job.id, fresh => (fresh.schedule === job.schedule ? { enabled: false } : {}));
            const updated = store.get(job.id);
            if (updated) this.emit({ type: "updated", job: updated });
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire
          this.scheduled.delete(job.id);
          store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        // The tick each callback was armed for, which every process computes alike. Callback
        // start time cannot stand in: it differs per process, and a late one would name a later tick.
        let armed: Date;
        const cron = new Cron(job.schedule, self => {
          const tick = armed;
          // croner's own next tick: it schedules after this callback's start
          armed = self.nextRun(self.currentRun() ?? undefined) as Date;
          this.executeJob(job.id, { at: tick.getTime(), schedule: job.schedule });
        });
        armed = cron.nextRun() as Date; // a 6-field pattern without `maxRuns` always has a next tick
        this.jobs.set(job.id, cron);
      }
      // Disable at the deadline itself, not at the next (possibly days away) tick.
      if (job.until !== undefined && this.scheduled.has(job.id)) this.armDeadline(job, new Date(job.until).getTime());
    } catch (err) {
      // Nothing armed, so no token: a stale entry would admit a fire for a job with no timer.
      this.scheduled.delete(job.id);
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Fire on slots `createdAt + k * intervalMs`, which every process on the session
   * shares, whatever time it armed at. A timer claims the slot it was armed for, never
   * a later one, so a late callback cannot take an interval that is not yet due. Chained
   * timeouts re-aim at the next slot after the current time, which keeps a resumed or
   * late-joining process on the grid and skips slots missed while asleep.
   */
  private armInterval(job: ScheduledSubagent, intervalMs: number): TimerHandle {
    const anchor = new Date(job.createdAt).getTime();
    const nextSlot = (): number => Math.floor((this.clock.now() - anchor) / intervalMs) + 1;
    let current: TimerHandle | undefined;
    const arm = (k: number): void => {
      current = this.clock.setTimeout(() => {
        arm(Math.max(k + 1, nextSlot()));
        this.executeJob(job.id, { at: anchor + k * intervalMs, schedule: job.schedule });
      }, Math.max(0, anchor + k * intervalMs - this.clock.now()));
    };
    arm(nextSlot());
    return { cancel: () => current?.cancel() };
  }

  /** Arm the deadline timer, re-arming in `MAX_TIMER_MS` steps when it is out of timer range. */
  private armDeadline(job: ScheduledSubagent, untilMs: number): void {
    const remaining = untilMs - this.clock.now();
    this.deadlines.set(job.id, this.clock.setTimeout(() => {
      if (this.clock.now() >= untilMs) this.expireJob(job);
      else this.armDeadline(job, untilMs);
    }, Math.min(remaining, MAX_TIMER_MS)));
  }

  private pastDeadline(job: ScheduledSubagent): boolean {
    return job.until !== undefined && this.clock.now() >= new Date(job.until).getTime();
  }

  /** The deadline passed: stop timers and disable without firing. */
  private expireJob(job: ScheduledSubagent): void {
    this.unscheduleJob(job.id);
    const patch = { enabled: false, nextRun: undefined };
    this.requireStore().update(job.id, patch);
    this.emit({ type: "updated", job: { ...job, ...patch } });
  }

  private unscheduleJob(id: string): void {
    this.scheduled.delete(id);
    for (const admission of this.admissions.get(id) ?? []) admission.abort();
    this.admissions.delete(id);
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      t.cancel();
      this.intervals.delete(id);
    }
    this.deadlines.get(id)?.cancel();
    this.deadlines.delete(id);
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private executeJob(id: string, slot: FireSlot): void {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    const scheduled = this.scheduled.get(id);
    if (!store || !pi || !ctx || !manager || !scheduled) return;
    const job = store.get(id);
    if (!job?.enabled) return;
    if (this.pastDeadline(job)) {
      this.expireJob(job);
      return;
    }

    // Claim the fire under the store lock: another process on this session may have
    // fired this slot, or disabled, edited or removed the job since our cache loaded. The claim writes
    // "running" and the owner in one write; a lost claim skips the fire.
    const now = this.clock.now();
    const claim = store.claim(id, { pid: process.pid, leaseUntil: now + LEASE_MS }, now, slot);
    if (!claim) return;
    const token = holdFire(store, this.clock, id);

    // A fire that overlaps a pending admission inherits its prior status.
    const previous = this.pendingRuns.get(id);
    const prior = previous ? previous.prior : claim.prior;
    this.pendingRuns.delete(id);

    // Anything that throws while resolving the request must free the claim, or the
    // job stays "running" with a lease renewed forever. Only this pre-handoff part is
    // covered: once admission or a spawn is under way they settle the claim themselves.
    let selection: ModelSelection | undefined;
    try {
      selection = this.selectForFire(store, ctx, job, token);
    } catch (err) {
      this.endFire(store, id, token, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!selection) return;
    this.dispatchFire({ store, pi, ctx, manager }, id, job, scheduled, token, prior, selection);
  }

  /**
   * Resolve the original request at fire time, using the same type and model
   * policy as a manual dispatch. Never drop a failed explicit override. Returns
   * undefined (after persisting the error) when it cannot be resolved.
   */
  private selectForFire(store: ScheduleStore, ctx: ExtensionContext, job: ScheduledSubagent, token: string): ModelSelection | undefined {
    const dispatch = resolveSpawnType(job.subagent_type);
    const config = dispatch.ok ? getAgentConfig(dispatch.type) : undefined;
    const selection = dispatch.ok ? selectModel({
      homeDir: this.options.homeDir,
      agentType: dispatch.type, definitionModel: config?.model, agentLabel: config?.displayName,
      paramModel: job.model, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd,
    }) : dispatch.message;
    if (typeof selection === "string") {
      this.endFire(store, job.id, token, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: job.id, error: selection });
      return undefined;
    }
    if (selection.scopeWarning) ctx.ui.notify(selection.scopeWarning, "warning");
    return selection;
  }

  /** Hand a resolved fire to admission or straight to spawn. */
  private dispatchFire(
    { store, pi, ctx, manager }: BoundSession, id: string, job: ScheduledSubagent, scheduled: object,
    token: string, prior: ScheduledSubagent["lastStatus"], selection: ModelSelection,
  ): void {
    // A quota-parked job re-asks the router before starting: the window it
    // waited for may have refilled while another is still exhausted.
    const admissionModel = selection.model;
    if ((job.quotaParked || selection.tierBinding) && admissionModel) {
      const controller = new AbortController();
      const admissions = this.admissions.get(id) ?? new Set<AbortController>();
      admissions.add(controller);
      this.admissions.set(id, admissions);
      this.pendingRuns.set(id, { token: controller, prior });
      // Cancelled before spawn: undo this admission's "running", never a newer one's.
      controller.signal.addEventListener("abort", () => {
        const { fires } = releaseFire(store, id, token);
        if (this.pendingRuns.get(id)?.token !== controller) return;
        this.pendingRuns.delete(id);
        if (store.get(id)?.lastStatus === "running") {
          store.update(id, job => lostClaim(job)
            ? {}
            : { lastStatus: prior, ...(fires === 0 ? { runOwner: undefined } : {}) });
        }
      }, { once: true });
      const admission = selection.tierBinding
        ? admitModelSelection(selection, ctx.modelRegistry, pi.events, this.clock, controller.signal)
        : checkAdmission(pi.events, modelRef(admissionModel), undefined, this.clock, controller.signal);
      const settle = (): void => {
        if (this.pendingRuns.get(id)?.token === controller) this.pendingRuns.delete(id);
      };
      void admission.then(block => {
        if (this.store !== store || this.ctx !== ctx || this.scheduled.get(id) !== scheduled) return;
        settle();
        if (!block) {
          this.spawnJob({ store, pi, ctx, manager }, id, selection, token);
        } else if (mayPark(block) && block.resetAt > this.clock.now()) {
          this.repark(id, block.resetAt);
        } else {
          // Refused and it cannot wait (`wait: false`, no reset, or a reset
          // already past): only an explicit admission may spawn, so persist the
          // failure instead of starting on an exhausted provider.
          this.endFire(store, id, token, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
          this.emit({ type: "error", jobId: id, error: `${describeBlock(block)} The agent was not started.` });
        }
      }).catch(error => {
        if (this.store !== store || this.scheduled.get(id) !== scheduled) return;
        settle();
        this.endFire(store, id, token, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
        this.emit({ type: "error", jobId: id, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        admissions.delete(controller);
        if (admissions.size === 0 && this.admissions.get(id) === admissions) this.admissions.delete(id);
      });
      return;
    }
    this.spawnJob({ store, pi, ctx, manager }, id, selection, token);
  }

  /**
   * Re-arm a quota-parked one-shot at a later reset instead of starting it.
   * A job removed while admission was pending stays removed: `updateJob` is a
   * no-op for an unknown id.
   */
  private repark(id: string, resetAt: number): void {
    this.updateJob(id, {
      enabled: true,
      schedule: new Date(resetAt + QUOTA_RESTART_GRACE_MS).toISOString(),
      lastStatus: undefined,
      quotaParked: true,
    });
  }

  /** Spawn a fired job (bypassing the concurrency queue) and persist its outcome. */
  private spawnJob({ store, pi, ctx, manager }: BoundSession, id: string, selection: ModelSelection, token: string): void {
    const job = store.get(id);
    if (!job) {
      releaseFire(store, id, token);
      return;
    }

    let agentId: string;
    try {
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell. The catch below turns
      // this into lastStatus: "error" plus an error event, like any other
      // fire-time failure.
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      agentId = manager.spawn(pi, ctx, dispatch.type, job.prompt, {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: selection.model,
        modelSelection: selection,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: job.thinking,
        isolation: job.isolation,
        // A scheduled run has no tool call to build this, so without it the
        // conversation viewer shows nothing about how the job was configured.
        // The model is left out on purpose: agent-manager fills in the effective
        // one when the session reports it, and naming the pre-session pick here
        // would only be right until then.
        invocation: {
          thinking: job.thinking,
          // Normalized like the Agent tool's own snapshot: `0` means unlimited,
          // and rendering it as "max turns: 0" would read as a limit of none.
          maxTurns: normalizeMaxTurns(job.max_turns),
          isolated: job.isolated,
          runInBackground: true,
          isolation: job.isolation,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.endFire(store, id, token, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error });
      return;
    }

    liveRuns().get(runKey(store, id))?.spawned.add(token);
    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const finalize = (status: "success" | "error") => {
      // An overlapping run is still live: count this one, leave the status "running".
      const left = releaseFire(store, id, token);
      const othersLive = left.spawned > 0;
      // The finishing run may belong to a pre-re-bind scheduler whose store cache is stale.
      store.reload();
      const next = this.getNextRun(id);
      // Never overwrite a claim another process took after our lease lapsed.
      store.update(id, job => ({
        lastRun: new Date(this.clock.now()).toISOString(),
        runCount: job.runCount + 1,
        nextRun: next,
        ...(lostClaim(job) || othersLive ? {} : { lastStatus: status }),
        ...(lostClaim(job) || left.fires > 0 ? {} : { runOwner: undefined }),
      }));
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // awaitStartup first: with isolation: "worktree" the run promise only exists
    // once the repo copy is made, and a failed copy rejects here.
    // The start gate comes first: `bypassQueue` skips the pool but not the
    // process budget (`maxActiveSubagents`), so a fired job can sit "queued"
    // with no startup and no promise yet, and would otherwise finalize at once.
    Promise.resolve(manager.getRecord(agentId)?.startGate)
      .then(() => manager.awaitStartup(agentId))
      .then(() => manager.getRecord(agentId)?.promise)
      .then(() => {
        const r = manager.getRecord(agentId);
        const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
        finalize(failed ? "error" : "success");
      })
      .catch(() => finalize("error"));
  }

  /** Settle a claimed fire that never produced a run: persist `patch`, and free the claim if it was the last. */
  private endFire(store: ScheduleStore, id: string, token: string, patch: Partial<ScheduledSubagent> & { lastRun: string }): void {
    const { fires } = releaseFire(store, id, token);
    store.update(id, job => {
      // A claim another process took after our lease lapsed keeps its status and owner.
      if (lostClaim(job)) return { lastRun: patch.lastRun };
      return fires > 0 ? patch : { ...patch, runOwner: undefined };
    });
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string, now = Date.now()): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string; until?: string } {
    const bounded = s.trim().match(/^(.*\S)\s+until\s+(\S+)$/i);
    if (bounded) {
      const base = SubagentScheduler.detectSchedule(bounded[1], now);
      if (base.until !== undefined) throw new Error(`Invalid schedule "${s}". Only one "until" is allowed.`);
      if (base.type === "once") throw new Error(`Invalid schedule "${s}". "until" only applies to cron or interval schedules.`);
      const deadline = SubagentScheduler.parseRelativeTime(bounded[2], now) ?? bounded[2];
      const until = new Date(deadline);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(deadline) || Number.isNaN(until.getTime())) {
        throw new Error(`Invalid deadline "${bounded[2]}" in "${s}". Use an ISO timestamp or "+10m"-style relative time.`);
      }
      if (until.getTime() <= now) throw new Error(`Deadline ${until.toISOString()} is in the past.`);
      return { ...base, until: until.toISOString() };
    }
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed, now);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= now) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO). Append " until <ISO|+2h>" to a cron or interval to stop at a deadline.`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      // Croner only throws Error subclasses (TypeError, RangeError).
      return { valid: false, error: (e as Error).message };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string, now = Date.now()): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(now + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}
