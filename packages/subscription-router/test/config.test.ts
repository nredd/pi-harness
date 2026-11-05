import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILE, loadConfig, parseConfig } from "../src/config.js";

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
	let dir: string | undefined;
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("treats a missing file as no profiles and reports invalid JSON with the path", async () => {
		dir = await mkdtemp(join(tmpdir(), "router-config-"));
		expect(await loadConfig(dir)).toEqual({ ok: true, profiles: [] });
		await writeFile(join(dir, CONFIG_FILE), "{ nope");
		const result = await loadConfig(dir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(join(dir, CONFIG_FILE));
	});

	it("reports filesystem errors other than a missing config", async () => {
		dir = await mkdtemp(join(tmpdir(), "router-config-"));
		await mkdir(join(dir, CONFIG_FILE));
		const result = await loadConfig(dir);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.startsWith(`${join(dir, CONFIG_FILE)}: EISDIR`)).toBe(true);
	});

	it("reports a well-formed document that fails validation with the path and the validation error", async () => {
		dir = await mkdtemp(join(tmpdir(), "router-config-"));
		await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ profiles: { a: { chain: [] } } }));
		expect(await loadConfig(dir)).toEqual({
			ok: false,
			error: `${join(dir, CONFIG_FILE)}: profiles.a.chain: expected a non-empty array`,
		});
	});
});
