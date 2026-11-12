/** Exercise the actual command/transcript boundary with no credentials, network or model request. */
import { createHarness } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { createSubscriptionRouter } from "../../src/index.js";
import { CachedUsage, Clock } from "./support.js";

it("prints cached reset schedules through the real session without triggering admission or a turn", async () => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("anthropic", 75);
	const harness = await createHarness({
		extensionFactories: [
			createSubscriptionRouter({
				config: {
					ok: true,
					profiles: [{ id: "sample", name: "Sample", chain: [{ provider: "anthropic", id: "sample" }] }],
				},
				usage,
				now: clock.now,
			}),
		],
	});
	try {
		await harness.session.bindExtensions({ mode: "print" });
		await harness.session.prompt("/router resets");
		const message = harness.session.messages.find(
			(entry) => entry.role === "custom" && entry.customType === "router:resets",
		);
		expect(message).toMatchObject({ display: true, content: expect.stringContaining("75% used") });
		expect(harness.session.messages.some((entry) => entry.role === "assistant")).toBe(false);
		expect(usage.reads).toEqual([]);
	} finally {
		harness.cleanup();
	}
});
