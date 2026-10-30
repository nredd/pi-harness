/** Promoted monitor tools survive parent and subagent-notification turns for the whole session. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, fauxToolCall, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { ControlledProcesses, configFor } from "../../packages/session-kit/test/scenarios/support.ts";
import { jsonFile } from "./agents-support.ts";
import { deferred, GoalStack } from "./goal-support.ts";
import { loadThirdParty } from "./support.ts";

/** Inspect schemas supplied to the real parent model request. */
async function request(h: Harness): Promise<string[]> {
	let tools: string[] = [];
	h.setResponses([
		(ctx) => {
			tools = getCurrentTools(ctx.messages).map((tool) => tool.name);
			return fauxAssistantMessage("OBSERVED");
		},
	]);
	await h.session.prompt("inspect current context");
	return tools;
}

it("keeps a promoted monitor callable across parent and subagent notification turns", async () => {
	const stack = await GoalStack.create();
	const processes = new ControlledProcesses(stack.clock);
	const completed = deferred<void>();
	const admission = deferred<void>();
	let h: Harness | undefined;
	try {
		const agentDir = join(stack.home.root, "agent");
		mkdirSync(agentDir, { recursive: true });
		jsonFile(join(agentDir, "deferred-tools.json"), {
			promotionLifetime: "session",
			alwaysActive: ["search_tools", "Agent", "demote_tools"],
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["kid/child"], packages: [] }));
		writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ rememberAgents: true }));
		const [child] = stack.registerPhysical([{ provider: "kid", id: "child" }]);
		if (!child) throw new Error("Missing child provider");
		child.setResponses([fauxAssistantMessage("CHILD FINISHED")]);
		h = await stack.start(
			[
				await stack.subagents(),
				createSessionKit({
					config: configFor("monitor"),
					agentDir,
					monitorRoot: join(stack.home.root, "monitors"),
					clock: stack.clock,
					spawnMonitor: processes.spawn,
				}),
				(pi) => {
					pi.events.on("router:rpc:admit", () => admission.resolve());
					pi.events.on("subagents:completed", () => completed.resolve());
				},
				await loadThirdParty("deferred"),
			],
			{ useModelRuntimeStream: true },
		);

		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("search_tools", { query: "monitor start background process", kind: "tool" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("PROMOTED"),
		]);
		await h.session.prompt("find the monitor tool");
		expect(await request(h)).toContain("monitor_start");

		h.setResponses([fauxAssistantMessage("PARENT TURN")]);
		await h.session.prompt("continue parent work");

		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("Agent", {
						subagent_type: "general-purpose",
						description: "notify parent",
						prompt: "finish and report",
						model: "kid/child",
						run_in_background: true,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("CHILD SPAWNED"),
			fauxAssistantMessage("NOTIFICATION TURN"),
		]);
		const spawn = h.session.prompt("start a child");
		await admission.promise;
		// No router is installed, so the real subagent admission callback fails open on the shared clock.
		stack.clock.advance(100);
		await spawn;
		await completed.promise;
		stack.clock.advance(200);
		await h.session.waitForIdle();
		expect(
			h.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "subagent-notification"),
		).toBe(true);

		h.setResponses([fauxAssistantMessage("FINAL PARENT TURN")]);
		await h.session.prompt("continue after the child");
		expect(await request(h)).toContain("monitor_start");
		const [started] = await runTools(h, [
			{ name: "monitor_start", args: { name: "lifecycle", argv: ["/bin/echo", "SESSION-LIFETIME"] } },
		]);
		expect(started?.isError, started?.text).toBe(false);
		await processes.last.stdout("SESSION-LIFETIME\n");

		const [demoted] = await runTools(h, [{ name: "demote_tools", args: { names: ["monitor_start"] } }]);
		expect(demoted?.isError, demoted?.text).toBe(false);
		expect(await request(h)).not.toContain("monitor_start");
		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("search_tools", { query: "monitor start background process", kind: "tool" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("REPROMOTED"),
		]);
		await h.session.prompt("find the monitor tool again");
		expect(await request(h)).toContain("monitor_start");
	} finally {
		await stack.cleanup();
	}
});
