/**
 * pi-session-kit: session-scoped extensions. No daemon and no shared state: every feature keeps its
 * state in session entries (or per-session files) so concurrent pi processes never see each other.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { configPath, type Feature, type KitConfig, loadConfig } from "./config.ts";
import { register as registerDiff } from "./diff/index.ts";
import { register as registerGoal } from "./goal/index.ts";
import { register as registerLoop } from "./loop/index.ts";
import { register as registerMonitor } from "./monitor/index.ts";
import { register as registerRules } from "./rules/index.ts";
import { register as registerStats } from "./stats/index.ts";
import { register as registerTitles } from "./titles/index.ts";

const MODULES: Record<Feature, (pi: ExtensionAPI, config: ReturnType<typeof loadConfig>) => void> = {
	titles: registerTitles,
	rules: registerRules,
	goal: registerGoal,
	loop: registerLoop,
	monitor: registerMonitor,
	diff: registerDiff,
	stats: registerStats,
};

/** Explicit configuration and filesystem roots for SDK hosts; omitted values keep CLI defaults. */
export interface SessionKitOptions {
	config?: KitConfig;
	agentDir?: string;
	monitorRoot?: string;
}

/** Create the real kit without requiring a machine-local agent configuration. */
export function createSessionKit(options: SessionKitOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const config = options.config ?? loadConfig(configPath(options.agentDir));
		for (const [feature, register] of Object.entries(MODULES) as [Feature, (typeof MODULES)[Feature]][]) {
			if (!config.features[feature]) continue;
			if (feature === "rules") registerRules(pi, config, options.agentDir);
			else if (feature === "titles") registerTitles(pi, config, options.agentDir);
			else if (feature === "monitor") registerMonitor(pi, config, options.monitorRoot);
			else register(pi, config);
		}
	};
}

export default createSessionKit();
