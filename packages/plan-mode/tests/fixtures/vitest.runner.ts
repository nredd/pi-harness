import { type RunnerTestFile, TestRunner } from "vitest";
import { assertTestTasksWithinCap } from "./test-timeout-policy.ts";

export default class TestPolicyRunner extends TestRunner {
  onBeforeRunFiles(files: RunnerTestFile[]): void {
    assertTestTasksWithinCap(files);
  }
}
