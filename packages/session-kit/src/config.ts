/**
 * Per-feature switches for pi-session-kit, read from `~/.pi/agent/pi-session-kit.json`.
 *
 * Every feature defaults to on. A missing or malformed file yields the defaults; a malformed file
 * is reported on stderr once so a typo never silently disables the kit.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FEATURES = ["titles", "rules", "goal", "loop", "monitor", "diff", "stats"] as const;
export type Feature = (typeof FEATURES)[number];

export interface KitConfig {
	features: Record<Feature, boolean>;
	/** Overrides the auto-title model, as `provider/id`. */
	titleModel?: string;
}

export function configPath(agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "pi-session-kit.json");
}

export function defaultConfig(): KitConfig {
	return { features: Object.fromEntries(FEATURES.map((f) => [f, true])) as Record<Feature, boolean> };
}

/** Parse a config document, ignoring unknown keys and wrong-typed values. */
export function parseConfig(raw: unknown): KitConfig {
	const config = defaultConfig();
	if (typeof raw !== "object" || raw === null) return config;
	const doc = raw as Record<string, unknown>;
	for (const feature of FEATURES) {
		const section = doc[feature];
		if (typeof section === "object" && section !== null) {
			const enabled = (section as Record<string, unknown>).enabled;
			if (typeof enabled === "boolean") config.features[feature] = enabled;
		}
	}
	const titles = doc.titles;
	if (typeof titles === "object" && titles !== null) {
		const model = (titles as Record<string, unknown>).model;
		if (typeof model === "string" && model.includes("/")) config.titleModel = model;
	}
	return config;
}

export function loadConfig(path = configPath()): KitConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
		console.error(`pi-session-kit: cannot read ${path}: ${(error as Error).message}`);
		return defaultConfig();
	}
	try {
		return parseConfig(JSON.parse(text));
	} catch (error) {
		console.error(`pi-session-kit: ${path} is not valid JSON (${(error as Error).message}); using defaults`);
		return defaultConfig();
	}
}
