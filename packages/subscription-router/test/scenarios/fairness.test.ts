/** Allocation through real Pi prompts, including its persisted physical incumbent. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "./support.js";

let scenario: RouterScenario | undefined;
afterEach(() => scenario?.cleanup());

it("real Pi preserves the hysteresis burst while fresh quota keeps normalized skew bounded", async () => {
	const usage = new CachedUsage(new Clock());
	const counts = [0, 0, 0];
	scenario = await startRouter(usage, "balanced");
	for (const provider of scenario.providers)
		provider.setResponses(Array.from({ length: 32 }, () => fauxAssistantMessage("finite synthetic debit")));
	const sequence: number[] = [];
	for (let turn = 0; turn < 24; turn++) {
		for (const [i, provider] of scenario.providers.entries())
			usage.set(provider.getModel().provider, (100 * (counts[i] ?? 0)) / 64);
		const messages = await prompt(scenario);
		expect(messages).toHaveLength(1);
		const message = messages[0];
		expect(message?.stopReason, message?.errorMessage).toBe("stop");
		const index = scenario.providers.findIndex((provider) => provider.getModel().provider === message?.provider);
		expect(index).toBeGreaterThanOrEqual(0);
		counts[index] = (counts[index] ?? 0) + 1;
		sequence.push(index);
		expect((Math.max(...counts) - Math.min(...counts)) / 64).toBeLessThanOrEqual(1 / 6 + 1 / 64);
	}
	expect(sequence.slice(0, 12)).toEqual([...Array<number>(11).fill(0), 1]);
	expect(scenario.harness.session.model).toMatchObject({ provider: "router", id: "spike" });
	expect(usage.reads).toEqual([]);
});
