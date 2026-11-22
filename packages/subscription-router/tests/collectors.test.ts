import type { Api, Model } from "@earendil-works/pi-ai";
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
import { ExhaustionTracker } from "../src/exhaustion.ts";
import { createSubscriptionRouter } from "../src/index.ts";
import { Router } from "../src/router.ts";
import { COLLECTED_PROVIDERS, type RegistryContext, UsageService, type UsageSnapshot } from "../src/usage.ts";

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
	[key]: {
		version: number;
		register(collector: Collector): () => void;
		collectorFor(id: string): Readonly<Collector> | undefined;
	};
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
	expect(registry.collectorFor(provider)).toBe(collectorFor(provider));
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

it("rejects non-string collector IDs", async () => {
	vi.useFakeTimers();
	const credentials: Record<string, string> = { anthropic: "fake-anthropic-credential", [provider]: "fake-token" };
	// Pi's `getAuth` resolves a non-string argument as a model and reads its `provider`.
	const getApiKeyForProvider = vi.fn(async (id: unknown) =>
		typeof id === "string" ? credentials[id] : credentials[(id as { provider: string }).provider],
	);
	const registryCtx = { modelRegistry: { getApiKeyForProvider } } as unknown as ExtensionContext;
	const usage = new UsageService({
		fetch: vi.fn(),
		now: () => T0,
		getAccessToken: (ctx, id) => ctx.modelRegistry.getApiKeyForProvider(id),
	});
	const { pi, handlers } = createRecordingPi();
	const listeners = new Map<string, (data: unknown) => unknown>();
	const emit = vi.fn();
	const on = (event: string, fn: (data: unknown) => unknown) => {
		listeners.set(event, fn);
		return () => listeners.delete(event);
	};
	await createSubscriptionRouter({ usage, config: { ok: true, profiles: [] }, now: () => T0 })({
		...pi,
		events: { on, emit },
	});
	await handlers.get("session_start")?.[0]?.({}, { ...registryCtx, scopedModels: [] } as unknown as ExtensionContext);
	const read = vi.fn(fake.read);
	const modelShaped = { provider: "anthropic", toString: () => "faux-model" };
	for (const id of [modelShaped, new String(provider), 7, "", "faux id", "faux/id", "x".repeat(257)]) {
		const adapter = { kind: "custom", read, provider: id } as unknown as Collector;
		expect(() => registry.register(adapter)).toThrow(/non-blank string ID/);
	}
	expect(collectorFor(modelShaped as unknown as string)).toBeUndefined();
	install({ ...fake, provider: "x".repeat(256) });
	install({ ...fake, read });
	// A coerced key must not select a collector for a model-shaped credential argument.
	usage.configureCollectors({ "faux-model": { collector: { id: provider } } });
	expect(await usage.get(registryCtx, modelShaped as unknown as string)).toMatchObject({ status: "unavailable" });
	expect(usage.peek(modelShaped as unknown as string)).toBeUndefined();
	usage.configureCollectors();
	await listeners.get("router:rpc:usage")?.({ requestId: "read", refresh: true });
	expect(read).toHaveBeenCalledOnce();
	expect(read).toHaveBeenCalledWith(expect.objectContaining({ token: "fake-token" }));
	expect(getApiKeyForProvider.mock.calls.every(([id]) => typeof id === "string")).toBe(true);
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
	expect(await old).toMatchObject({ status: "unavailable" });
	pending.resolve(reading);
	expect(await usage.get(ctx, provider, { force: true })).toMatchObject({ status: "available", windows: [] });
});

it("retires reentrant registrations", async () => {
	const { usage, getAccessToken } = harness();
	const credential = deferred<string>();
	getAccessToken.mockReturnValueOnce(credential.promise);
	const nested = vi.fn(fake.read);
	install(fake);
	let pending: Promise<UsageSnapshot> | undefined;
	const outer = {
		...fake,
		get read() {
			if (!pending) {
				install({ ...fake, read: nested });
				pending = usage.get(ctx, provider);
			}
			return fake.read;
		},
	};
	install(outer);
	credential.resolve("fake-token");
	expect(await pending).toMatchObject({ status: "unavailable" });
	expect(nested).not.toHaveBeenCalled();
	expect(collectorFor(provider)).toEqual(fake);
});

it("retires cache and pending reads even when the same adapter is reinstalled", async () => {
	const { usage } = harness();
	const pending = deferred<CollectorReading>();
	const started = deferred();
	const read = vi
		.fn(fake.read)
		.mockImplementationOnce(async () => reading)
		.mockImplementationOnce(() => {
			started.resolve();
			return pending.promise;
		})
		.mockResolvedValue({ windows: [] });
	const adapter = { ...fake, read };
	const remove = install(adapter);
	const snapshot = await usage.get(ctx, provider);
	const old = usage.get(ctx, provider, { force: true });
	await started.promise;
	remove();
	install(adapter);
	expect(usage.peek(provider)).toBeUndefined();
	expect(usage.decisionFor({ provider, id: "faux-one" }, snapshot)).toEqual({ block: false });
	expect(await old).toMatchObject({ status: "unavailable" });
	pending.resolve(reading);
	expect(await usage.get(ctx, provider, { force: true })).toMatchObject({ status: "available", windows: [] });
	expect(read).toHaveBeenCalledTimes(3);
});

it("never passes a late credential to a retired registration", async () => {
	const { usage, getAccessToken } = harness();
	const pending = deferred<string>();
	getAccessToken.mockReturnValueOnce(pending.promise);
	const read = vi.fn(fake.read);
	const acceptsCredential = vi.fn(() => true);
	const remove = install({ ...fake, acceptsCredential, read });
	const result = usage.get(ctx, provider);
	expect(getAccessToken).toHaveBeenCalledOnce();
	remove();
	pending.resolve("fake-late-token");
	expect(await result).toMatchObject({ status: "unavailable" });
	expect(acceptsCredential).not.toHaveBeenCalled();
	expect(read).not.toHaveBeenCalled();
});

it("admits a model once the collector that confirmed its block retires", async () => {
	const { usage } = harness();
	const tracker = new ExhaustionTracker(() => T0);
	const router = new Router(usage, tracker, () => T0);
	const model = { provider, id: "faux-one" } as Model<Api>;
	const remove = install(fake);
	const env = { resolve: () => model, refresh: async () => usage.decisionFor(model, await usage.get(ctx, provider)) };
	const ref = `${provider}/faux-one`;
	expect(await router.confirm(model, env, undefined, T0)).toBe(true);
	expect(router.admit(ref, new Map(), env)).toMatchObject({ ok: false });
	const decision = usage.decisionFor(model);
	remove();
	expect(tracker.active()).toEqual([]);
	expect(router.admit(ref, new Map(), env)).toMatchObject({ ok: true });
	expect(await router.confirm(model, { ...env, refresh: async () => decision }, undefined, T0)).toBe(false);
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

it.each([NaN, Infinity, -1, 101, "100"])(
	"rejects invalid used percentages (%s) without blocking",
	async (usedPercent) => {
		const { usage } = harness();
		const malformed = { windows: [{ name: "bad", scope: "provider", usedPercent }] } as CollectorReading;
		install({ ...fake, read: async () => malformed });
		expect(await usage.get(ctx, provider)).toMatchObject({
			status: "error",
			message: "Usage response had an unsupported shape.",
		});
		const router = new Router(usage, new ExhaustionTracker(() => T0), () => T0);
		expect(router.blockedBy({ provider, id: "faux-one" })).toBeUndefined();
	},
);

it("copies bounded reading fields without accepting adapter metadata or out-of-range resets", async () => {
	const { usage } = harness();
	const window = {
		name: "fake",
		scope: "model" as const,
		families: ["faux-one"],
		usedPercent: 100,
		basis: "inferred" as const,
		resetAt: Number.MAX_SAFE_INTEGER,
		durationMs: 10_000,
		kind: "calendar" as const,
		resetRule: { at: "09:00", timeZone: "UTC", every: "day" as const },
		quantity: { unit: "requests" as const, used: 100, limit: 100, remaining: 0 },
	};
	const payload = {
		provider: "spoofed",
		status: "stale",
		retrievedAt: 1,
		expiresAt: 2,
		access: "metered",
		basis: "inferred",
		windows: [window],
		meters: reading.meters,
		pools: [
			{ ...reading.pools?.[0], name: "pool", unit: "usd" as const, role: "prepaid" as const, appliesAfter: ["fake"] },
		],
		credits: { available: true, unlimited: false, balance: "12", raw: "not evidence" },
	};
	install({ ...fake, read: async () => payload });
	const snapshot = await usage.get(ctx, provider);
	window.families[0] = "faux-two";
	window.quantity.used = 0;
	window.resetRule.at = "10:00";
	payload.pools[0]?.appliesAfter.pop();
	expect(snapshot).toMatchObject({
		provider,
		status: "available",
		retrievedAt: T0,
		expiresAt: T0 + 300_000,
		windows: [{ families: ["faux-one"], resetRule: { at: "09:00" }, quantity: { used: 100 } }],
		pools: [{ appliesAfter: ["fake"] }],
	});
	expect(snapshot).not.toHaveProperty("access");
	expect(snapshot).not.toHaveProperty("basis");
	expect(snapshot.credits).not.toHaveProperty("raw");
	expect(snapshot.windows[0]).not.toHaveProperty("basis");
	expect(snapshot.windows[0]?.resetAt).toBeUndefined();
	const router = new Router(usage, new ExhaustionTracker(() => T0), () => T0);
	expect(router.blockedBy({ provider, id: "faux-one" })).toMatchObject({ reason: "fake exhausted" });
});

it("validates the copied reading", async () => {
	const { usage } = harness();
	const valid = { name: "faux-day", scope: "provider" as const, usedPercent: 100, resetAt: T0 + 60_000 };
	const map = vi.fn(() => [null]);
	const windows = Object.assign([valid], { map });
	const families = Object.assign(["faux-one"], { slice: vi.fn(() => [42]) });
	let percentReads = 0;
	const shifting = {
		name: "faux-week",
		scope: "model" as const,
		families,
		get usedPercent() {
			percentReads += 1;
			return percentReads === 1 ? 40 : Number.NaN;
		},
		set kind(_kind: unknown) {},
	};
	const stringLength = new Proxy([valid], {
		getOwnPropertyDescriptor: (target, key) =>
			key === "length" ? { value: "1", writable: true } : Reflect.getOwnPropertyDescriptor(target, key),
	});
	const hostile = [
		{ windows },
		{ windows: [shifting] },
		{
			windows: [],
			get meters() {
				throw new Error("private fake payload");
			},
		},
		{ windows: Object.assign([valid], { length: 129 }) },
		{ windows: Object.assign([], { 1: valid }) },
		{ windows: stringLength },
		Object.create({ windows: [valid] }),
	];
	const read = vi.fn(async () => hostile[read.mock.calls.length - 1]);
	install({ ...fake, read } as Collector);
	const first = await usage.get(ctx, provider, { force: true });
	expect(first).toMatchObject({ status: "available", windows: [valid] });
	expect(map).not.toHaveBeenCalled();
	expect(usage.decisionFor({ provider, id: "faux-one" })).toMatchObject({ block: true, window: "faux-day" });
	const readings: UsageSnapshot[] = [];
	for (let index = 1; index < hostile.length; index += 1) {
		usage.invalidate(provider);
		readings.push(await usage.get(ctx, provider));
	}
	expect(readings[0]).toMatchObject({ status: "available", windows: [{ usedPercent: 40, families: ["faux-one"] }] });
	expect(percentReads).toBe(1);
	expect(families.slice).not.toHaveBeenCalled();
	expect(readings.slice(1).map(({ status, message }) => ({ status, message }))).toEqual([
		{ status: "error", message: "Usage request failed." },
		{ status: "error", message: "Usage response had an unsupported shape." },
		{ status: "error", message: "Usage response had an unsupported shape." },
		{ status: "error", message: "Usage response had an unsupported shape." },
		{ status: "error", message: "Usage response had an unsupported shape." },
	]);
});

it("bounds external reset evidence", async () => {
	vi.useFakeTimers();
	let now = T0;
	const usage = new UsageService({ fetch: vi.fn(), now: () => now, getAccessToken: async () => "fake-token" });
	const horizon = 31 * 24 * 60 * 60_000;
	const millennia = T0 + 1_000 * 365 * 24 * 60 * 60_000;
	install({
		...fake,
		read: async () => ({
			windows: [
				{ name: "faux-far", scope: "model", families: ["faux-one"], usedPercent: 100, resetAt: T0 + horizon + 1 },
				{ name: "faux-edge", scope: "model", families: ["faux-two"], usedPercent: 100, resetAt: T0 + horizon },
			],
			meters: [{ name: "faux-meter", scope: "provider", resetAt: millennia, quantity: { unit: "requests" } }],
		}),
	});
	const snapshot = await usage.get(ctx, provider);
	expect(snapshot.windows.map(({ resetAt }) => resetAt)).toEqual([undefined, T0 + horizon]);
	expect(snapshot.meters?.[0]?.resetAt).toBeUndefined();
	expect(usage.decisionFor({ provider, id: "faux-one" })).toMatchObject({ block: true, resetAt: undefined });
	// An unknown reset blocks only while the reading is fresh; a bounded known reset outlives the TTL.
	now = T0 + 5 * 60_000 + 1;
	expect(usage.decisionFor({ provider, id: "faux-one" })).toEqual({ block: false });
	expect(usage.decisionFor({ provider, id: "faux-two" })).toMatchObject({ block: true, resetAt: T0 + horizon });
});

it("sanitizes thrown adapter callbacks independently of reading validation", async () => {
	const { usage } = harness();
	install({
		...fake,
		read: () => {
			throw new Error("private fake payload");
		},
	});
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "error", message: "Usage request failed." });
});

it("sanitizes throwables whose properties throw beside a healthy collector", async () => {
	const { usage } = harness();
	const { pi, handlers } = createRecordingPi();
	const listeners = new Map<string, (data: unknown) => unknown>();
	const emit = vi.fn();
	const on = (event: string, fn: (data: unknown) => unknown) => {
		listeners.set(event, fn);
		return () => listeners.delete(event);
	};
	await createSubscriptionRouter({ usage, config: { ok: true, profiles: [] }, now: () => T0 })({
		...pi,
		events: { on, emit },
	});
	await handlers.get("session_start")?.[0]?.({}, { ...ctx, scopedModels: [] } as unknown as ExtensionContext);
	const throwing = () => {
		throw new Error("private fake payload");
	};
	const throwables = [
		Object.defineProperty(new Error("private fake payload"), "name", { get: throwing }),
		new Proxy({}, { getPrototypeOf: throwing }),
		{ toString: throwing, valueOf: throwing },
	];
	install(fake);
	throwables.forEach((throwable, index) => {
		install({
			...fake,
			provider: `faux-hostile-${index}`,
			read: () => {
				throw throwable;
			},
		});
	});
	const reply = listeners.get("router:rpc:usage")?.({ requestId: "refresh", refresh: true });
	await vi.advanceTimersByTimeAsync(0);
	await reply;
	expect(emit).toHaveBeenCalledWith("router:rpc:usage:reply:refresh", {
		success: true,
		data: {
			snapshots: [expect.objectContaining({ provider, status: "available" })],
			blocks: [],
		},
	});
	// A sanitized failure, not a rejected read, records the provider's backoff.
	for (const index of throwables.keys()) {
		expect(await usage.get(ctx, `faux-hostile-${index}`)).toMatchObject({
			status: "error",
			message: expect.stringContaining("Backing off"),
		});
	}
});

it("answers a caller when the shared read rejects", async () => {
	vi.useFakeTimers();
	const now = vi
		.fn(() => T0)
		.mockReturnValueOnce(T0)
		.mockImplementation(() => {
			throw new Error("fake clock failure");
		});
	const usage = new UsageService({ fetch: vi.fn(), now, getAccessToken: async () => "fake-token" });
	install({
		...fake,
		read: () => {
			throw new Error("private fake payload");
		},
	});
	const settled = vi.fn();
	void usage.get(ctx, provider).then(settled);
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toHaveBeenCalledWith(
		expect.objectContaining({ provider, status: "error", message: "Usage request failed." }),
	);
});

it("selects configured collector IDs without changing the credential provider", async () => {
	const { usage, getAccessToken } = harness();
	const { pi } = createRecordingPi();
	install(fake);
	const alias = "faux-alias";
	const read = vi.fn(fake.read);
	install({ ...fake, provider: alias, read });
	await createSubscriptionRouter({
		usage,
		config: {
			ok: true,
			profiles: [],
			providers: {
				[provider]: { collector: { id: "unknown" } },
				[alias]: { collector: { id: provider } },
			},
		},
	})(pi);
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "unavailable" });
	expect(getAccessToken).not.toHaveBeenCalled();
	const snapshot = await usage.get(ctx, alias);
	expect(snapshot).toMatchObject({ provider: alias, status: "available", windows: reading.windows });
	expect(getAccessToken).toHaveBeenCalledWith(ctx, alias);
	expect(read).not.toHaveBeenCalled();
	usage.configureCollectors({ [alias]: { collector: { id: provider } } });
	expect(usage.peek(alias)).toBe(snapshot);
	usage.configureCollectors();
	expect(usage.peek(alias)).toBeUndefined();
	expect(await usage.get(ctx, alias)).toMatchObject({ status: "available" });
	expect(read).toHaveBeenCalledOnce();
});

it("preserves alias credential authorization", async () => {
	const { usage, getAccessToken } = harness();
	const alias = "faux-alias";
	const declarations = { [alias]: { collector: { id: provider } } };
	const trusted = vi.fn(fake.read);
	const replacement = vi.fn(async () => ({ windows: [] }));
	install({ ...fake, read: trusted });
	usage.configureCollectors(declarations);
	expect(await usage.get(ctx, alias)).toMatchObject({ status: "available", windows: reading.windows });
	install({ ...fake, read: replacement });
	expect(usage.peek(alias)).toBeUndefined();
	expect(await usage.get(ctx, alias, { force: true })).toMatchObject({ status: "unavailable" });
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "available", windows: [] });
	expect(replacement).toHaveBeenCalledOnce();
	expect(getAccessToken.mock.calls).toEqual([
		[ctx, alias],
		[ctx, provider],
	]);
	// Loading config again is the explicit re-authorization.
	usage.configureCollectors(declarations);
	expect(await usage.get(ctx, alias)).toMatchObject({ status: "available", windows: [] });
	expect(getAccessToken).toHaveBeenLastCalledWith(ctx, alias);
	expect(trusted).toHaveBeenCalledOnce();
});

it("cancels an oversized streamed response before parsing without trusting content-length", async () => {
	const { usage, fetch } = harness();
	const cancel = vi.fn(async () => {
		throw new Error("fake cancel error");
	});
	const { readable, enqueue } = (() => {
		let stream!: ReadableStreamDefaultController<Uint8Array>;
		const readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				stream = controller;
			},
			cancel,
		});
		return { readable, enqueue: (size: number) => stream.enqueue(new Uint8Array(size)) };
	})();
	fetch.mockResolvedValueOnce(new Response(readable, { headers: { "content-length": "2" } }));
	const parse = vi.fn(() => reading);
	install({ provider, kind: "http", request: () => ({ url: "https://quota.example.invalid", headers: {} }), parse });
	const result = usage.get(ctx, provider);
	enqueue(256 * 1024);
	enqueue(1);
	expect(await result).toMatchObject({ status: "error", message: "Usage request failed." });
	expect(parse).not.toHaveBeenCalled();
	expect(cancel).toHaveBeenCalledOnce();
});

it("rejects a missing HTTP body", async () => {
	const { usage, fetch } = harness();
	fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
	const parse = vi.fn(() => reading);
	install({ provider, kind: "http", request: () => ({ url: "https://quota.example.invalid", headers: {} }), parse });
	expect(await usage.get(ctx, provider)).toMatchObject({ status: "error" });
	expect(parse).not.toHaveBeenCalled();
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
	const cold = "faux-cold";
	const failing = "faux-throwing";
	const hanging = "faux-hanging";
	const healthyRead = vi.fn(fake.read);
	const failure = vi.fn(() => {
		throw new Error("private fake payload");
	});
	const stalled = vi.fn(() => deferred<CollectorReading>().promise);
	install({ ...fake, provider: cold, read: healthyRead });
	install({ ...fake, provider: failing, read: failure });
	install({ ...fake, provider: hanging, read: stalled });
	expect(usage.peek(cold)).toBeUndefined();
	const reply = listeners.get("router:rpc:usage")?.({ requestId: "read", refresh: true });
	await vi.advanceTimersByTimeAsync(9_999);
	expect(healthyRead).toHaveBeenCalledOnce();
	expect(failure).toHaveBeenCalledOnce();
	expect(stalled).toHaveBeenCalledOnce();
	expect(usage.peek(cold)).toMatchObject({ status: "available" });
	expect(emit).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	await reply;
	expect(emit).toHaveBeenCalledWith("router:rpc:usage:reply:read", {
		success: true,
		data: {
			snapshots: expect.arrayContaining([
				expect.objectContaining({ provider, status: "available" }),
				expect.objectContaining({ provider: cold, status: "available" }),
			]),
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
