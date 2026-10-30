import { describe, expect, it } from "vitest";
import devTools from "../../../packages/dev-tools/vitest.config.ts";
import planMode from "../../../packages/plan-mode/vitest.config.ts";
import preset from "../../../packages/preset/vitest.config.ts";
import resourceSampler from "../../../packages/resource-sampler/vitest.config.ts";
import sessionKit from "../../../packages/session-kit/vitest.config.ts";
import subagents from "../../../packages/subagents/vitest.config.ts";
import subscriptionRouter from "../../../packages/subscription-router/vitest.config.ts";
import todo from "../../../packages/todo/.vitest.config.ts";
import inprocess from "../vitest.config.ts";

// Assert the actual configs, not a copied policy or CLI argument. Direct Vitest
// invocations and the Node/Bun launcher must inherit the same bounded defaults.
describe("owned Vitest worker budgets", () => {
	it.each([
		["dev-tools", devTools, 2],
		["plan-mode", planMode, 2],
		["preset", preset, 2],
		["resource-sampler", resourceSampler, 1],
		["session-kit", sessionKit, 2],
		["subagents", subagents, 2],
		["subscription-router", subscriptionRouter, 2],
		["todo", todo, 2],
		["inprocess", inprocess, 2],
	] as const)("%s bounds its own workers", (_name, config, workers) => {
		expect(config.test?.maxWorkers).toBe(workers);
	});
});
