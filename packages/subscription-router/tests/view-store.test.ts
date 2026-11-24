import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, vi } from "vitest";
import { registerCollector } from "../src/collectors.ts";
import { ExhaustionTracker } from "../src/exhaustion.ts";
import subscriptionRouter from "../src/index.ts";
import { type RegistryContext, UsageService } from "../src/usage.ts";
import { bindViewStore, MAX_VIEW_BYTES } from "../src/view-store.ts";
import { readRouterQuota } from "./fixtures/view-reader.ts";

// Keep the synthetic Gemini reading independent of when a built-in collector ships.
vi.mock("../src/builtin-collectors.ts", async (original) => {
	const { BUILTIN_COLLECTORS } = await original<typeof import("../src/builtin-collectors.ts")>();
	return { BUILTIN_COLLECTORS: BUILTIN_COLLECTORS.filter(({ provider }) => provider !== "antigravity") };
});

const SHARED_KEY = Symbol.for("pi-subscription-router.shared");
const host = globalThis as typeof globalThis & { [SHARED_KEY]?: unknown };
const statePath = (root: string) => join(root, "router-state", "v1");
const NOW = 1_800_000_000_000;
const fixture = new URL("./fixtures/router-view.json", import.meta.url);
const fixtureViews = async (): Promise<{ provider: string }[]> => JSON.parse(await readFile(fixture, "utf8"));
const model = { provider: "faux", id: "model" };
const decision = { block: true, window: "daily", scope: "provider", resetAt: NOW + 60_000 } as const;
const ctx = { modelRegistry: { getApiKeyForProvider: async () => "omit-credential" } } as unknown as RegistryContext;
const makeUsage = () => new UsageService({ fetch, now: () => NOW, getAccessToken: async () => "omit-credential" });

afterEach(() => {
	delete host[SHARED_KEY];
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("matches the fresh writer fixture without changing usage RPC", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const display = { full: "Gemini", compact: "Gem", extra: "omit-display-extra" };
	const unregister = registerCollector({
		provider: "antigravity",
		kind: "custom",
		display,
		read: async () => ({ windows: [{ name: "5h", usedPercent: 35, resetAt: NOW + 60_000, scope: "provider" }] }),
	});
	let retired = false;
	try {
		const events = new EventEmitter();
		const { pi, handlers } = createRecordingPi({
			overrides: {
				events: {
					on: (name, handler) => {
						events.on(name, handler);
						return () => void events.off(name, handler);
					},
					emit: (name, data) => void events.emit(name, data),
				},
			},
		});
		const fetch = vi.fn(async (url: string) => {
			const body = url.includes("anthropic")
				? { five_hour: { utilization: 25, resets_at: new Date(NOW + 60_000).toISOString() } }
				: { rate_limit: { primary_window: { used_percent: 15, reset_at: (NOW + 60_000) / 1000 } } };
			return Response.json(body);
		});
		vi.stubGlobal("fetch", fetch);
		await subscriptionRouter(pi);
		const ctx = {
			scopedModels: [],
			modelRegistry: { getApiKeyForProvider: async () => "omit-credential" },
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({}, ctx);
		const reply = new Promise((resolve) => events.once("router:rpc:usage:reply:quota", resolve));
		events.emit("router:rpc:usage", { requestId: "quota", refresh: true });
		expect(await reply).toEqual({ success: true, data: { snapshots: expect.any(Array), blocks: [] } });
		await handlers.get("session_shutdown")?.[0]?.({}, ctx);

		const raw = await readFile(join(statePath(root), "view.json"), "utf8");
		expect(raw).not.toContain("omit-");
		expect(JSON.parse(raw)).toEqual((await fixtureViews()).filter(({ provider }) => provider !== "alias"));
		const rows = await readRouterQuota(root, NOW);
		expect(Object.fromEntries(rows.map(({ label, head }) => [label, head]))).toEqual({
			"Anthropic five_hour": { kind: "gauge", percent: 25 },
			"OpenAI 5h (assumed span)": { kind: "gauge", percent: 15 },
			"Gemini 5h": { kind: "gauge", percent: 35 },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		unregister();
		retired = true;
		await handlers.get("session_shutdown")?.[0]?.({}, ctx);
		expect((await readRouterQuota(root, NOW)).map((row) => row.label)).not.toContain("Gemini 5h");
	} finally {
		if (!retired) unregister();
	}
});

it("publishes the latest marks and clears them without a usage read", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const tracker = new ExhaustionTracker(() => NOW);
	const store = bindViewStore(root, new UsageService(), tracker);
	tracker.mark(model, decision);
	await store.flush();
	expect((await readRouterQuota(root, NOW)).map((row) => row.label)).toEqual(["faux daily"]);
	tracker.clear();
	await store.flush();
	expect(await readRouterQuota(root, NOW)).toEqual([]);
	tracker.mark(model, { ...decision, window: "x".repeat(1024 * 1024) });
	await store.flush();
	expect(await readFile(join(statePath(root), "view.json"), "utf8")).toBe("[]");
});

it("ignores a symlinked state directory and cleans up a failed atomic replacement", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const other = makeTestTempDir("router-other-", onTestFinished);
	const stateRoot = join(root, "router-state");
	await symlink(other, stateRoot, "dir");
	const store = bindViewStore(root, new UsageService(), new ExhaustionTracker());
	await store.schedule();
	expect(await readdir(other)).toEqual([]);
	const cleanRoot = makeTestTempDir("router-quota-", onTestFinished);
	const tracker = new ExhaustionTracker(() => NOW);
	const clean = bindViewStore(cleanRoot, new UsageService(), tracker);
	const destination = join(statePath(cleanRoot), "view.json");
	await mkdir(destination, { recursive: true });
	tracker.mark(model, decision);
	await clean.flush();
	expect(await readdir(statePath(cleanRoot))).toEqual(["view.json"]);
	await rmdir(destination);
	await clean.schedule();
	expect(await readRouterQuota(cleanRoot, NOW)).toHaveLength(1);
});

it("cold publisher preserves live rows", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const liveTracker = new ExhaustionTracker(() => NOW);
	const live = bindViewStore(root, makeUsage(), liveTracker);
	const families = Array.from({ length: 4 }, (_, i) => String(i).padEnd(256, "界"));
	onTestFinished(
		registerCollector({
			provider: model.provider,
			kind: "custom",
			read: async () => ({
				windows: Array.from({ length: 128 }, (_, i) => ({
					name: `window-${i}`,
					usedPercent: 50,
					scope: "model",
					families,
				})),
			}),
		}),
	);
	liveTracker.mark(model, decision);
	await live.flush();
	const rows = await readRouterQuota(root, NOW);
	expect(rows.map(({ label }) => label)).toEqual(["faux daily"]);

	const coldUsage = makeUsage();
	const cold = bindViewStore(root, coldUsage, new ExhaustionTracker());
	await cold.flush();
	await cold.schedule();
	expect(await readRouterQuota(root, NOW)).toEqual(rows);
	const oversized = await coldUsage.get(ctx, model.provider);
	expect(oversized.status).toBe("available");
	expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_VIEW_BYTES / 4);
	await cold.flush();
	expect(await readRouterQuota(root, NOW)).toEqual(rows);
});

it("oversized reading does not retain cleared blocks", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const usage = makeUsage();
	const tracker = new ExhaustionTracker(() => NOW);
	const store = bindViewStore(root, usage, tracker);
	const giant = "large-source";
	const families = Array.from({ length: 128 }, (_, i) => String(i).padEnd(256, "界"));
	onTestFinished(
		registerCollector({
			provider: giant,
			kind: "custom",
			read: async () => ({
				windows: Array.from({ length: 128 }, (_, i) => ({
					name: `window-${i}`,
					usedPercent: 99,
					scope: "model",
					families,
				})),
			}),
		}),
	);
	let percent = 20;
	onTestFinished(
		registerCollector({
			provider: model.provider,
			kind: "custom",
			read: async () => ({ windows: [{ name: "weekly", usedPercent: percent, scope: "provider" }] }),
		}),
	);
	await usage.get(ctx, model.provider);
	tracker.mark({ ...model, provider: giant }, decision);
	await store.flush();
	expect((await readRouterQuota(root, NOW)).map(({ label }) => label)).toEqual(["faux weekly", "large-source daily"]);

	const oversized = await usage.get(ctx, giant);
	expect(oversized.status).toBe("available");
	expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_VIEW_BYTES);
	await store.flush();
	expect((await readRouterQuota(root, NOW)).map(({ label }) => label)).toEqual(["faux weekly", "large-source daily"]);
	percent = 70;
	usage.invalidate(model.provider);
	await usage.get(ctx, model.provider);
	tracker.clear();
	await store.flush();
	expect(await readRouterQuota(root, NOW)).toEqual([
		expect.objectContaining({ label: "faux weekly", head: { kind: "gauge", percent: 70 } }),
	]);
});

it("matches the stale alias writer fixture with a mark, meter and pool", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const usage = makeUsage();
	const tracker = new ExhaustionTracker(() => NOW);
	const store = bindViewStore(root, usage, tracker);
	let failed = false;
	const register = (provider: string, full: string) =>
		onTestFinished(
			registerCollector({
				provider,
				kind: "custom",
				display: { full, compact: full },
				read: async () => {
					if (failed) throw new Error("Synthetic quota read failed");
					return {
						windows: [{ name: "weekly", usedPercent: 40, scope: "provider" }],
						meters: [
							{
								name: "daily",
								scope: "provider",
								quantity: { unit: "requests", used: 1, limit: 5 },
								resetAt: NOW + 60_000,
								resetRule: { at: "00:00", timeZone: "UTC", every: "day" },
							},
						],
						pools: [{ name: "paid", unit: "credits", role: "prepaid", balance: 10 }],
					};
				},
			}),
		);
	register("alias", "Wrong collector");
	register("source", "Producing collector");
	const alias = { ...model, provider: "alias" };
	usage.configureCollectors({ alias: { collector: { id: "source" } } });
	tracker.mark(alias, { ...decision, evidence: "observed" });
	await store.flush();
	expect((await readRouterQuota(root, NOW)).map(({ label }) => label)).toEqual(["alias daily"]);
	expect((await usage.get(ctx, alias.provider)).status).toBe("available");
	failed = true;
	expect((await usage.get(ctx, alias.provider, { force: true })).status).toBe("stale");
	await store.flush();
	const raw = await readFile(join(statePath(root), "view.json"), "utf8");
	expect(JSON.parse(raw)).toEqual((await fixtureViews()).filter(({ provider }) => provider === alias.provider));
});

it("omits unused Codex balance text and stale diagnostic messages", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	let now = NOW;
	const source = vi.fn(async () =>
		Response.json({
			rate_limit: { primary_window: { used_percent: 30, reset_at: (NOW + 3_600_000) / 1000 } },
			credits: { has_credits: true, unlimited: false, balance: "omit-codex-balance" },
		}),
	);
	const usage = new UsageService({ fetch: source, now: () => now, getAccessToken: async () => "token" });
	const store = bindViewStore(root, usage, new ExhaustionTracker());
	expect((await usage.get(ctx, "openai-codex")).credits?.balance).toBe("omit-codex-balance");
	await store.flush();
	const path = join(statePath(root), "view.json");
	expect(await readFile(path, "utf8")).not.toContain("omit-codex-balance");
	now += 6 * 60_000;
	source.mockImplementationOnce(async () => new Response(null, { status: 503 }));
	const stale = await usage.get(ctx, "openai-codex");
	expect(stale).toMatchObject({ status: "stale", message: expect.any(String) });
	await store.flush();
	expect(await readFile(path, "utf8")).not.toContain('"message"');
	expect((await readRouterQuota(root, now)).map(({ label }) => label)).toEqual(["OpenAI 5h (assumed span) (stale)"]);
});

it("caps the total view and still admits later small rows", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const tracker = new ExhaustionTracker(() => NOW);
	const store = bindViewStore(root, makeUsage(), tracker);
	const large = "界".repeat(Math.floor(MAX_VIEW_BYTES / 15));
	for (let i = 0; i < 5; i++) tracker.mark({ ...model, provider: `provider-${i}` }, { ...decision, window: large });
	tracker.mark(model, decision);
	await store.flush();
	const raw = await readFile(join(statePath(root), "view.json"), "utf8");
	expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_VIEW_BYTES);
	const rows = await readRouterQuota(root, NOW);
	expect(rows).toHaveLength(5);
	expect(rows.at(-1)?.label).toBe("faux daily");
});

it("unsubscribes from cache and tracker updates", async ({ onTestFinished }) => {
	const usage = makeUsage();
	const tracker = new ExhaustionTracker(() => NOW);
	const listener = vi.fn();
	const stopUsage = usage.subscribe(listener);
	const stopTracker = tracker.subscribe(listener);
	onTestFinished(
		registerCollector({
			provider: model.provider,
			kind: "custom",
			read: async () => ({ windows: [] }),
		}),
	);
	await usage.get(ctx, model.provider);
	tracker.mark(model, decision);
	expect(listener).toHaveBeenCalledTimes(2);
	stopUsage();
	stopTracker();
	usage.invalidate(model.provider);
	tracker.clear();
	expect(listener).toHaveBeenCalledTimes(2);
});

it("keeps the view byte limit at the 1 MiB the /stats reader enforces", () => {
	expect(MAX_VIEW_BYTES).toBe(1024 * 1024);
});
