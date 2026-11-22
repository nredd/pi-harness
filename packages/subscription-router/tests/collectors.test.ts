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
const registry = (globalThis as typeof globalThis & { [key]: Map<string, { collector: Collector }> })[key];
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
	registry.set(provider, { collector: fake });
	cleanup.push(() => registry.delete(provider));
	const { usage } = harness();
	expect(collectorFor(provider)).toBe(fake);
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

it("keeps pre-registered collectors when a second router copy loads", async () => {
	const builtin = registry.get("anthropic");
	if (!builtin) throw new Error("missing Anthropic adapter");
	cleanup.push(() => registry.set("anthropic", builtin));
	const external = { ...fake, provider: "anthropic" };
	registry.set("anthropic", { collector: external });
	vi.resetModules();
	const second = await import("../src/usage.ts");
	const { getAccessToken, fetch } = harness();
	const usage = new second.UsageService({ getAccessToken, fetch, now: () => T0 });
	expect(collectorFor("anthropic")).toBe(external);
	expect(await usage.get(ctx, "anthropic")).toMatchObject({ status: "available", ...reading });
	expect(fetch).not.toHaveBeenCalled();
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
	expect(collectorFor(provider)).toBe(replacement);
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
