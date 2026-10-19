import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	getAssistantTexts,
} from "@earendil-works/pi-coding-agent/testing";
import { expect, it, vi } from "vitest";
import { createExpandedFooter } from "../../extensions/expanded-footer.ts";
import { deferred, FakeClock, UsageBus } from "./support.ts";

it("rpc binding never mounts quota polling", async () => {
	const clock = new FakeClock();
	const usage = new UsageBus(clock);
	const setFooter = vi.fn();
	const harness = await createHarness({ extensionFactories: [createExpandedFooter({ clock }), usage.extension] });
	try {
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext({ setFooter }) });
		// CLI get_state/EOF is D's boundary. The initialized real session has valid state without a turn.
		expect(harness.session.model?.id).toBeTruthy();
		expect(harness.session.isStreaming).toBe(false);
		clock.advance(240_000);
		expect(setFooter).not.toHaveBeenCalled();
		expect(usage.requests).toEqual([]);
		expect(clock.pending).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it.each([
	["print", "text binding never mounts quota polling", "QUOTA PRINT OK"],
	["json", "json binding never mounts quota polling", "OK"],
] as const)("%s: %s", async (mode, _name, text) => {
	const clock = new FakeClock();
	const usage = new UsageBus(clock);
	const setFooter = vi.fn();
	const entered = deferred<void>();
	const release = deferred<void>();
	const harness = await createHarness({ extensionFactories: [createExpandedFooter({ clock }), usage.extension] });
	let turn: Promise<void> | undefined;
	try {
		await harness.session.bindExtensions({ mode, uiContext: createTestUiContext({ setFooter }) });
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage(text);
			},
		]);
		turn = harness.session.prompt("hi");
		await entered.promise;
		expect(harness.session.isStreaming).toBe(true);
		const started = clock.now();
		clock.advance(240_000);
		expect(clock.now() - started).toBeGreaterThan(120_000);
		expect(setFooter).not.toHaveBeenCalled();
		expect(usage.requests).toEqual([]);
		expect(clock.pending).toBe(0);
		release.resolve();
		await turn;
		expect(getAssistantTexts(harness)).toEqual([text]);
		expect(harness.eventsOfType("tool_execution_end")).toEqual([]);
		expect(usage.requests).toEqual([]);
		expect(clock.pending).toBe(0);
	} finally {
		release.resolve();
		await turn;
		harness.cleanup();
	}
});
