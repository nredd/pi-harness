/** Resolve the shared agent directory at call time without changing process-global home state. */

import { homedir } from "node:os";
import { join } from "node:path";

/** Preserve the environment override, otherwise use the injected or native home. */
export function agentDir(homeDir = homedir()): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homeDir, ".pi", "agent");
}
