import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, vi } from "vitest";
import { readRouterQuota } from "../../session-kit/src/stats/router-quota.ts";
import { registerCollector } from "../src/collectors.ts";
import { ExhaustionTracker } from "../src/exhaustion.ts";
import subscriptionRouter from "../src/index.ts";
import { UsageService } from "../src/usage.ts";
import { bindViewStore } from "../src/view-store.ts";

// Keep the synthetic Gemini reading independent of when a built-in collector ships.
vi.mock("../src/builtin-collectors.ts", async (original) => {
	const { BUILTIN_COLLECTORS } = await original<typeof import("../src/builtin-collectors.ts")>();
	return { BUILTIN_COLLECTORS: BUILTIN_COLLECTORS.filter(({ provider }) => provider !== "antigravity") };
});

const SHARED_KEY = Symbol.for("pi-subscription-router.shared");
const host = globalThis as typeof globalThis & { [SHARED_KEY]?: unknown };
const statePath = (root: string) => join(root, "router-state", "v1");
const NOW = 1_800_000_000_000;

afterEach(() => {
	delete host[SHARED_KEY];
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("publishes the default router cache for the real /stats reader without changing usage RPC", async ({
	onTestFinished,
}) => {
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
		const rows = await readRouterQuota(root, NOW);
		expect(Object.fromEntries(rows.map(({ label, head }) => [label, head]))).toEqual({
			"Anthropic five_hour": { kind: "gauge", percent: 25 },
			"OpenAI 5h (assumed span)": { kind: "gauge", percent: 15 },
			"Gemini 5h": { kind: "gauge", percent: 35 },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		unregister();
		await handlers.get("session_shutdown")?.[0]?.({}, ctx);
		expect((await readRouterQuota(root, NOW)).map((row) => row.label)).not.toContain("Gemini 5h");
	} finally {
		unregister();
	}
});

it("publishes the latest marks and clears them without a usage read", async ({ onTestFinished }) => {
	const root = makeTestTempDir("router-quota-", onTestFinished);
	const tracker = new ExhaustionTracker(() => NOW);
	const store = bindViewStore(root, new UsageService(), tracker);
	const model = { provider: "faux", id: "model" };
	const decision = { block: true, window: "daily", scope: "provider", resetAt: NOW + 60_000 } as const;
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
	const clean = bindViewStore(cleanRoot, new UsageService(), new ExhaustionTracker());
	const destination = join(statePath(cleanRoot), "view.json");
	await mkdir(destination, { recursive: true });
	await clean.schedule();
	expect(await readdir(statePath(cleanRoot))).toEqual(["view.json"]);
	await rmdir(destination);
	await clean.schedule();
	expect(await readFile(destination, "utf8")).toBe("[]");
});
