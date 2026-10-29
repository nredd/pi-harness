/**
 * Per-feature switches for pi-session-kit, read from `~/.pi/agent/pi-session-kit.json`.
 *
 * Every feature defaults to on. A missing or malformed file yields the defaults; a malformed file
 * is reported on stderr once so a typo never silently disables the kit.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FEATURES = ["titles", "rules", "goal", "loop", "monitor", "diff", "stats", "mon"] as const;
export type Feature = (typeof FEATURES)[number];

export interface KitConfig {
	features: Record<Feature, boolean>;
	/** Explicit auto-title model selection; malformed values intentionally fail closed. */
	titleModel?: string;
	monitor: MonitorWidgetConfig;
}

/** `monitor.*` widget settings, mirroring rpiv-todo's `collapseKey` / `maxWidgetLines`. */
export interface MonitorWidgetConfig {
	/** Key spec that collapses/expands the widget, or `"off"` for no binding. */
	collapseKey: string;
	/** Content-row budget including the heading, excluding the trailing spacer; floor `MIN_WIDGET_LINES`. */
	maxWidgetLines: number;
}

export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+m";
export const COLLAPSE_KEY_OFF = "off";
export const DEFAULT_MAX_WIDGET_LINES = 12;
/** Heading + two edge hints + one row: below this a scrolled window shows nothing. */
export const MIN_WIDGET_LINES = 4;

// Named keys accepted by pi-tui's `matchesKey`; lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Strict pi-tui KeyId grammar: distinct modifiers, then one printable char or a named key.
 * Loose checks are not enough: pi-tui takes the LAST `+` part as the key and ignores unknown
 * parts, so a typo like `ctr+]` would silently bind every bare `]`.
 */
export function isValidKeySpec(spec: string): boolean {
	if (!spec || spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size || !modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/** Trim and lowercase; `"off"` disables, anything missing or invalid falls back to the default. */
export function resolveCollapseKey(raw: unknown): string {
	const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (key === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidKeySpec(key) ? key : DEFAULT_COLLAPSE_KEY;
}

/** Resolve the agent configuration directory at call time; an injected home avoids runtime-global home lookup. */
export function agentDir(homeDir = homedir()): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homeDir, ".pi", "agent");
}

export function configPath(directory?: string, homeDir = homedir()): string {
	return join(directory ?? agentDir(homeDir), "pi-session-kit.json");
}

export function defaultConfig(): KitConfig {
	return {
		features: Object.fromEntries(FEATURES.map((f) => [f, true])) as Record<Feature, boolean>,
		monitor: { collapseKey: DEFAULT_COLLAPSE_KEY, maxWidgetLines: DEFAULT_MAX_WIDGET_LINES },
	};
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
	const monitor = doc.monitor;
	if (typeof monitor === "object" && monitor !== null) {
		const section = monitor as Record<string, unknown>;
		config.monitor.collapseKey = resolveCollapseKey(section.collapseKey);
		const lines = section.maxWidgetLines;
		if (typeof lines === "number" && Number.isInteger(lines) && lines >= MIN_WIDGET_LINES)
			config.monitor.maxWidgetLines = lines;
	}
	const titles = doc.titles;
	if (typeof titles === "object" && titles !== null) {
		const model = (titles as Record<string, unknown>).model;
		if (typeof model === "string") config.titleModel = model;
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
