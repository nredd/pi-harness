/** Characterize the shared call-time directory resolver. */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentDir, resolveAgentDir } from "../src/agent-dir.ts";

afterEach(() => vi.unstubAllEnvs());

it("prefers an explicit agent directory over the injected home", () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
	expect(resolveAgentDir({ agentDir: "/explicit-agent", homeDir: "/injected-home" })).toBe("/explicit-agent");
	expect(resolveAgentDir({ homeDir: "/injected-home" })).toBe(join("/injected-home", ".pi", "agent"));
	expect(resolveAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
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
