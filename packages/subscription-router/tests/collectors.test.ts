import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { afterEach, expect, it, vi } from "vitest";
import {
	type Collector,
	type CollectorReading,
	collectedProviders,
	collectorFor,
	registerCollector,
} from "../src/collectors.ts";
import { createSubscriptionRouter } from "../src/index.ts";
import { COLLECTED_PROVIDERS, type RegistryContext, UsageService } from "../src/usage.ts";

const T0 = 1_700_000_000_000;
const provider = "faux-quota";
const reading: CollectorReading = {
	windows: [{ name: "faux-day", scope: "model", families: ["faux-one"], usedPercent: 100, resetAt: T0 + 60_000 }],
	meters: [{ name: "requests", scope: "provider", quantity: { unit: "requests", used: 12 } }],
	pools: [{ name: "extra", unit: "credits", role: "overage", balance: 42 }],
};
const ctx = { modelRegistry: {} } as RegistryContext;
const key = Symbol.for("pi-subscription-router.collectors");
const host = globalThis as typeof globalThis & {
	[key]: { version: number; register(collector: Collector): () => void };
};
const registry = host[key];
const fake: Collector = { provider, kind: "custom", read: async () => reading };
const cleanup: Array<() => void> = [];
const install = (collector: Collector) => {
	const remove = registerCollector(collector);
	cleanup.push(remove);
	return remove;
};

function harness() {
	vi.useFakeTimers();
	const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ percent: 100 }));
	const getAccessToken = vi.fn(async () => "fake-token");
	return { fetch, getAccessToken, usage: new UsageService({ fetch, getAccessToken, now: () => T0 }) };
}

afterEach(() => {
	for (const remove of cleanup.splice(0).reverse()) remove();
	vi.useRealTimers();
});

it("shares the registry with an extension that does not import the router", async () => {
	expect(registry.version).toBe(1);
	cleanup.push(registry.register(fake));
	const { usage } = harness();
	expect(collectorFor(provider)).toEqual(fake);
	expect(Object.isFrozen(collectorFor(provider))).toBe(true);
	expect(COLLECTED_PROVIDERS).toEqual(["anthropic", "openai-codex", provider]);
	expect(Object.keys(COLLECTED_PROVIDERS)).toEqual(["0", "1", "2"]);
	expect(COLLECTED_PROVIDERS.map((id) => id)).toEqual(collectedProviders());
	expect(Array.isArray(COLLECTED_PROVIDERS)).toBe(true);
	expect(Reflect.set(COLLECTED_PROVIDERS, "0", provider)).toBe(false);
	expect(Reflect.defineProperty(COLLECTED_PROVIDERS, "0", { value: provider })).toBe(false);
	expect(Reflect.deleteProperty(COLLECTED_PROVIDERS, "0")).toBe(false);
	expect(Reflect.preventExtensions(COLLECTED_PROVIDERS)).toBe(false);
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "available", ...reading });
});

it("rejects built-in IDs before usage loads and after another router copy loads", async () => {
	Reflect.deleteProperty(host, key);
	try {
		vi.resetModules();
		const first = await import("../src/collectors.ts");
		const read = vi.fn(fake.read);
		for (const id of ["anthropic", "openai-codex"]) {
			expect(() => host[key].register({ provider: id, kind: "custom", read })).toThrow(/reserved for a built-in/);
			expect(Object.isFrozen(first.collectorFor(id))).toBe(true);
		}
		const unregister = first.registerCollector(fake);
		cleanup.push(unregister);
		vi.resetModules();
		const second = await import("../src/collectors.ts");
		expect(second.collectorFor(provider)).toBe(first.collectorFor(provider));
		expect(() => second.registerCollector({ provider: "anthropic", kind: "custom", read })).toThrow(/reserved/);
		const { UsageService: ReloadedUsage } = await import("../src/usage.ts");
		const fetch = vi.fn(async () => Response.json({ five_hour: { utilization: 23 } }));
		const usage = new ReloadedUsage({ getAccessToken: async () => "fake-token", fetch, now: () => T0 });
		expect(await usage.get(ctx, "anthropic")).toMatchObject({ status: "available", windows: [{ usedPercent: 23 }] });
		expect(read).not.toHaveBeenCalled();
	} finally {
		host[key] = registry;
	}
});

it.each([undefined, 2])("rejects an existing registry with version %s without replacing it", async (version) => {
	const incompatible = Object.freeze({ ...registry, version });
	Object.assign(host, { [key]: incompatible });
	try {
		vi.resetModules();
		await expect(import("../src/collectors.ts")).rejects.toThrow(/registry version \(expected 1\)/);
		expect(host[key]).toBe(incompatible);
	} finally {
		host[key] = registry;
	}
});

it("runs registered HTTP requests and blocks only the exhausted model bucket", async () => {
	const { usage, fetch, getAccessToken } = harness();
	const request = vi.fn((token: string) => ({
		url: "https://quota.example.invalid/usage",
		method: "POST" as const,
		body: "{}",
		headers: { Authorization: `Bearer ${token}` },
	}));
	const parse = vi.fn(() => reading);
	const unregister = install({ provider, kind: "http", request, parse });
	const snapshot = await usage.get(ctx, provider);
	expect(snapshot).toMatchObject({ provider, status: "available", ...reading });
	expect(request).toHaveBeenCalledWith("fake-token");
	expect(fetch).toHaveBeenCalledWith(request.mock.results[0]?.value.url, {
		method: "POST",
		body: "{}",
		headers: { Authorization: "Bearer fake-token" },
		signal: expect.any(AbortSignal),
	});
	expect(parse).toHaveBeenCalledWith({ percent: 100 });
	expect(usage.decisionFor({ provider, id: "faux-one" })).toMatchObject({ block: true, scope: "model" });
	expect(usage.decisionFor({ provider, id: "faux-two" })).toEqual({ block: false });

	unregister();
	expect(COLLECTED_PROVIDERS.includes(provider)).toBe(false);
	expect(usage.peek(provider)).toBeUndefined();
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "unavailable" });
	expect(getAccessToken).toHaveBeenCalledTimes(1);
});

it("does not let old cleanup or an in-flight reading survive replacement", async () => {
	const { usage } = harness();
	const pending = deferred<CollectorReading>();
	const started = deferred();
	const unregister = install({
		...fake,
		read: () => {
			started.resolve();
			return pending.promise;
		},
	});
	const old = usage.get(ctx, provider, { force: true });
	await started.promise;
	const replacement = { ...fake, read: async () => ({ windows: [] }) };
	install(replacement);
	unregister();
	expect(collectorFor(provider)).toEqual(replacement);
	pending.resolve(reading);
	expect(await old).toMatchObject({ status: "unavailable" });
	expect(await usage.get(ctx, provider, { force: true })).toMatchObject({ status: "available", windows: [] });
});

it("applies the usage deadline and backoff to a custom reader even if it ignores abort", async () => {
	const { usage, fetch } = harness();
	const pending = deferred<CollectorReading>();
	const started = deferred<{ token: string; signal: AbortSignal; now(): number }>();
	const read = vi.fn((ctx: { token: string; signal: AbortSignal; now(): number }) => {
		started.resolve(ctx);
		return pending.promise;
	});
	install({ ...fake, read });
	const settled = vi.fn();
	const result = usage.get(ctx, provider);
	void result.then(settled);
	const custom = await started.promise;
	expect(custom.token).toBe("fake-token");
	expect(custom.now()).toBe(T0);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(custom.signal.aborted).toBe(true);
	expect(settled).toHaveBeenCalledOnce();
	expect(await result).toMatchObject({ status: "error", message: "Usage request timed out." });
	pending.resolve(reading);
	expect(usage.peek(provider)).toBeUndefined();
	expect(await usage.get(ctx, provider)).toMatchObject({
		status: "error",
		message: expect.stringContaining("Backing off"),
	});
	expect(read).toHaveBeenCalledTimes(1);
	expect(fetch).not.toHaveBeenCalled();
});

it("warms a registered scoped provider and includes late registrations in the usage RPC", async () => {
	const { usage } = harness();
	const { pi, handlers } = createRecordingPi();
	const listeners = new Map<string, (data: unknown) => unknown>();
	const emit = vi.fn();
	const api = {
		...pi,
		events: {
			on: (event: string, fn: (data: unknown) => unknown) => {
				listeners.set(event, fn);
				return () => listeners.delete(event);
			},
			emit,
		},
	};
	await createSubscriptionRouter({ usage, config: { ok: true, profiles: [] }, now: () => T0 })(api);
	const get = vi.spyOn(usage, "get");
	const unregister = install(fake);
	const session = { ...ctx, scopedModels: [{ model: { provider } }] } as unknown as ExtensionContext;
	await handlers.get("session_start")?.[0]?.({}, session);
	expect(get).toHaveBeenCalledWith(expect.objectContaining({ scopedModels: [{ model: { provider } }] }), provider);
	await listeners.get("router:rpc:usage")?.({ requestId: "read", refresh: true });
	expect(emit).toHaveBeenCalledWith("router:rpc:usage:reply:read", {
		success: true,
		data: {
			snapshots: expect.arrayContaining([expect.objectContaining({ provider, status: "available" })]),
			blocks: [],
		},
	});
	unregister();
	await listeners.get("router:rpc:usage")?.({ requestId: "removed" });
	expect(emit).toHaveBeenLastCalledWith("router:rpc:usage:reply:removed", {
		success: true,
		data: { snapshots: expect.not.arrayContaining([expect.objectContaining({ provider })]), blocks: [] },
	});
});
