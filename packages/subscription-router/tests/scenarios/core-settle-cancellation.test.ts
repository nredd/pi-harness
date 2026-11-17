/** Minimal core contract regression: no router, quota service, or provider network. */
import { createHarness, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { expect, it } from "vitest";

it("exposes cancellation to an awaited pre-settle handler before it commits recovery", async () => {
	const entered = deferred();
	const release = deferred();
	let streamingSignal: AbortSignal | undefined;
	let settleSignalAborted: boolean | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("agent_start", (_event, ctx) => {
					streamingSignal = ctx.signal;
				});
				pi.on("agent_before_settle", async (event, ctx) => {
					entered.resolve();
					await release.promise;
					settleSignalAborted = ctx.signal?.aborted;
					if (ctx.signal?.aborted) return;
					const failed = event.context.contextEntries.at(-1);
					if (!failed) throw new Error("Missing failed response");
					return {
						entries: [...event.entries, { type: "context_edit", targetId: failed.sourceEntry.id, replacement: null }],
						continue: true,
					};
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			fauxAssistantMessage("must not run"),
		]);
		const run = harness.session.prompt("one prompt");
		await entered.promise;
		const cancellation = harness.session.abort();
		release.resolve();
		await run;
		await cancellation;
		expect({
			settleSignalAborted,
			streamingSignalAborted: streamingSignal?.aborted,
			omissions: harness.session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length,
		}).toEqual({ settleSignalAborted: true, streamingSignalAborted: true, omissions: 0 });
	} finally {
		release.resolve();
		harness.cleanup();
	}
});
