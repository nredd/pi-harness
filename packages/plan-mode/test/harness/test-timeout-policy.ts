export const maximumTestTimeoutMs = 5_000;

/** The one test allowed past the cap; `build-runtime.test.ts` names itself with this. */
export const jitiRuntimeLoadTestName = "generated runtime is loadable by Pi's Jiti resource loader";

/**
 * jiti Babel-transforms the freshly built `dist/index.ts` plus its static chunk, cold, in a fresh
 * `mkdtemp` that no cache can hit (#312). Measured: 0.37-0.46s alone, 2.76-3.12s under 50
 * self-terminating spinners, at most 1.36s hosted and 6.27s in a local 3-slot gate
 * (`issue158-gate7.log`). Budget is twice the worst gate figure. Rule and job IDs:
 * `docs/test-worker-budgets.md#measured-cold-budgets-312` (owner decision on #312, 2026-11-03).
 */
export const jitiRuntimeLoadBudgetMs = 13_000;

/** The one real `fs.watch` smoke test (#636); its name is pinned by `settings-watch-native.test.ts`. */
export const nativeWatchTestName = "the native directory watcher reloads settings once its stream is live";

/**
 * FSEvents stream start measured at 0.1-12.1 s on a degraded macOS host (#636). Budget is twice
 * the worst start; `docs/test-worker-budgets.md#native-directory-watch-budget-636`.
 */
export const nativeWatchBudgetMs = 25_000;

/** Tests allowed past the cap, each by exact name and only up to its own measured budget. */
export const measuredTestBudgetsMs: ReadonlyMap<string, number> = new Map([
  [jitiRuntimeLoadTestName, jitiRuntimeLoadBudgetMs],
  [nativeWatchTestName, nativeWatchBudgetMs],
]);

export type TimeoutTask = {
  name: string;
  type: string;
  timeout?: number;
  tasks?: readonly TimeoutTask[];
};

export function assertTestTasksWithinCap(tasks: readonly TimeoutTask[]): void {
  for (const task of tasks) {
    if (task.type === "test") {
      assertTestTimeoutWithinCap(task.timeout, task.name);
    }
    if (task.tasks) assertTestTasksWithinCap(task.tasks);
  }
}

export function assertTestTimeoutWithinCap(timeoutMs: number | undefined, testName: string): void {
  const maximumMs = measuredTestBudgetsMs.get(testName) ?? maximumTestTimeoutMs;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximumMs) {
    return;
  }
  throw new Error(`Test ${JSON.stringify(testName)} has a ${timeoutMs} ms timeout; the maximum is ${maximumMs} ms`);
}
