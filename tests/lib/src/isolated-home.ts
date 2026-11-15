/** The environment a nested Vitest or npm child gets so it never reads the operator's home. */
import { join } from "node:path";

/** Every home-derived variable a Vitest child must not inherit; one place for each new guarded var. */
export function isolatedHomeEnv(home: string): Record<string, string> {
	return {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_SUBAGENTS_CONFIG_DIR: join(home, ".pi", "agent"),
	};
}
