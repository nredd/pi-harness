import { sandboxAgentDir } from "@nredd/pi-test-lib/sandbox";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { assertTestTimeoutWithinCap } from "./test-timeout-policy.js";

const testRoot = process.env.PI_CODING_AGENT_DIR;
if (!testRoot) throw new Error("Vitest global setup did not provide PI_CODING_AGENT_DIR");
const agentDir = sandboxAgentDir(testRoot);

afterAll(agentDir.restore);

beforeEach((context) => {
  assertTestTimeoutWithinCap(context.task.timeout, context.task.fullTestName);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
