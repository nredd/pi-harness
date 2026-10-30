/** Routine operational tools stay in the real parent loadout without a discovery round trip. */
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDevTools } from "../../packages/dev-tools/src/index.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { configFor } from "../../packages/session-kit/test/scenarios/support.ts";
import { agentStack, call, closeAgentStack, jsonFile } from "./agents-support.ts";
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

it("keeps routine tools active after a real background subagent settlement", async () => {
	const notificationHome = await isolateStackHome();
	let notification: Harness | undefined;
	try {
		jsonFile(join(notificationHome.root, "agent/deferred-tools.json"), {
			alwaysActive: ["search_tools", "Agent", ...ROUTINE_TOOLS],
			neverDefer: ["search_tools", "Agent", ...ROUTINE_TOOLS],
		});
		let completed: (() => void) | undefined;
		const settled = new Promise<void>((resolve) => {
			completed = resolve;
		});
		notification = await agentStack(notificationHome.root, {
			factories: [
				createDevTools(),
				createSessionKit({
					config: configFor("goal", "monitor"),
					agentDir: join(notificationHome.root, "agent"),
				}),
				await loadThirdParty("deferred"),
				(pi) => {
					pi.events.on("subagents:completed", () => completed?.());
				},
			],
		});
		notification.setResponses([
			call("Agent", {
				subagent_type: "general-purpose",
				description: "notify parent",
				prompt: "finish",
				run_in_background: true,
				model: `${notification.getModel().provider}/${notification.getModel().id}`,
			}),
			fauxAssistantMessage("SPAWNED"),
			fauxAssistantMessage("CHILD COMPLETE"),
		]);
		await notification.session.prompt("start background child");
		await settled;
		await notification.session.waitForIdle();
		expect(notification.sessionManager.getBranch()).toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "subagents:record" })]),
		);
		let tools: string[] = [];
		notification.setResponses([
			(ctx) => {
				tools = getCurrentTools(ctx.messages).map((tool) => tool.name);
				return fauxAssistantMessage("OBSERVED AFTER NOTICE");
			},
		]);
		await notification.session.prompt("inspect routine tools after child notification");
		expect(tools).toEqual(expect.arrayContaining([...ROUTINE_TOOLS]));
	} finally {
		if (notification) await closeAgentStack(notification);
		await notificationHome.cleanup();
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
