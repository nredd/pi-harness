/**
 * process-budget.ts -- one ceiling on running subagents for the whole pi process.
 *
 * `maxConcurrent` and `maxConcurrentForeground` are per `AgentManager`, and
 * there can be more than one manager per process: `/new`, `/resume`, `/fork`
 * and `/reload` activate a fresh one and leave the previous manager alive until
 * its background agents finish. (Subagent sessions do not activate this
 * extension; nested children run in the parent's manager.) Those pools also
 * exempt nested children, workflow children, scheduled jobs and resumes. The budget is the one count all of them share, kept on `globalThis`
 * under `Symbol.for` so every manager and every module instance (a `/reload`
 * loads a fresh copy of this file) sees the same state.
 *
 * Scope is the PROCESS, not the machine: two pi processes each get their own
 * budget. It bounds running agents, not CPU, memory or commands.
 *
 * Every run holds one lease from the moment it is admitted until it actually
 * settles. A parent keeps its lease while it waits on a child: releasing it
 * around a nested call would be wrong, because pi runs a turn's tool calls in
 * parallel and the parent's other tools are still executing.
 *
 * Holding parent leases is what makes a plain cap deadlock: twelve parents
 * each waiting on a child that can never start. The reserve prevents it. With
 * `L` the policy's `maxDepth` (one value for the whole process, NOT a branch's
 * own cap) and `limit(j) = maxActive - nestedReserve * (L - j)`, a run at depth
 * `d` is admitted only while, for EVERY level `j` from `d` to `L`,
 *
 *   active at depth <= j      < limit(j)
 *
 * (`j = L` is the plain `active < maxActive`). So with `maxActive: 12,
 * nestedReserve: 2, L: 2`, at most ten top-level runs hold slots at once, and
 * the last two only ever go to depth-2 children. Every admission keeps
 * `count(<= j) <= limit(j)` for all `j`, releases only lower counts, and
 * policy changes that could break it wait for an idle process (see
 * `setBudgetPolicy`). Suppose every holder is a parent blocked on a child and
 * `k < L` is the deepest level holding any: then `active = count(<= k) <=
 * limit(k) < limit(k + 1) <= maxActive`, so a depth-`k+1` child fits at every
 * level. Leaves (depth `L`) never wait on anyone, so they finish. That needs
 * `limit` strictly increasing and `limit(1) >= 1` -- `isCoherent` -- and a run
 * deeper than `L` refused outright (`assertWithinBudgetDepth`), since nothing
 * reserves a slot for it. Top-level, workflow and scheduled runs all count as
 * depth 1.
 *
 * Waiters are served first-come-first-served among the ELIGIBLE: a deeper
 * waiter may pass a shallower one whose threshold is not met, which is what the
 * reserve is for. Without that, a root at the head of the line would block the
 * child that its own siblings are waiting on.
 */

const BUDGET_KEY = Symbol.for("pi-subagents:process-budget");

/** Bumped on any incompatible change to `BudgetState`'s shape. */
const BUDGET_VERSION = 2;

/**
 * Queued starts the budget will hold while it is enabled. Only a bound on
 * memory and on runaway fan-out -- a full queue fails the spawn with
 * `BUDGET_QUEUE_FULL_ERROR` instead of parking work nobody will see start.
 */
export const MAX_PENDING_SUBAGENTS = 128;

export const DEFAULT_BUDGET_POLICY: Readonly<BudgetPolicy> = {
  maxActive: 0,
  nestedReserve: 2,
  maxDepth: 2,
};

export interface BudgetPolicy {
  /** Process-wide ceiling on running subagents. `0` = off (counted, never enforced). */
  maxActive: number;
  /** Slots held back per nesting level below a run, so children can always start. */
  nestedReserve: number;
  /**
   * The deepest level the reserve covers: the GLOBAL `maxSubagentDepth`, so a
   * project file cannot reshape a process-wide policy. A deeper run is refused.
   */
  maxDepth: number;
}

/** One admitted run. Released exactly once; later releases are no-ops. */
export interface BudgetLease {
  readonly depth: number;
  released: boolean;
}

/** A start waiting for admission. */
export interface BudgetWaiter {
  /** Nesting depth of the run: top-level = 1. */
  depth: number;
  /** Local conditions the owner also needs (its own pool limits). */
  ready: () => boolean;
  /** Takes ownership of the lease. Must not throw; a throw is swallowed and the lease released. */
  grant: (lease: BudgetLease) => void;
}

interface BudgetState {
  version: number;
  policy: BudgetPolicy;
  /** A tightening change, applied once no lease is active (`setBudgetPolicy`). */
  pendingPolicy: BudgetPolicy | undefined;
  active: Set<BudgetLease>;
  waiters: BudgetWaiter[];
  pumping: boolean;
  repump: boolean;
}

export const BUDGET_QUEUE_FULL_ERROR =
  `Subagent queue is full (${MAX_PENDING_SUBAGENTS} waiting for the process-wide maxActiveSubagents limit). `
  + "Wait for running agents to finish, or do the work directly.";

function freshState(): BudgetState {
  return {
    version: BUDGET_VERSION,
    policy: { ...DEFAULT_BUDGET_POLICY },
    pendingPolicy: undefined,
    active: new Set(),
    waiters: [],
    pumping: false,
    repump: false,
  };
}

/**
 * The process's budget state. An incompatible version (a `/reload` onto a
 * build that changed the shape) refuses budget operations until pi restarts.
 * Never fork the state: two private counts could each admit the whole cap.
 */
function state(): BudgetState {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[BUDGET_KEY] as BudgetState | undefined;
  if (existing === undefined) {
    const created = freshState();
    g[BUDGET_KEY] = created;
    return created;
  }
  if (existing.version === BUDGET_VERSION) return existing;
  throw new Error(
    `[pi-subagents] Incompatible process budget v${String(existing.version)} already loaded (this build uses v${String(BUDGET_VERSION)}). `
    + "Restart pi before starting more subagents; no private budget will be created.",
  );
}

/** The deepest level `policy` reserves for; nesting off still means one level. */
const topLevel = (policy: BudgetPolicy): number => Math.max(1, policy.maxDepth);

/**
 * How many runs at depth <= `level` may hold leases before a run at `level` or
 * shallower has to wait. No floor: `isCoherent` keeps it at least one.
 */
export function admissionLimit(policy: BudgetPolicy, level: number): number {
  if (policy.maxActive <= 0) return Number.POSITIVE_INFINITY;
  return policy.maxActive - policy.nestedReserve * (topLevel(policy) - level);
}

/**
 * Whether `policy` is deadlock-free: off, or `limit` strictly increasing from
 * at least one at depth 1 -- a reserve of one or more, and room for one
 * top-level run after reserving for every level below it.
 */
export function isCoherent(policy: BudgetPolicy): boolean {
  if (policy.maxActive <= 0 || topLevel(policy) === 1) return true;
  return policy.nestedReserve >= 1 && admissionLimit(policy, 1) >= 1;
}

/** Every level's limit is at least what it was, so no held lease can block a child that fit before. */
function relaxes(from: BudgetPolicy, to: BudgetPolicy): boolean {
  if (to.maxActive <= 0) return true;
  if (from.maxActive <= 0 || topLevel(from) !== topLevel(to)) return false;
  for (let level = 1; level <= topLevel(to); level++) {
    if (admissionLimit(to, level) < admissionLimit(from, level)) return false;
  }
  return true;
}

export function getBudgetPolicy(): BudgetPolicy {
  return { ...state().policy };
}

/**
 * Replace the policy. Last writer wins: every activation in the process
 * shares it. An incoherent policy is refused with a warning. A change that
 * could strand a waiting child -- turning the budget on, lowering a limit,
 * changing `maxDepth` -- is held until no lease is active, since running
 * parents were admitted under the old limits; turning it off or raising
 * limits applies at once.
 */
export function setBudgetPolicy(next: BudgetPolicy): void {
  const policy: BudgetPolicy = {
    maxActive: Math.max(0, Math.floor(next.maxActive)),
    nestedReserve: Math.max(0, Math.floor(next.nestedReserve)),
    maxDepth: Math.max(0, Math.floor(next.maxDepth)),
  };
  if (!isCoherent(policy)) {
    console.warn(
      `[pi-subagents] Ignoring maxActiveSubagents ${String(policy.maxActive)} with nestedSubagentReserve ${String(policy.nestedReserve)} `
      + `at maxSubagentDepth ${String(policy.maxDepth)}: it could deadlock. Nesting needs a reserve of at least 1 and `
      + "maxActiveSubagents >= nestedSubagentReserve * (maxSubagentDepth - 1) + 1.",
    );
    return;
  }
  const s = state();
  if (s.active.size === 0 || relaxes(s.policy, policy)) {
    s.policy = policy;
    s.pendingPolicy = undefined;
    pumpBudget();
  } else {
    s.pendingPolicy = policy;
    console.warn(
      `[pi-subagents] Process budget change deferred until all running subagents settle: `
      + `maxActiveSubagents=${String(policy.maxActive)}, nestedSubagentReserve=${String(policy.nestedReserve)}, `
      + `maxSubagentDepth=${String(policy.maxDepth)}. The previous policy remains in force; continuous work can delay this indefinitely.`,
    );
  }
}

/** The policy waiting for the process to go idle, if any. For diagnostics and tests. */
export function getPendingBudgetPolicy(): BudgetPolicy | undefined {
  const pending = state().pendingPolicy;
  return pending === undefined ? undefined : { ...pending };
}

/**
 * Throw when the budget is on and a run at `depth` is deeper than its policy
 * reserves for: it could wait forever behind its own ancestors. Pass/fail is
 * fixed for the run's life, since `maxDepth` changes only while idle.
 */
export function assertWithinBudgetDepth(depth: number): void {
  const { policy } = state();
  if (policy.maxActive > 0 && depth > topLevel(policy)) {
    throw new Error(
      `Nested subagent at depth ${String(depth)} exceeds the process budget's depth ${String(topLevel(policy))} `
      + "(global maxSubagentDepth). Complete the task directly.",
    );
  }
}

/** Running leases and waiting starts, for diagnostics and tests. */
export function budgetUsage(): { active: number; pending: number; maxActive: number } {
  const s = state();
  return { active: s.active.size, pending: s.waiters.length, maxActive: s.policy.maxActive };
}

function admits(s: BudgetState, depth: number): boolean {
  const { policy } = s;
  if (policy.maxActive <= 0) return true;
  const top = topLevel(policy);
  const level = Math.max(1, depth);
  if (level > top) return false;
  // Leases deeper than `top` cannot exist while it is on; clamp so they still count in the total.
  const atDepth = new Array<number>(top + 1).fill(0);
  for (const lease of s.active) {
    const index = Math.min(top, Math.max(1, lease.depth));
    atDepth[index] = atDepth[index]! + 1;
  }
  let atOrAbove = 0;
  for (let j = 1; j <= top; j++) {
    atOrAbove += atDepth[j]!;
    if (j >= level && atOrAbove >= admissionLimit(policy, j)) return false;
  }
  return true;
}

function newLease(s: BudgetState, depth: number): BudgetLease {
  const lease: BudgetLease = { depth, released: false };
  s.active.add(lease);
  return lease;
}

/**
 * Take a lease now, or undefined when this depth is at its limit or an earlier
 * eligible waiter has first claim. Completion listeners can spawn synchronously
 * between release and drain; re-entrant grant callbacks can do the same.
 */
export function tryAcquireBudget(depth: number): BudgetLease | undefined {
  const s = state();
  if (!admits(s, depth) || s.waiters.some(waiter => admits(s, waiter.depth) && waiter.ready())) return undefined;
  return newLease(s, depth);
}

/** Whether another waiter fits. Always true while the budget is off. */
export function budgetHasPendingRoom(): boolean {
  const s = state();
  return s.policy.maxActive <= 0 || s.waiters.length < MAX_PENDING_SUBAGENTS;
}

/** Join the queue. Returns a cancel function; cancelling a granted waiter is a no-op. */
export function enqueueBudget(waiter: BudgetWaiter): () => void {
  state().waiters.push(waiter);
  return () => {
    const s = state();
    const i = s.waiters.indexOf(waiter);
    if (i !== -1) s.waiters.splice(i, 1);
  };
}

/**
 * Give a lease back. Idempotent; does not pump, so callers keep their own
 * ordering. The last release applies a held policy change.
 */
export function releaseBudget(lease: BudgetLease | undefined): void {
  if (lease === undefined || lease.released) return;
  lease.released = true;
  const s = state();
  s.active.delete(lease);
  if (s.active.size === 0 && s.pendingPolicy !== undefined) {
    s.policy = s.pendingPolicy;
    s.pendingPolicy = undefined;
  }
}

/**
 * Admit every waiter that fits, earliest first, re-scanning after each grant
 * because a grant changes the counts (`ready()` reads the owner's pools).
 * Re-entrant calls from inside a grant are folded into the running loop.
 */
export function pumpBudget(): void {
  const s = state();
  if (s.pumping) {
    s.repump = true;
    return;
  }
  s.pumping = true;
  try {
    do {
      s.repump = false;
      for (;;) {
        const i = s.waiters.findIndex(w => admits(s, w.depth) && w.ready());
        if (i === -1) break;
        const waiter = s.waiters.splice(i, 1)[0]!;
        const lease = newLease(s, waiter.depth);
        try {
          waiter.grant(lease);
        } catch {
          releaseBudget(lease);
        }
      }
    } while (s.repump);
  } finally {
    s.pumping = false;
  }
}

/** Test-only: forget all leases and waiters and restore the default policy. */
export function resetBudgetForTests(): void {
  const g = globalThis as Record<symbol, unknown>;
  g[BUDGET_KEY] = freshState();
}
