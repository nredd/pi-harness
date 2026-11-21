/**
 * `<agentDir>/subscription-router.json`: the router profiles.
 *
 * Each profile becomes one virtual model `router/<id>` whose ordered `chain`
 * names physical models. A missing file registers nothing; an invalid one is
 * rejected whole with a message, never partially applied.
 *
 * ```json
 * {
 *   "profiles": {
 *     "default": {
 *       "name": "Router default",
 *       "chain": [
 *         { "model": "anthropic/claude-sonnet-5-5" },
 *         { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" }
 *       ],
 *       "exhaustionPolicy": "wait",
 *       "maxWaitMinutes": 360
 *     }
 *   }
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseRef, refKey } from "./model-ref.ts";
import { type PolicyV1, parsePolicy } from "./policy.ts";

export const CONFIG_FILE = "subscription-router.json";

/** Provider the virtual models are listed under. */
export const ROUTER_PROVIDER = "router";

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** One physical model in a chain. `thinking` pins its level; otherwise the selected level passes through. */
export interface ChainEntry {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

/** What a caller that can wait should do when every quota-eligible entry is exhausted. */
export type ExhaustionPolicy = "fail" | "wait";

export const EXHAUSTION_POLICIES: readonly ExhaustionPolicy[] = ["fail", "wait"];

/** `policy` defaults to "wait"; `maxWaitMs` (unset = no limit) caps how far ahead a reset may be waited for. */
export interface Exhaustion {
	policy: ExhaustionPolicy;
	maxWaitMs?: number;
}

/** Ordered is backwards-compatible; balanced spends reset-aware quota across providers. */
export type Strategy = "ordered" | "balanced";

export interface Profile {
	strategy?: Strategy;
	policy?: PolicyV1;
	id: string;
	name: string;
	chain: ChainEntry[];
	/** Only set when the profile configures `exhaustionPolicy` or `maxWaitMinutes`. */
	exhaustion?: Exhaustion;
}

type EvidenceSource = "read" | "failure" | "observed";

interface FailureConfig {
	parser?: "generic" | "google-rpc";
	minHintSeconds?: number;
	repeat?: { count: number; withinMinutes: number };
	maxBlockMinutes?: number;
}

/** Locally declared quota, not a collector reading. An absent limit is unknown. */
export type WindowConfig = { name: string; unit: "requests" | "tokens" | "usd" } & (
	| { scope: "model"; limits?: Readonly<Record<string, number>> }
	| { scope: "provider"; limits?: number }
) &
	(
		| { kind: "rolling"; durationMinutes: number }
		| { kind: "calendar"; resetRule: { at: string; timeZone: string; every: "day" | "week" } }
	);

/** Provider IDs and collector IDs are data, not a built-in list or module paths. */
export interface ProviderConfig {
	label?: { full: string; compact: string };
	quotaGroup?: string;
	evidence?: EvidenceSource[];
	fallbackOnReadError?: boolean;
	failure?: FailureConfig;
	windows?: WindowConfig[];
	collector?: { id?: string; options?: Record<string, unknown> };
}

interface ConfigDocument {
	profiles: Profile[];
	/** Absent in legacy documents. Only explicit declarations are returned. */
	providers?: Readonly<Record<string, ProviderConfig>>;
}

/** Loaded config, or the reason it was rejected. */
export type ConfigResult = ({ ok: true } & ConfigDocument) | { ok: false; error: string };

const PROVIDER_ID = /^[^\s/]+$/;
const COLLECTOR_ID = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NON_BLANK = /\S/;
const RESET_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const EVIDENCE = ["read", "failure", "observed"] as const;

function object(value: unknown, where: string, keys?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected an object`);
	if (keys) {
		for (const key of Object.keys(value)) {
			if (!keys.includes(key)) throw new Error(`${where}.${key}: unknown key`);
		}
	}
	return value as Record<string, unknown>;
}

function textField(value: unknown, pattern: RegExp, where: string, expected: string): asserts value is string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${where}: expected ${expected}`);
}

function positive(value: unknown, where: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${where}: expected a finite positive number`);
	}
}

function oneOf(value: unknown, choices: readonly string[], where: string): void {
	if (!(choices as readonly unknown[]).includes(value))
		throw new Error(`${where}: expected one of ${choices.join(", ")}`);
}

function validateFailure(raw: unknown, where: string): void {
	const { parser, minHintSeconds, repeat, maxBlockMinutes } = object(raw, where, [
		"parser",
		"minHintSeconds",
		"repeat",
		"maxBlockMinutes",
	]);
	if (parser !== undefined) oneOf(parser, ["generic", "google-rpc"], `${where}.parser`);
	if (minHintSeconds !== undefined) {
		if (typeof minHintSeconds !== "number" || !Number.isFinite(minHintSeconds) || minHintSeconds < 0) {
			throw new Error(`${where}.minHintSeconds: expected a finite non-negative number`);
		}
	}
	if (maxBlockMinutes !== undefined) {
		positive(maxBlockMinutes, `${where}.maxBlockMinutes`);
		if (maxBlockMinutes > 1440) throw new Error(`${where}.maxBlockMinutes: must not exceed 1440`);
	}
	if (repeat !== undefined) {
		const { count, withinMinutes } = object(repeat, `${where}.repeat`, ["count", "withinMinutes"]);
		positive(count, `${where}.repeat.count`);
		if (!Number.isSafeInteger(count)) throw new Error(`${where}.repeat.count: expected a safe integer`);
		positive(withinMinutes, `${where}.repeat.withinMinutes`);
	}
}

function validateReset(raw: unknown, where: string): void {
	const { at, timeZone, every } = object(raw, where, ["at", "timeZone", "every"]);
	textField(at, RESET_TIME, `${where}.at`, "24-hour HH:MM");
	textField(timeZone, ZONE_NAME, `${where}.timeZone`, "an IANA time zone name");
	try {
		new Intl.DateTimeFormat("en", { timeZone });
	} catch {
		throw new Error(`${where}.timeZone: unknown IANA time zone ${JSON.stringify(timeZone)}`);
	}
	oneOf(every, ["day", "week"], `${where}.every`);
}

function parseWindow(raw: unknown, where: string): WindowConfig {
	const window = object(raw, where);
	const { name, kind, unit, scope, limits, durationMinutes, resetRule } = window;
	oneOf(kind, ["rolling", "calendar"], `${where}.kind`);
	object(window, where, [
		"name",
		"kind",
		"unit",
		"scope",
		"limits",
		kind === "calendar" ? "resetRule" : "durationMinutes",
	]);
	textField(name, NON_BLANK, `${where}.name`, "a non-blank string");
	oneOf(unit, ["requests", "tokens", "usd"], `${where}.unit`);
	oneOf(scope, ["model", "provider"], `${where}.scope`);
	if (kind === "calendar") validateReset(resetRule, `${where}.resetRule`);
	else positive(durationMinutes, `${where}.durationMinutes`);
	if (limits === undefined) return window as WindowConfig;
	if (scope === "provider") {
		positive(limits, `${where}.limits`);
		return window as WindowConfig;
	}
	const byModel: Record<string, number> = Object.create(null);
	for (const [id, limit] of Object.entries(object(limits, `${where}.limits`))) {
		textField(id, NON_BLANK, `${where}.limits`, "non-blank model-id keys");
		positive(limit, `${where}.limits[${JSON.stringify(id)}]`);
		byModel[id] = limit;
	}
	return { ...(window as WindowConfig), scope: "model", limits: byModel };
}

function parseProvider(raw: unknown, where: string): ProviderConfig {
	const provider = object(raw, where, [
		"label",
		"quotaGroup",
		"evidence",
		"fallbackOnReadError",
		"failure",
		"windows",
		"collector",
	]);
	const { label, quotaGroup, evidence, fallbackOnReadError, failure, windows, collector } = provider;
	if (label !== undefined) {
		const { full, compact } = object(label, `${where}.label`, ["full", "compact"]);
		textField(full, NON_BLANK, `${where}.label.full`, "a non-blank string");
		textField(compact, NON_BLANK, `${where}.label.compact`, "a non-blank string");
	}
	if (quotaGroup !== undefined) textField(quotaGroup, NON_BLANK, `${where}.quotaGroup`, "a non-blank string");
	if (evidence !== undefined) {
		if (!Array.isArray(evidence)) throw new Error(`${where}.evidence: expected an array`);
		for (const [index, source] of evidence.entries()) oneOf(source, EVIDENCE, `${where}.evidence[${index}]`);
		if (new Set(evidence).size !== evidence.length) throw new Error(`${where}.evidence: duplicate source`);
	}
	if (fallbackOnReadError !== undefined && typeof fallbackOnReadError !== "boolean") {
		throw new Error(`${where}.fallbackOnReadError: expected a boolean`);
	}
	if (failure !== undefined) validateFailure(failure, `${where}.failure`);
	if (collector !== undefined) {
		const { id, options } = object(collector, `${where}.collector`, ["id", "options"]);
		if (id !== undefined)
			textField(id, COLLECTOR_ID, `${where}.collector.id`, "a lowercase kebab-case id (1-64 characters)");
		if (options !== undefined) object(options, `${where}.collector.options`);
	}
	if (windows === undefined) return provider as ProviderConfig;
	if (!Array.isArray(windows)) throw new Error(`${where}.windows: expected an array`);
	return {
		...provider,
		windows: windows.map((entry, index) => parseWindow(entry, `${where}.windows[${index}]`)),
	} as ProviderConfig;
}

function parseProviders(raw: unknown): Readonly<Record<string, ProviderConfig>> {
	// A provider named "constructor" is data, not an inherited property.
	const providers: Record<string, ProviderConfig> = Object.create(null);
	for (const [id, value] of Object.entries(object(raw, "providers"))) {
		textField(id, PROVIDER_ID, "providers", "non-blank provider ids without spaces or slashes");
		providers[id] = parseProvider(value, `providers.${id}`);
	}
	return providers;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]*$/;

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseEntry(raw: unknown, where: string): ChainEntry {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
	const { model, thinking } = raw as Record<string, unknown>;
	if (typeof model !== "string") throw new Error(`${where}.model: expected "provider/model-id"`);
	const ref = parseRef(model);
	if (!ref) throw new Error(`${where}.model: expected "provider/model-id"`);
	if (ref.provider === ROUTER_PROVIDER) throw new Error(`${where}.model: a chain cannot name another router model`);
	if (thinking !== undefined && !isThinkingLevel(thinking)) {
		throw new Error(`${where}.thinking: expected one of ${THINKING_LEVELS.join(", ")}`);
	}
	return thinking === undefined ? ref : { ...ref, thinking };
}

function parseExhaustion(policy: unknown, maxWaitMinutes: unknown, where: string): Exhaustion | undefined {
	if (policy === undefined && maxWaitMinutes === undefined) return undefined;
	if (policy !== undefined && !(EXHAUSTION_POLICIES as readonly unknown[]).includes(policy)) {
		throw new Error(`${where}.exhaustionPolicy: expected one of ${EXHAUSTION_POLICIES.join(", ")}`);
	}
	if (maxWaitMinutes !== undefined && (typeof maxWaitMinutes !== "number" || !(maxWaitMinutes > 0))) {
		throw new Error(`${where}.maxWaitMinutes: expected a positive number`);
	}
	return {
		policy: (policy as ExhaustionPolicy | undefined) ?? "wait",
		...(maxWaitMinutes === undefined ? {} : { maxWaitMs: (maxWaitMinutes as number) * 60_000 }),
	};
}

function parseProfiles(profiles: unknown): Profile[] {
	if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
		throw new Error("profiles: expected an object of id -> profile");
	}
	return Object.entries(profiles).map(([id, value]) => {
		const where = `profiles.${id}`;
		if (!PROFILE_ID.test(id)) throw new Error(`${where}: id must match ${PROFILE_ID}`);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: expected an object`);
		const { name, chain, exhaustionPolicy, maxWaitMinutes, strategy, policy, policyByCaller } = value as Record<
			string,
			unknown
		>;
		if (policy !== undefined && strategy !== undefined)
			throw new Error(`${where}: policy and strategy are mutually exclusive`);
		if (policy !== undefined && policyByCaller !== undefined)
			throw new Error(`${where}.policyByCaller: unsupported in policy v1`);
		const parsedPolicy = policy === undefined ? undefined : parsePolicy(policy, `${where}.policy`);
		if (strategy !== undefined && strategy !== "ordered" && strategy !== "balanced") {
			throw new Error(`${where}.strategy: expected ordered or balanced`);
		}
		if (name !== undefined && typeof name !== "string") throw new Error(`${where}.name: expected a string`);
		if (!Array.isArray(chain) || chain.length === 0) throw new Error(`${where}.chain: expected a non-empty array`);
		const entries = chain.map((entry, index) => parseEntry(entry, `${where}.chain[${index}]`));
		const seen = new Set<string>();
		for (const entry of entries) {
			const key = refKey(entry);
			if (seen.has(key)) throw new Error(`${where}.chain: ${key} is listed twice`);
			seen.add(key);
		}
		const exhaustion = parseExhaustion(exhaustionPolicy, maxWaitMinutes, where);
		const base: Profile = {
			id,
			name: typeof name === "string" ? name : `Router ${id}`,
			chain: entries,
			...(strategy === undefined ? {} : { strategy }),
			...(parsedPolicy === undefined ? {} : { policy: parsedPolicy }),
		};
		return exhaustion ? { ...base, exhaustion } : base;
	});
}

/** Validate a parsed config document. Throws with a path-qualified message. */
export function parseConfigDocument(raw: unknown): ConfigDocument {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
	const { profiles, providers } = raw as Record<string, unknown>;
	const parsed = parseProfiles(profiles);
	return providers === undefined ? { profiles: parsed } : { profiles: parsed, providers: parseProviders(providers) };
}

/** Keep the legacy profile-array API while validating the whole document. */
export function parseConfig(raw: unknown): Profile[] {
	return parseConfigDocument(raw).profiles;
}

/** Read `<agentDir>/subscription-router.json`. A missing file is an empty config. */
export async function loadConfig(agentDir: string): Promise<ConfigResult> {
	const path = join(agentDir, CONFIG_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		// `readFile` rejects only with a Node system error.
		const { code, message } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") return { ok: true, profiles: [] };
		return { ok: false, error: `${path}: ${message}` };
	}
	try {
		return { ok: true, ...parseConfigDocument(JSON.parse(text)) };
	} catch (error) {
		// `JSON.parse` throws a `SyntaxError` and `parseConfig` an `Error`.
		return { ok: false, error: `${path}: ${(error as Error).message}` };
	}
}
