import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertTestTasksWithinCap,
  assertTestTimeoutWithinCap,
  jitiRuntimeLoadBudgetMs,
  maximumTestTimeoutMs,
  measuredTestBudgetsMs,
} from "./harness/test-timeout-policy.js";

const jitiTest = "generated runtime is loadable by Pi's Jiti resource loader";

test("every test is capped at the default maximum", () => {
  assertTestTimeoutWithinCap(maximumTestTimeoutMs, "ordinary");
  for (const timeout of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, maximumTestTimeoutMs + 1]) {
    assert.throws(
      () => assertTestTimeoutWithinCap(timeout, "ordinary"),
      new RegExp(`Test "ordinary" has a ${timeout} ms timeout; the maximum is ${maximumTestTimeoutMs} ms`, "u"),
    );
  }
});

test("a measured budget admits only its named test, only up to that budget", () => {
  assert.deepEqual([...measuredTestBudgetsMs], [[jitiTest, jitiRuntimeLoadBudgetMs]]);
  assertTestTimeoutWithinCap(jitiRuntimeLoadBudgetMs, jitiTest);
  assert.throws(
    () => assertTestTimeoutWithinCap(jitiRuntimeLoadBudgetMs + 1, jitiTest),
    new RegExp(`the maximum is ${jitiRuntimeLoadBudgetMs} ms`, "u"),
  );
  assert.throws(
    () => assertTestTimeoutWithinCap(jitiRuntimeLoadBudgetMs, `${jitiTest} (copy)`),
    new RegExp(`the maximum is ${maximumTestTimeoutMs} ms`, "u"),
  );
});

test("collection walks nested suites and checks only tests", () => {
  const nested = (timeout: number) => [
    { name: "suite", type: "suite", timeout: 60_000, tasks: [{ name: "inner", type: "test", timeout }] },
  ];
  assertTestTasksWithinCap(nested(maximumTestTimeoutMs));
  assert.throws(() => assertTestTasksWithinCap(nested(maximumTestTimeoutMs + 1)), /Test "inner"/u);
});
