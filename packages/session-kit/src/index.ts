/**
 * pi-session-kit: session-scoped extensions. No daemon and no shared state: every feature keeps its
 * state in session entries (or per-session files) so concurrent pi processes never see each other.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Clock } from "./clock.ts";
import { agentDir, configPath, type Feature, type KitConfig, loadConfig } from "./config.ts";
import { register as registerDiff } from "./diff/index.ts";
import { register as registerGoal } from "./goal/index.ts";
import { register as registerLoop } from "./loop/index.ts";
import { registerMon } from "./mon/index.ts";
import { createSamplerSource } from "./mon/source.ts";
import { register as registerMonitor } from "./monitor/index.ts";
import type { MonitorProcess, SpawnOptions } from "./monitor/process.ts";
import { register as registerRules } from "./rules/index.ts";
import { register as registerStats } from "./stats/index.ts";
import { register as registerTitles } from "./titles/index.ts";

/** Explicit configuration and filesystem roots for SDK hosts; omitted values keep CLI defaults. */
export interface SessionKitOptions {
	config?: KitConfig;
	agentDir?: string;
	/** Home for user-scoped defaults when an agent directory is not supplied. */
	homeDir?: string;
	monitorRoot?: string;
	/** Time for stats ranges, loops, goal wakes, monitor batching/timeouts and /mon cadence. Defaults to real time. */
	clock?: Clock;
	/** Child boundary only; validation, matching, ring buffering and message delivery stay in the manager. */
	spawnMonitor?: (argv: readonly string[], options: SpawnOptions) => Promise<MonitorProcess>;
}

type Register = (pi: ExtensionAPI, config: KitConfig, options: SessionKitOptions) => void;

const MODULES: Record<Feature, Register> = {
	titles: (pi, config, options) =>
		registerTitles(
			pi,
			config,
			options.agentDir ?? (options.homeDir === undefined ? undefined : agentDir(options.homeDir)),
		),
	rules: (pi, config, options) =>
		registerRules(
			pi,
			config,
			options.agentDir ?? (options.homeDir === undefined ? undefined : agentDir(options.homeDir)),
			options.homeDir,
		),
	goal: (pi, config, options) => registerGoal(pi, config, options.clock),
	loop: (pi, config, options) => registerLoop(pi, config, options.clock),
	monitor: (pi, config, options) =>
		registerMonitor(pi, config, options.monitorRoot, { clock: options.clock, spawnMonitor: options.spawnMonitor }),
	diff: registerDiff,
	stats: (pi, config, options) => registerStats(pi, config, options),
	mon: (pi, _config, options) => registerMon(pi, { createSource: () => createSamplerSource(), clock: options.clock }),
};

/** Create the real kit without requiring a machine-local agent configuration. */
export function createSessionKit(options: SessionKitOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const config = options.config ?? loadConfig(configPath(options.agentDir ?? agentDir(options.homeDir)));
		for (const [feature, register] of Object.entries(MODULES) as [Feature, Register][]) {
			if (config.features[feature]) register(pi, config, options);
		}
	};
}

export default createSessionKit();
