import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished } from "vitest";
import { CONFIG_FILE, loadConfig, parseConfig, parseConfigDocument } from "../src/config.ts";
import { parseConfig as legacyParseConfig } from "./fixtures/legacy-oracle/config.ts";
import { POLICY_CASES } from "./fixtures/policy-cases.ts";

function expectLegacyProfiles(document: { profiles: Record<string, Record<string, unknown>> }): void {
	// The pre-policy oracle omits policy. Restore that opt-in field verbatim from each fixture.
	const profiles = legacyParseConfig(document).map(({ exhaustion, ...profile }) => {
		const policy = document.profiles[profile.id]?.policy;
		return { ...profile, ...(policy === undefined ? {} : { policy }), ...(exhaustion ? { exhaustion } : {}) };
	});
	expect(parseConfigDocument(document)).toStrictEqual({ profiles });
	expect(JSON.stringify(parseConfig(document))).toBe(JSON.stringify(profiles));
}

it.each(["subscription-router", "policies"])("preserves the existing %s config example", async (name) => {
	expectLegacyProfiles(JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), "utf8")));
});

it.each(POLICY_CASES)("preserves the existing policy config fixture $policy", ({ policy, valid }) => {
	const document = { profiles: { test: { policy, chain: [{ model: "p/a" }] } } };
	if (valid) expectLegacyProfiles(document);
	else expect(() => parseConfigDocument(document)).toThrow("profiles.test.policy");
});

it("keeps unknown root, profile and chain keys ignored and omits missing providers", () => {
	const document = { unknown: true, profiles: { a: { chain: [{ model: "p/a", unknown: true }], unknown: true } } };
	expectLegacyProfiles(document);
});

it("keeps provider IDs and model limits independent of Object.prototype", () => {
	const raw = JSON.parse(
		'{"profiles":{},"providers":{"__proto__":{"label":{"full":"New Provider","compact":"New"},"windows":[{"name":"quota","kind":"rolling","durationMinutes":1,"scope":"model","unit":"tokens","limits":{"__proto__":25}}]}}}',
	);
	const { providers } = parseConfigDocument(raw);
	expect(Object.getPrototypeOf(providers)).toBeNull();
	expect(providers?.constructor).toBeUndefined();
	const limits = Object.values(providers ?? {})[0]?.windows?.[0]?.limits;
	expect(Object.getPrototypeOf(limits)).toBeNull();
	expect(limits).toEqual(JSON.parse('{"__proto__":25}'));
});

describe("parseConfig", () => {
	it("ships valid opt-in cheap and frontier profiles rather than registering implicit defaults", async () => {
		const raw = JSON.parse(await readFile(new URL("../examples/subscription-router.json", import.meta.url), "utf8"));
		expect(parseConfig(raw)).toEqual([
			{
				id: "cheap",
				name: "Router cheap",
				strategy: "ordered",
				exhaustion: { policy: "wait" },
				chain: [
					{ provider: "anthropic", id: "claude-haiku-5-5" },
					{ provider: "openai-codex", id: "gpt-6-luna" },
				],
			},
			{
				id: "frontier",
				name: "Router frontier",
				strategy: "balanced",
				exhaustion: { policy: "wait" },
				chain: [
					{ provider: "anthropic", id: "claude-fable-5-1" },
					{ provider: "openai-codex", id: "gpt-6-astra" },
				],
			},
		]);
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.files).toContain("examples");
	});
	it("parses profiles into chains with optional pinned thinking", () => {
		const profiles = parseConfig({
			profiles: {
				default: {
					chain: [{ model: "anthropic/claude-sonnet-5-5" }, { model: "openai-codex/gpt-5.6-terra", thinking: "high" }],
				},
				deep: { name: "Deep", chain: [{ model: "anthropic/claude-opus-5-5" }] },
			},
		});
		expect(profiles).toEqual([
			{
				id: "default",
				name: "Router default",
				chain: [
					{ provider: "anthropic", id: "claude-sonnet-5-5" },
					{ provider: "openai-codex", id: "gpt-5.6-terra", thinking: "high" },
				],
			},
			{ id: "deep", name: "Deep", chain: [{ provider: "anthropic", id: "claude-opus-5-5" }] },
		]);
	});

	it.each(["ordered", "balanced"])("parses explicit strategy %s", (strategy) => {
		expect(parseConfig({ profiles: { a: { strategy, chain: [{ model: "a/b" }] } } })[0]?.strategy).toBe(strategy);
	});

	it("parses the exhaustion policy and wait cap", () => {
		const [profile] = parseConfig({
			profiles: { a: { chain: [{ model: "a/b" }], exhaustionPolicy: "fail", maxWaitMinutes: 90 } },
		});
		expect(profile?.exhaustion).toEqual({ policy: "fail", maxWaitMs: 90 * 60_000 });
		const [capOnly] = parseConfig({ profiles: { a: { chain: [{ model: "a/b" }], maxWaitMinutes: 1 } } });
		expect(capOnly?.exhaustion).toEqual({ policy: "wait", maxWaitMs: 60_000 });
	});

	it("keeps slashes after the provider in the model id", () => {
		const [profile] = parseConfig({ profiles: { a: { chain: [{ model: "openrouter/meta/llama" }] } } });
		expect(profile?.chain[0]).toEqual({ provider: "openrouter", id: "meta/llama" });
	});

	it.each([
		[
			{ profiles: { a: { strategy: "fast", chain: [{ model: "a/b" }] } } },
			/profiles.a.strategy: expected ordered or balanced/,
		],
		[
			{ profiles: { a: { chain: [{ model: "a/b" }], exhaustionPolicy: "retry" } } },
			/exhaustionPolicy: expected one of fail, wait/,
		],
		[
			{ profiles: { a: { chain: [{ model: "a/b" }], maxWaitMinutes: 0 } } },
			/maxWaitMinutes: expected a positive number/,
		],
		[null, /expected a JSON object/],
		[{}, /profiles: expected an object/],
		[{ profiles: { "Bad Id": { chain: [{ model: "a/b" }] } } }, /profiles.Bad Id: id must match/],
		[{ profiles: { a: { chain: [] } } }, /profiles.a.chain: expected a non-empty array/],
		[{ profiles: { a: null } }, /profiles.a: expected an object/],
		[{ profiles: { a: [] } }, /profiles.a: expected an object/],
		[{ profiles: { a: { chain: ["a/b"] } } }, /chain\[0\]: expected an object/],
		[{ profiles: { a: { chain: [null] } } }, /chain\[0\]: expected an object/],
		[{ profiles: { a: { chain: [{ model: 3 }] } } }, /chain\[0\].model: expected "provider\/model-id"/],
		[{ profiles: { a: { chain: [{ model: "nomodel" }] } } }, /chain\[0\].model: expected "provider\/model-id"/],
		[{ profiles: { a: { chain: [{ model: "a/" }] } } }, /chain\[0\].model/],
		[{ profiles: { a: { chain: [{ model: "router/b" }] } } }, /cannot name another router model/],
		[{ profiles: { a: { chain: [{ model: "a/b", thinking: "huge" }] } } }, /chain\[0\].thinking/],
		[{ profiles: { a: { chain: [{ model: "a/b" }, { model: "a/b" }] } } }, /a\/b is listed twice/],
		[{ profiles: { a: { name: 3, chain: [{ model: "a/b" }] } } }, /profiles.a.name/],
	])("rejects %j", (raw, message) => {
		expect(() => parseConfig(raw)).toThrow(message);
	});
});

describe("loadConfig", () => {
	it("loads arbitrary provider and collector IDs from disk without registering profiles or inserting defaults", async () => {
		const dir = makeTestTempDir("router-config-", onTestFinished);
		const raw = await readFile(new URL("../examples/providers.json", import.meta.url), "utf8");
		await writeFile(join(dir, CONFIG_FILE), raw);
		const result = await loadConfig(dir);
		expect(result).toEqual({ ok: true, ...JSON.parse(raw), profiles: [] });
	});

	it("rejects the whole file when a provider declaration fails", async () => {
		const dir = makeTestTempDir("router-config-", onTestFinished);
		const path = join(dir, CONFIG_FILE);
		await writeFile(
			path,
			JSON.stringify({ profiles: { a: { chain: [{ model: "p/a" }] } }, providers: { p: { typo: 1 } } }),
		);
		expect(await loadConfig(dir)).toEqual({ ok: false, error: `${path}: providers.p.typo: unknown key` });
	});

	it("rejects a syntactically valid but unknown IANA zone", () => {
		expect(() =>
			parseConfig({
				profiles: {},
				providers: {
					p: {
						windows: [
							{
								name: "daily",
								unit: "requests",
								scope: "model",
								kind: "calendar",
								resetRule: { at: "00:00", timeZone: "Unknown/Nowhere", every: "day" },
							},
						],
					},
				},
			}),
		).toThrow('providers.p.windows[0].resetRule.timeZone: unknown IANA time zone "Unknown/Nowhere"');
	});

	it("rejects limits that overflow to infinity when decoded", () => {
		const raw = JSON.parse(
			'{"profiles":{},"providers":{"p":{"windows":[{"name":"spend","kind":"rolling","durationMinutes":10,"unit":"usd","scope":"provider","limits":1e999}]}}}',
		);
		expect(() => parseConfig(raw)).toThrow("providers.p.windows[0].limits: expected a finite positive number");
	});
	it("treats a missing file as no profiles and reports invalid JSON with the path", async () => {
		const dir = makeTestTempDir("router-config-", onTestFinished);
		expect(await loadConfig(dir)).toEqual({ ok: true, profiles: [] });
		await writeFile(join(dir, CONFIG_FILE), "{ nope");
		const result = await loadConfig(dir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(join(dir, CONFIG_FILE));
	});

	it("reports filesystem errors other than a missing config", async () => {
		const dir = makeTestTempDir("router-config-", onTestFinished);
		await mkdir(join(dir, CONFIG_FILE));
		const result = await loadConfig(dir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.startsWith(`${join(dir, CONFIG_FILE)}: EISDIR`)).toBe(true);
	});

	it("reports a well-formed document that fails validation with the path and the validation error", async () => {
		const dir = makeTestTempDir("router-config-", onTestFinished);
		await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ profiles: { a: { chain: [] } } }));
		expect(await loadConfig(dir)).toEqual({
			ok: false,
			error: `${join(dir, CONFIG_FILE)}: profiles.a.chain: expected a non-empty array`,
		});
	});
});
