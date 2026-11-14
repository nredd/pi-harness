/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunOwner, ScheduledSubagent, ScheduleStoreData } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

/** How long a run claim stays valid without renewal. */
export const LEASE_MS = 120_000;
/** How often a live owner renews its lease. */
export const LEASE_RENEW_MS = 30_000;

/**
 * Is `pid` a live process? (signal 0 probe). EPERM means it exists but belongs
 * to another user, so it is alive. `kill` is injectable for tests.
 */
export function isProcessRunning(pid: number, kill: (pid: number, signal: 0) => unknown = (p, sig) => process.kill(p, sig)): boolean {
  try { kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** Does another live process hold a valid lease? A claim by this pid never counts: its runs are tracked in-process. */
export function foreignOwnerLive(owner: RunOwner | undefined, now: number): boolean {
  return owner !== undefined && owner.pid !== process.pid && owner.leaseUntil > now && isProcessRunning(owner.pid);
}

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore — try again */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire schedule lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Backing file path (identifies the store across rebuilt instances). */
  get path(): string {
    return this.filePath;
  }

  /** Re-read the backing file, picking up writes made through another instance. */
  reload(): void {
    this.load();
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Load from disk into the in-memory cache. Silent on parse errors. */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data: ScheduleStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.jobs.clear();
      for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
    } catch { /* corrupt — start fresh, next save rewrites */ }
  }

  /** Atomic write via temp file + rename (POSIX-atomic). */
  private save(): void {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Acquire lock → reload → mutate → save → release. */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      this.jobs.set(job.id, job);
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.jobs.has(id)) return undefined;
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      this.jobs.set(id, updated);
      return updated;
    });
  }

  /**
   * Claim a fire under the store lock: reload, verify the job is still enabled,
   * before its deadline and not held by another live process, then write
   * `lastStatus: "running"` and the owner in the same write. Returns the job
   * (with the status it replaced as `prior`), or undefined when the fire is lost.
   */
  claim(id: string, owner: RunOwner, now: number): { job: ScheduledSubagent; prior: ScheduledSubagent["lastStatus"] } | undefined {
    return this.withLock(() => {
      const job = this.jobs.get(id);
      if (!job?.enabled) return undefined;
      if (job.until !== undefined && now >= new Date(job.until).getTime()) return undefined;
      if (job.lastStatus === "running" && foreignOwnerLive(job.runOwner, now)) return undefined;
      const claimed: ScheduledSubagent = { ...job, lastStatus: "running", runOwner: owner };
      this.jobs.set(id, claimed);
      return { job: claimed, prior: job.lastStatus };
    });
  }

  /** Extend this process's claim; a claim lost to another owner or removed is left alone. */
  renewLease(id: string, owner: RunOwner): void {
    this.withLock(() => {
      const job = this.jobs.get(id);
      if (job?.runOwner?.pid === owner.pid) this.jobs.set(id, { ...job, runOwner: owner });
    });
  }

  remove(id: string): boolean {
    // No-op fast path — see update().
    if (!this.jobs.has(id)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
