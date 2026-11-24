/**
 * The registry slot is process-global and, once installed, locked. Vitest runs each test file in
 * its own realm, so this file imports the router only dynamically and installs the genuine slot in
 * its last test.
 */
import { expect, it, vi } from "vitest";
import type { Collector } from "../src/collectors.ts";
import type { RegistryContext } from "../src/usage.ts";

const T0 = 1_700_000_000_000;
const key = Symbol.for("pi-subscription-router.collectors");
const provider = "faux-quota";
const ctx = { modelRegistry: {} } as RegistryContext;
const fake: Collector = { provider, kind: "custom", read: async () => ({ windows: [] }) };
const methods = {
	register: () => () => undefined,
	registrationFor: () => undefined,
	collectorFor: () => undefined,
	collectedProviders: () => [],
};

it.each([
	["a null", null, /registry version \(expected 1\)/],
	["an unversioned", { ...methods }, /registry version \(expected 1\)/],
	["a version 2", { ...methods, version: 2 }, /registry version \(expected 1\)/],
	["a malformed version 1", { ...methods, version: 1, collectedProviders: undefined }, /malformed/],
])("rejects %s registry without replacing it", async (_label, existing, error) => {
	Object.defineProperty(globalThis, key, { value: existing, configurable: true, writable: true });
	try {
		vi.resetModules();
		await expect(import("../src/collectors.ts")).rejects.toThrow(error);
		expect(Reflect.get(globalThis, key)).toBe(existing);
	} finally {
		Reflect.deleteProperty(globalThis, key);
	}
});

it("locks the installed registry and shares it with same-realm reloads", async () => {
	vi.resetModules();
	const first = await import("../src/collectors.ts");
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
	expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: false });
	const registry = descriptor?.value as { register(collector: Collector): () => void };
	expect(Reflect.set(globalThis, key, { ...methods, version: 1 })).toBe(false);
	expect(Reflect.deleteProperty(globalThis, key)).toBe(false);
	expect(Reflect.defineProperty(globalThis, key, { value: { ...methods, version: 1 } })).toBe(false);

	// Built-in IDs are reserved through the protocol object before usage loads.
	const read = vi.fn(fake.read);
	for (const id of ["anthropic", "openai-codex", "antigravity"]) {
		expect(() => registry.register({ provider: id, kind: "custom", read })).toThrow(/reserved for a built-in/);
		expect(Object.isFrozen(first.collectorFor(id))).toBe(true);
	}
	const unregister = first.registerCollector(fake);
	vi.resetModules();
	const second = await import("../src/collectors.ts");
	expect(Reflect.get(globalThis, key)).toBe(registry);
	expect(second.collectorFor(provider)).toBe(first.collectorFor(provider));
	expect(() => second.registerCollector({ provider: "anthropic", kind: "custom", read })).toThrow(/reserved/);
	const { UsageService } = await import("../src/usage.ts");
	const fetch = vi.fn(async () => Response.json({ five_hour: { utilization: 23 } }));
	const usage = new UsageService({ getAccessToken: async () => "fake-token", fetch, now: () => T0 });
	expect(await usage.get(ctx, "anthropic")).toMatchObject({ status: "available", windows: [{ usedPercent: 23 }] });
	expect(read).not.toHaveBeenCalled();
	unregister();
	expect(second.collectorFor(provider)).toBeUndefined();
});
