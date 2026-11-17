import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-coding-agent/testing";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { expect, it } from "vitest";
import { UsageService } from "../../packages/subscription-router/src/usage.ts";
import { OFFLINE, routePhysical, StackUsage } from "./goal-support.ts";

const ctx = {} as Pick<ExtensionContext, "modelRegistry">;

it("refuses network and credential reads", async () => {
	await expect(OFFLINE.fetch("https://api.anthropic.com/api/oauth/usage", {})).rejects.toThrow(
		"No network in stack scenarios",
	);
	await expect(OFFLINE.getAccessToken(ctx, "anthropic")).rejects.toThrow("No credentials in stack scenarios");
});

it("fails an uncached usage read on the refused credential lookup", async () => {
	const usage = new StackUsage(new FakeClock());
	const snapshot = await UsageService.prototype.get.call(usage, ctx, "anthropic", { fresh: true });
	expect(snapshot).toMatchObject({
		provider: "anthropic",
		status: "error",
		message: "OAuth credential lookup failed.",
	});
});

it("refuses a physical transport core cannot authenticate", async () => {
	const physical = registerFauxProvider({ provider: "auth-less", models: [{ id: "m" }] });
	try {
		const registered: string[] = [];
		const runtime = {
			registerProvider(provider: string) {
				registered.push(provider);
			},
			getAuth: async () => undefined,
		};
		await expect(routePhysical(runtime, physical)).rejects.toThrow("Missing faux auth for 'auth-less/m'");
		expect(registered).toEqual(["auth-less"]);
	} finally {
		physical.unregister();
	}
});

it("serves cached usage stamped at the fake clock, refreshing only on a fresh read", async () => {
	const clock = new FakeClock();
	const usage = new StackUsage(clock);
	usage.set("anthropic", 40);
	clock.advance(5_000);
	// A fresh read with no listener still answers from the cache.
	expect(await usage.get(ctx as ExtensionContext, "anthropic", { fresh: true })).toMatchObject({
		provider: "anthropic",
		retrievedAt: clock.now(),
	});
	const refreshed: string[] = [];
	usage.onRefresh = (provider) => refreshed.push(provider);
	await usage.get(ctx as ExtensionContext, "anthropic");
	await usage.get(ctx as ExtensionContext, "anthropic", { fresh: false });
	expect(refreshed).toEqual([]);
	await usage.get(ctx as ExtensionContext, "anthropic", { fresh: true });
	expect(refreshed).toEqual(["anthropic"]);
	expect(usage.reads).toEqual([
		{ provider: "anthropic", options: { fresh: true } },
		{ provider: "anthropic", options: {} },
		{ provider: "anthropic", options: { fresh: false } },
		{ provider: "anthropic", options: { fresh: true } },
	]);
});

it("refuses a usage read for a provider it never seeded", async () => {
	const usage = new StackUsage(new FakeClock());
	await expect(usage.get(ctx as ExtensionContext, "openai-codex")).rejects.toThrow("Missing usage for 'openai-codex'");
});
