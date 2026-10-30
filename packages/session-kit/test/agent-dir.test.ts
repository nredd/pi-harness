/** Characterize the shared call-time directory resolver and its existing public exports. */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentDir } from "../src/agent-dir.ts";
import { agentDir as configAgentDir } from "../src/config.ts";
import { agentDir as statsAgentDir } from "../src/stats/load.ts";

afterEach(() => vi.unstubAllEnvs());

it("preserves the configuration and stats exports as one resolver", () => {
	expect(configAgentDir).toBe(agentDir);
	expect(statsAgentDir).toBe(agentDir);
});

it("resolves the environment override at call time ahead of an injected home", () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
	expect(agentDir("/injected-home")).toBe(join("/injected-home", ".pi", "agent"));
	vi.stubEnv("PI_CODING_AGENT_DIR", "/overridden-agent");
	expect(agentDir("/injected-home")).toBe("/overridden-agent");
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
	expect(agentDir("/injected-home")).toBe("");
});

it("retains native home lookup when no home or environment override is supplied", () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
	expect(agentDir()).toBe(join(homedir(), ".pi", "agent"));
});
