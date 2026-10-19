/** Teardown must settle an unfinished reviewer turn before another test can run. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { agentStack, call, closeAgentStack } from "./agents-support.ts";
import { isolateStackHome } from "./support.ts";

it("aborts and drains a running reviewer and parent before disposing their session", async () => {
	const home = await isolateStackHome();
	const h = await agentStack(home.root);
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let aborted = false;
	h.setResponses([
		call("Agent", {
			subagent_type: "code-reviewer",
			description: "hold reviewer",
			prompt: "wait until teardown",
			model: `${h.getModel().provider}/${h.getModel().id}`,
			run_in_background: false,
		}),
		async (_ctx, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Reviewer request has no abort signal");
			await new Promise<void>((resolve) => {
				const onAbort = () => {
					aborted = true;
					resolve();
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				entered();
			});
			return fauxAssistantMessage("aborted");
		},
	]);
	const turn = h.session.prompt("hold until teardown");
	try {
		await started;
		expect(h.session.isIdle).toBe(false);
		await closeAgentStack(h);
		expect(aborted).toBe(true);
		expect(h.session.isIdle).toBe(true);
		await turn;
	} finally {
		await h.session.abort();
		await turn;
		h.cleanup();
		await home.cleanup();
	}
});
