/** Routine operational tools stay in the real parent loadout without a discovery round trip. */
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDevTools } from "../../packages/dev-tools/src/index.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { configFor } from "../../packages/session-kit/test/scenarios/support.ts";
import { createSubscriptionRouter } from "../../packages/subscription-router/src/index.ts";
import { call, jsonFile } from "./agents-support.ts";
import { GoalStack } from "./goal-support.ts";
import { isolateStackHome, loadThirdParty, startStack } from "./support.ts";

const ROUTINE_TOOLS = [
	"git_status",
	"git_worktree_list",
	"git_diff",
	"git_log",
	"git_show",
	"git_commit",
	"ssh_exec",
	"resource_snapshot",
	"monitor_start",
	"monitor_read",
	"monitor_stop",
	"subscription_usage",
] as const;

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;

beforeAll(async () => {
	home = await isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		alwaysActive: ["search_tools", ...ROUTINE_TOOLS],
		// `goal_update` remains a state-dependent control: the kit exposes it only while a goal is active.
		neverDefer: ["search_tools", "goal_update", ...ROUTINE_TOOLS],
	});
	h = await startStack({
		cwd: home.root,
		factories: [
			createDevTools(),
			createSessionKit({ config: configFor("goal", "monitor"), agentDir: join(home.root, "agent") }),
			createSubscriptionRouter(),
			await loadThirdParty("deferred"),
		],
	});
});

afterAll(async () => {
	try {
		if (h) await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		h?.cleanup();
		await home?.cleanup();
	}
});

/** Observe the schemas sent to the actual provider boundary without calling discovery. */
async function parentTools(): Promise<string[]> {
	let tools: string[] = [];
	h.setResponses([
		(ctx) => {
			tools = getCurrentTools(ctx.messages).map((tool) => tool.name);
			return fauxAssistantMessage("OBSERVED");
		},
	]);
	await h.session.prompt("inspect routine tools");
	return tools;
}

it("keeps routine tools available in a fresh parent session and after a real parent turn", async () => {
	// This first provider request deliberately occurs before any `search_tools` call.
	expect(await parentTools()).toEqual(expect.arrayContaining([...ROUTINE_TOOLS]));
	expect(await parentTools()).toEqual(expect.arrayContaining([...ROUTINE_TOOLS]));
});

it("keeps routine tools active in the provider request triggered by a real child notification", async () => {
	const stack = await GoalStack.create();
	try {
		jsonFile(join(stack.home.root, "agent/deferred-tools.json"), {
			alwaysActive: ["search_tools", "Agent", "hold", ...ROUTINE_TOOLS],
			neverDefer: ["search_tools", "Agent", "hold", ...ROUTINE_TOOLS],
		});
		jsonFile(join(stack.home.root, "agent/settings.json"), { enabledModels: ["kid/child"], packages: [] });
		jsonFile(join(stack.home.root, "agent/subagents.json"), { rememberAgents: true });
		const [child] = stack.registerPhysical([{ provider: "kid", id: "child" }]);
		if (!child) throw new Error("Missing child provider");
		let releaseChild: (() => void) | undefined;
		const childReleased = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let resolveChild: (() => void) | undefined;
		const childCompleted = new Promise<void>((resolve) => {
			resolveChild = resolve;
		});
		let resolveHold: (() => void) | undefined;
		const holdEntered = new Promise<void>((resolve) => {
			resolveHold = resolve;
		});
		const notification = await stack.start(
			[
				await stack.subagents(),
				createDevTools(),
				createSessionKit({
					config: configFor("goal", "monitor"),
					agentDir: join(stack.home.root, "agent"),
					clock: stack.clock,
				}),
				stack.router([{ provider: "kid", id: "child" }]),
				await loadThirdParty("deferred"),
				(pi) => {
					pi.registerTool({
						name: "hold",
						label: "Hold",
						description: "Hold the real parent tool boundary until the child completes.",
						parameters: Type.Object({}),
						execute: async () => {
							resolveHold?.();
							await childCompleted;
							return { content: [{ type: "text", text: "child completed" }], details: undefined };
						},
					});
				},
			],
			{ useModelRuntimeStream: true },
		);
		child.setResponses([
			async () => {
				await childReleased;
				resolveChild?.();
				return fauxAssistantMessage("CHILD COMPLETE");
			},
		]);
		let tools: string[] | undefined;
		notification.setResponses([
			call("Agent", {
				subagent_type: "general-purpose",
				description: "notify parent",
				prompt: "finish",
				run_in_background: true,
				model: "kid/child",
			}),
			call("hold", {}),
			fauxAssistantMessage("PARENT DONE"),
			(ctx) => {
				expect(ctx.messages.some((message) => JSON.stringify(message).includes("<task-notification>"))).toBe(true);
				tools = getCurrentTools(ctx.messages).map((tool) => tool.name);
				return fauxAssistantMessage("OBSERVED AFTER NOTICE");
			},
		]);
		const run = notification.session.prompt("start background child");
		await holdEntered;
		releaseChild?.();
		await run;
		expect(notification.sessionManager.getBranch()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ customType: "subagents:record" }),
				expect.objectContaining({ customType: "subagent-notification" }),
			]),
		);
		expect(tools).toEqual(expect.arrayContaining([...ROUTINE_TOOLS]));
	} finally {
		await stack.cleanup();
	}
});

it("does not override an explicit SessionKit monitor disable", async () => {
	const disabledHome = await isolateStackHome();
	let disabled: Harness | undefined;
	try {
		jsonFile(join(disabledHome.root, "agent/deferred-tools.json"), {
			alwaysActive: ["search_tools", "monitor_start", "monitor_read", "monitor_stop"],
			neverDefer: ["search_tools", "monitor_start", "monitor_read", "monitor_stop"],
		});
		disabled = await startStack({
			cwd: disabledHome.root,
			factories: [
				createSessionKit({ config: configFor("goal"), agentDir: join(disabledHome.root, "agent") }),
				await loadThirdParty("deferred"),
			],
		});
		let tools: string[] = [];
		disabled.setResponses([
			(ctx) => {
				tools = getCurrentTools(ctx.messages).map((tool) => tool.name);
				return fauxAssistantMessage("OBSERVED");
			},
		]);
		await disabled.session.prompt("inspect disabled monitor");
		for (const name of ["monitor_start", "monitor_read", "monitor_stop"]) expect(tools).not.toContain(name);
	} finally {
		if (disabled) await disabled.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		disabled?.cleanup();
		await disabledHome.cleanup();
	}
});
