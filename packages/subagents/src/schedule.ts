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
import type { ScheduleStore } from "./schedule-store.js";
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
  /** Spawned runs not yet finalized, per job id (interval runs can overlap). */
  private inFlight = new Map<string, number>();
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
      // A job disabled while "running" (or expired by the scheduling above) was cut
      // off by a previous process; no agent of this one can finalize it, so it must
      // not hold its name forever. A run this process still owns (a /resume, /new or
      // /reload re-bind; the manager outlives it) is left for its finalize to settle.
      if (store.get(job.id)?.enabled === false && job.lastStatus === "running" && !this.ownsLiveRun(job, manager)) {
        store.update(job.id, { lastStatus: "error" });
      }
    }
  }

  private ownsLiveRun(job: ScheduledSubagent, manager: AgentManager): boolean {
    if (job.runPid !== process.pid || !job.runAgentId) return false;
    const status = manager.getRecord(job.runAgentId)?.status;
    return status === "queued" || status === "running";
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
    this.inFlight.clear();
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
    const updated = store.update(id, patch);
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
  private isFinished(job: ScheduledSubagent): boolean {
    if (job.enabled || job.lastStatus === "running" || (this.inFlight.get(job.id) ?? 0) > 0) return false;
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
        const t = this.clock.setInterval(() => this.executeJob(job.id), job.intervalMs);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        let delay = target - this.clock.now();
        // A quota-parked job whose reset passed while pi was closed still owes a
        // dispatch: re-admit it shortly after start instead of erroring it.
        if (delay <= 0 && job.quotaParked) delay = PARKED_RESUME_DELAY_MS;
        if (delay > 0) {
          const t = this.clock.setTimeout(() => {
            this.executeJob(job.id);
            // Auto-disable one-shots after they fire (mirrors pi-cron-schedule)
            store.update(job.id, { enabled: false });
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
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
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
  private executeJob(id: string): void {
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

    // A fire that overlaps a pending admission inherits its prior status.
    const previous = this.pendingRuns.get(id);
    const prior = previous ? previous.prior : job.lastStatus;
    this.pendingRuns.delete(id);
    store.update(id, { lastStatus: "running" });

    // Resolve the original request at fire time, using the same type and model
    // policy as a manual dispatch. Never drop a failed explicit override.
    const dispatch = resolveSpawnType(job.subagent_type);
    const config = dispatch.ok ? getAgentConfig(dispatch.type) : undefined;
    const selection = dispatch.ok ? selectModel({
      homeDir: this.options.homeDir,
      agentType: dispatch.type, definitionModel: config?.model, agentLabel: config?.displayName,
      paramModel: job.model, parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd,
    }) : dispatch.message;
    if (typeof selection === "string") {
      store.update(id, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error: selection });
      return;
    }

    if (selection.scopeWarning) ctx.ui.notify(selection.scopeWarning, "warning");

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
        if (this.pendingRuns.get(id)?.token !== controller) return;
        this.pendingRuns.delete(id);
        if (store.get(id)?.lastStatus === "running") store.update(id, { lastStatus: prior });
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
          this.spawnJob({ store, pi, ctx, manager }, id, selection);
        } else if (mayPark(block) && block.resetAt > this.clock.now()) {
          this.repark(id, block.resetAt);
        } else {
          // Refused and it cannot wait (`wait: false`, no reset, or a reset
          // already past): only an explicit admission may spawn, so persist the
          // failure instead of starting on an exhausted provider.
          this.store?.update(id, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
          this.emit({ type: "error", jobId: id, error: `${describeBlock(block)} The agent was not started.` });
        }
      }).catch(error => {
        if (this.store !== store || this.scheduled.get(id) !== scheduled) return;
        settle();
        store.update(id, { lastStatus: "error" });
        this.emit({ type: "error", jobId: id, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        admissions.delete(controller);
        if (admissions.size === 0 && this.admissions.get(id) === admissions) this.admissions.delete(id);
      });
      return;
    }
    this.spawnJob({ store, pi, ctx, manager }, id, selection);
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
  private spawnJob({ store, pi, ctx, manager }: BoundSession, id: string, selection: ModelSelection): void {
    const job = store.get(id);
    if (!job) return;

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
      store.update(id, { lastRun: new Date(this.clock.now()).toISOString(), lastStatus: "error" });
      this.emit({ type: "error", jobId: id, error });
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    store.update(id, { runPid: process.pid, runAgentId: agentId });
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    const finalize = (status: "success" | "error") => {
      if (this.store === store) {
        const left = (this.inFlight.get(id) ?? 1) - 1;
        if (left > 0) this.inFlight.set(id, left);
        else this.inFlight.delete(id);
      }
      const next = this.getNextRun(id);
      const current = store.get(id);
      store.update(id, {
        lastRun: new Date(this.clock.now()).toISOString(),
        lastStatus: status,
        runPid: undefined,
        runAgentId: undefined,
        runCount: (current?.runCount ?? 0) + 1,
        nextRun: next,
      });
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
