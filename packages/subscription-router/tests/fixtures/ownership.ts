/** Shared real-session barrier used by released-host and candidate-host ownership contracts. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { expect } from "vitest";
import { CachedUsage, Clock, prompt, startRouter } from "./router.ts";

export const TERMINAL = "insufficient_quota: You exceeded your current quota";
export const RETRY = "429 Too Many Requests: rate_limit_error";
export type SelectionChange = "pin" | "other-profile" | "away-and-back" | "abort" | "shutdown";

/** Suspend actual terminal/retry confirmation, invalidate its owner, then release valid shared evidence. */
export async function verifyOwnership(change: SelectionChange, errorMessage: string): Promise<void> {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("spike-a", 0);
	usage.set("spike-b", 0);
	const entered = deferred();
	const release = deferred();
	usage.onRefresh = async (provider) => {
		entered.resolve();
		await release.promise;
		usage.set(provider, 100);
	};
	const scenario = await startRouter(usage);
	const { harness, providers, notifications, tracker } = scenario;
	try {
		const selected = harness.session.model;
		if (!selected) throw new Error("Missing routed selection");
		providers[0].setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage, timestamp: clock.now() }),
		]);
		providers[1].setResponses([fauxAssistantMessage("stale continuation")]);
		const run = prompt(scenario);
		await entered.promise;
		// Core omits a retryable failure before it prepares the retry route. No new omission is allowed.
		const omissions = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
		const decisions = harness.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "router:decision");
		let cancellation: Promise<void> | undefined;
		try {
			if (change === "abort") cancellation = harness.session.abort();
			else if (change === "shutdown")
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			else {
				const destination =
					change === "other-profile"
						? harness.session.modelRuntime.getModel("router", "other")
						: providers[1].getModel();
				if (!destination) throw new Error("Missing destination selection");
				await harness.session.setModel(destination);
				if (change === "away-and-back") await harness.session.setModel(selected);
			}
		} finally {
			release.resolve();
		}
		await run;
		await cancellation;
		if (errorMessage === RETRY && change !== "abort") {
			expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: expect.stringContaining("request selection changed or was cancelled"),
			});
		}
		// A cancelled collector cannot confirm; its valid cached observation is still shared.
		if (change === "abort") expect(usage.peek("spike-a")?.windows[0]?.usedPercent).toBe(100);
		else expect(tracker.active()).toMatchObject([{ provider: "spike-a" }]);
		expect({
			calls: providers.map((provider) => provider.state.callCount),
			notifications,
			omissions: harness.session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"),
		}).toEqual({ calls: [1, 0, 0], notifications: [], omissions });
		expect(
			harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "router:decision"),
		).toEqual(decisions);
	} finally {
		release.resolve();
		scenario.cleanup();
	}
}
