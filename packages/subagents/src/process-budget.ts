/**
 * process-budget.ts -- one ceiling on running subagents for the whole pi process.
 *
 * `maxConcurrent` and `maxConcurrentForeground` are per `AgentManager`, and
 * there is more than one manager per process: every subagent session
 * re-activates this extension, and `/new`, `/resume`, `/fork` and `/reload`
 * leave the previous manager alive until its background agents finish. Those
 * pools also exempt nested children, workflow children, scheduled jobs and
 * resumes. The budget is the one count all of them share, kept on `globalThis`
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
 * each waiting on a child that can never start. The reserve prevents it. A run
 * at depth `d` on a branch whose nesting cap is `L` is admitted only while
 *
 *   active                    < maxActive, and
 *   active at depth <= d      < maxActive - nestedReserve * (L - d)
 *
 * so with `maxActive: 12, nestedReserve: 2, L: 2`, at most ten top-level runs
 * hold slots at once, and the last two only ever go to depth-2 children.
 * Suppose every holder is a parent blocked on a child, and `k` is the deepest
 * level holding any: then everything active is at depth <= k, at most
 * `limit(k)`, which is `nestedReserve` short of what a depth-`k+1` child needs
 * and below `maxActive`, so that child can start. Leaves (depth `L`) never
 * wait on anyone, so they finish. Top-level, workflow and scheduled runs all
 * count as depth 1.
 *
 * Waiters are served first-come-first-served among the ELIGIBLE: a deeper
 * waiter may pass a shallower one whose threshold is not met, which is what the
 * reserve is for. Without that, a root at the head of the line would block the
 * child that its own siblings are waiting on.
 */

const BUDGET_KEY = Symbol.for("pi-subagents:process-budget");

/** Bumped on any incompatible change to `BudgetState`'s shape. */
const BUDGET_VERSION = 1;

/**
 * Queued starts the budget will hold while it is enabled. Only a bound on
 * memory and on runaway fan-out -- a full queue fails the spawn with
 * `BUDGET_QUEUE_FULL_ERROR` instead of parking work nobody will see start.
 */
export const MAX_PENDING_SUBAGENTS = 128;

export const DEFAULT_NESTED_SUBAGENT_RESERVE = 2;

export interface BudgetPolicy {
  /** Process-wide ceiling on running subagents. `0` = off (counted, never enforced). */
  maxActive: number;
  /** Slots held back per nesting level below a run, so children can always start. */
  nestedReserve: number;
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
  /** The branch's effective nesting cap. */
  maxDepth: number;
  /** Local conditions the owner also needs (its own pool limits). */
  ready: () => boolean;
  /** Takes ownership of the lease. Must not throw; a throw is swallowed and the lease released. */
  grant: (lease: BudgetLease) => void;
}

interface BudgetState {
  version: number;
  policy: BudgetPolicy;
  active: Set<BudgetLease>;
  waiters: BudgetWaiter[];
  pumping: boolean;
  repump: boolean;
}

export const BUDGET_QUEUE_FULL_ERROR =
  `Subagent queue is full (${MAX_PENDING_SUBAGENTS} waiting for the process-wide maxActiveSubagents limit). `
  + "Wait for running agents to finish, or do the work directly.";

let privateState: BudgetState | undefined;

function freshState(): BudgetState {
  return {
    version: BUDGET_VERSION,
    policy: { maxActive: 0, nestedReserve: DEFAULT_NESTED_SUBAGENT_RESERVE },
    active: new Set(),
    waiters: [],
    pumping: false,
    repump: false,
  };
}

/**
 * The process's budget state. An incompatible version (a `/reload` onto a
 * build that changed the shape) gets a private budget instead of corrupting
 * the shared one; restarting pi restores a single count.
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
  if (privateState === undefined) {
    console.warn(
      `[pi-subagents] process budget v${String(existing.version)} already loaded; this instance uses a private budget until pi restarts`,
    );
    privateState = freshState();
  }
  return privateState;
}

/**
 * How many runs at depth <= `depth` may hold leases before another at `depth`,
 * on a branch capped at `maxDepth`, has to wait. `maxActive` still bounds the total.
 */
export function admissionLimit(policy: BudgetPolicy, depth: number, maxDepth: number): number {
  if (policy.maxActive <= 0) return Number.POSITIVE_INFINITY;
  const levelsBelow = Math.max(0, maxDepth - Math.max(1, depth));
  // Floor of one: a reserve too large for the cap would otherwise stall every
  // top-level run. Settings validation keeps sane configs clear of it.
  return Math.max(1, policy.maxActive - policy.nestedReserve * levelsBelow);
}

export function getBudgetPolicy(): BudgetPolicy {
  return { ...state().policy };
}

/** Update the policy. Last writer wins: every activation in the process shares it. */
export function setBudgetPolicy(update: Partial<BudgetPolicy>): void {
  const s = state();
  if (update.maxActive !== undefined) s.policy.maxActive = Math.max(0, Math.floor(update.maxActive));
  if (update.nestedReserve !== undefined) s.policy.nestedReserve = Math.max(0, Math.floor(update.nestedReserve));
  pumpBudget();
}

export function isBudgetEnabled(): boolean {
  return state().policy.maxActive > 0;
}

/** Running leases and waiting starts, for diagnostics and tests. */
export function budgetUsage(): { active: number; pending: number; maxActive: number } {
  const s = state();
  return { active: s.active.size, pending: s.waiters.length, maxActive: s.policy.maxActive };
}

function admits(s: BudgetState, depth: number, maxDepth: number): boolean {
  if (s.policy.maxActive <= 0) return true;
  if (s.active.size >= s.policy.maxActive) return false;
  const level = Math.max(1, depth);
  let atOrAbove = 0;
  for (const lease of s.active) if (Math.max(1, lease.depth) <= level) atOrAbove++;
  return atOrAbove < admissionLimit(s.policy, depth, maxDepth);
}

function newLease(s: BudgetState, depth: number): BudgetLease {
  const lease: BudgetLease = { depth, released: false };
  s.active.add(lease);
  return lease;
}

/**
 * Take a lease now, or undefined when this depth is at its limit. Never jumps
 * the queue: `pumpBudget` runs after every change, so no waiter is eligible
 * between calls, and a caller here competes only with ineligible waiters.
 */
export function tryAcquireBudget(depth: number, maxDepth: number): BudgetLease | undefined {
  const s = state();
  return admits(s, depth, maxDepth) ? newLease(s, depth) : undefined;
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

/** Give a lease back. Idempotent; does not pump, so callers keep their own ordering. */
export function releaseBudget(lease: BudgetLease | undefined): void {
  if (lease === undefined || lease.released) return;
  lease.released = true;
  state().active.delete(lease);
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
        const i = s.waiters.findIndex(w => admits(s, w.depth, w.maxDepth) && w.ready());
        if (i === -1) break;
        const [waiter] = s.waiters.splice(i, 1);
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
  privateState = undefined;
}
