import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { FakeClock } from "../../packages/session-kit/test/scenarios/support.ts";
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
