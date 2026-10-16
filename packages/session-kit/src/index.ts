/**
 * pi-session-kit: session-scoped extensions. No daemon and no shared state: every feature keeps its
 * state in session entries (or per-session files) so concurrent pi processes never see each other.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Feature, loadConfig } from "./config.ts";
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

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	for (const [feature, register] of Object.entries(MODULES) as [Feature, (typeof MODULES)[Feature]][]) {
		if (config.features[feature]) register(pi, config);
	}
}
