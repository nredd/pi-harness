/** Tier requests traverse the real Pi registry, router extension, child sessions and schedule store. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainEntry } from "../../packages/subscription-router/src/config.ts";
import {
	createSubscriptionRouter,
	type SubscriptionRouterOptions,
} from "../../packages/subscription-router/src/index.ts";
import { GoalStack, outcomes, tool } from "./goal-support.ts";

const CHAIN: [ChainEntry, ChainEntry] = [
	{ provider: "tier-haiku", id: "haiku" },
	{ provider: "tier-luna", id: "luna" },
];
const ref = (index: 0 | 1) => `${CHAIN[index]?.provider}/${CHAIN[index]?.id}`;

describe("model-tier/router stack", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-harness:tier-router")];
	});

	function configure(members = ["router/cheap"]): void {
		const dir = join(stack.home.root, "agent");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ extensions: [fileURLToPath(new URL("./fixtures/tier-router.ts", import.meta.url))] }),
		);
		writeFileSync(
			join(dir, "subagents.json"),
			JSON.stringify({
				fleetView: false,
				modelTiers: { cheap: members },
				modelResolution: { onUnmapped: "error", onUnavailable: "error" },
				agentModels: { "*": "@cheap" },
			}),
		);
	}

	function router(policy: "wait" | "fail" = "wait"): ExtensionFactory {
		const options: SubscriptionRouterOptions = {
			config: {
				ok: true,
				profiles: [
					{ id: "cheap", name: "Cheap", strategy: "balanced", chain: CHAIN, exhaustion: { policy } },
					{ id: "default", name: "Default must never run", strategy: "ordered", chain: [CHAIN[0]] },
				],
			},
			usage: stack.usage,
			tracker: stack.tracker,
			now: () => stack.clock.now(),
		};
		(globalThis as Record<symbol, unknown>)[Symbol.for("pi-harness:tier-router")] = options;
		return createSubscriptionRouter(options);
	}

	it.each([false, true])(
		"labels the admitted model before the first answer, blocked first member=%s",
		async (blocked) => {
			stack = await GoalStack.create();
			configure();
			const physical = stack.registerPhysical(CHAIN);
			if (blocked) stack.usage.set(CHAIN[0]?.provider, 100);
			const started: unknown[] = [];
			const completed: unknown[] = [];
			const h = await stack.start(
				[
					await stack.subagents(),
					router(),
					(pi) => {
						pi.events.on("subagents:started", (event) => started.push(event));
						pi.events.on("subagents:completed", (event) => completed.push(event));
					},
				],
				{ useModelRuntimeStream: true },
			);
			for (const provider of physical) provider.setResponses([fauxAssistantMessage("TIER ANSWER")]);
			h.setResponses([
				tool("Agent", {
					subagent_type: "general-purpose",
					description: "tier label",
					prompt: "answer",
					model: "@cheap",
					run_in_background: false,
				}),
				fauxAssistantMessage("DRIVER DONE"),
			]);
			await h.session.prompt("run the tier");
			const chosen = ref(blocked ? 1 : 0);
			const note = `Model: @cheap -> ${chosen} via router/cheap`;
			expect(started).toMatchObject([
				{
					modelTier: {
						kind: "routed",
						tier: "cheap",
						profile: "router/cheap",
						admitted: chosen,
						model: { provider: "router", id: "cheap", api: "pi-virtual" },
					},
					modelNote: note,
				},
			]);
			expect(completed).toMatchObject([{ modelNote: note, modelTier: { tier: "cheap", profile: "router/cheap" } }]);
			expect(outcomes(h, "Agent")[0]?.text).toContain(note);
			expect(physical.map((provider) => provider.state.callCount)).toEqual(blocked ? [0, 1] : [1, 0]);
		},
	);

	it("admits each exact static member through the real router and discloses a quota skip", async () => {
		stack = await GoalStack.create();
		configure([ref(0), ref(1)]);
		const physical = stack.registerPhysical(CHAIN);
		stack.usage.set(CHAIN[0]?.provider, 100);
		const h = await stack.start([await stack.subagents(), router()], { useModelRuntimeStream: true });
		physical[1]?.setResponses([fauxAssistantMessage("STATIC TIER ANSWER")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "static tier",
				prompt: "answer",
				model: "@cheap",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		expect(outcomes(h, "Agent")[0]?.text).toContain(`Model: @cheap -> ${ref(1)} (static); skipped ${ref(0)}: quota`);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 1]);
	});

	it("discloses a mid-run switch inside the same tier", async () => {
		stack = await GoalStack.create();
		configure();
		const physical = stack.registerPhysical(CHAIN);
		const h = await stack.start([await stack.subagents(), router()], { useModelRuntimeStream: true });
		physical[0]?.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "insufficient_quota",
				timestamp: stack.clock.now(),
			}),
		]);
		physical[1]?.setResponses([fauxAssistantMessage("RECOVERED INSIDE TIER")]);
		stack.usage.onRefresh = (provider) => {
			if (provider === CHAIN[0]?.provider) stack.usage.set(provider, 100);
		};
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "tier switch",
				prompt: "answer",
				model: "@cheap",
				run_in_background: false,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		const result = outcomes(h, "Agent")[0];
		expect(result?.text).toContain(`Model: @cheap -> ${ref(1)} via router/cheap (switched from ${ref(0)} within tier)`);
		expect(result?.text).toContain("RECOVERED INSIDE TIER");
		expect(physical.map((provider) => provider.state.callCount)).toEqual([1, 1]);
	});

	it.each(["wait", "fail"] as const)("never borrows router/default when exhausted (%s)", async (policy) => {
		stack = await GoalStack.create();
		configure();
		const physical = stack.registerPhysical(CHAIN, 100);
		const jobs: { type: string; job?: { model?: string; quotaParked?: boolean } }[] = [];
		const admissions: string[] = [];
		let complete!: () => void;
		const finished = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const h = await stack.start(
			[
				await stack.subagents(),
				router(policy),
				(pi) => {
					pi.events.on("subagents:scheduled", (event) => {
						jobs.push(event as (typeof jobs)[number]);
						if ((event as { type: string }).type === "error") complete();
					});
					pi.events.on("subagents:completed", () => complete());
					pi.events.on("router:rpc:admit", (raw) => admissions.push((raw as { model: string }).model));
				},
			],
			{ useModelRuntimeStream: true },
		);
		physical[1]?.setResponses([fauxAssistantMessage("ANSWER AFTER RESET")]);
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "park tier",
				prompt: "answer",
				model: "@cheap",
				run_in_background: true,
			}),
			fauxAssistantMessage("DRIVER DONE"),
		]);
		await h.session.prompt("run the tier");
		const result = outcomes(h, "Agent")[0];
		expect(result?.isError).toBe(policy === "fail");
		expect(result?.text).toContain("router/cheap is exhausted");
		expect(result?.text).not.toContain("router/default");
		expect(admissions).toEqual(["router/cheap"]);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 0]);
		if (policy === "fail") {
			expect(jobs).toEqual([]);
			return;
		}
		expect(jobs).toMatchObject([{ type: "added", job: { model: "@cheap", quotaParked: true } }]);
		// A fresh resolve at fire time sees changed quota, instead of replaying the admitted model.
		stack.clock.advance(3_659_000);
		stack.usage.set(CHAIN[0]?.provider, 100);
		stack.usage.set(CHAIN[1]?.provider, 0);
		h.setResponses([fauxAssistantMessage("NOTICED COMPLETION")]);
		stack.clock.advance(1000);
		await finished;
		expect(admissions).toEqual(["router/cheap", "router/cheap"]);
		expect(physical.map((provider) => provider.state.callCount)).toEqual([0, 1]);
		await h.session.waitForIdle();
	});
});
