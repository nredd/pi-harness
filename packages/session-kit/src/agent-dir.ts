/** Resolve the shared agent directory at call time without changing process-global home state. */

import { homedir } from "node:os";
import { join } from "node:path";

/** Explicit SDK roots: an agent directory wins over a home it would otherwise derive from. */
export interface AgentDirOptions {
	agentDir?: string;
	homeDir?: string;
}

/** Preserve the environment override, otherwise use the injected or native home. */
export function agentDir(homeDir = homedir()): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homeDir, ".pi", "agent");
}

/** The explicit agent directory, else the one derived from `homeDir` (or the native home) right now. */
export function resolveAgentDir(options: AgentDirOptions): string {
	return options.agentDir ?? agentDir(options.homeDir);
}
