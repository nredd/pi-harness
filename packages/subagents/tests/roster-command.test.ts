/** The parent command uses its bound root and never adds a model-facing tool. */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSubagentsExtension } from "../src/index.ts";
import { bootPi, ctx, type Hermetic, hermeticDir } from "./fixtures/boot-extension.ts";

let env: Hermetic;
let boot: ReturnType<typeof bootPi>;
beforeEach(() => {
	initTheme("dark");
	env = hermeticDir({
		settings: { schedulingEnabled: false, workflowsEnabled: false, fleetView: false, widgetMode: "off" },
	});
	boot = bootPi();
	createSubagentsExtension()(boot.pi);
});
afterEach(async () => {
	await boot.recording.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx());
	env.restore();
});

it("reads and audits the parent roster without sending a message or registering a parent tool", async () => {
	const context = ctx({ hasUI: true });
	const handler = boot.commands.get("agents").handler;
	await handler("roster", context);
	const rows = JSON.parse(context.ui.notify.mock.calls.at(-1)[0]);
	expect(rows).toEqual({
		agents: [
			{ id: "root:s1", run: "root:s1", handle: "parent", type: "orchestrator", status: "running", assignment: "" },
		],
		truncated: false,
	});
	await handler("audit", context);
	const audit = JSON.parse(context.ui.notify.mock.calls.at(-1)[0]);
	expect(audit.truncated).toBe(false);
	expect(audit.events).toMatchObject([
		{ caller: "root:s1", run: "root:s1", kind: "roster.read", sequence: 1, data: { count: 1 } },
	]);
	expect(boot.tools.has("list_agents")).toBe(false);
	expect(boot.pi.sendMessage).not.toHaveBeenCalled();
	expect(boot.pi.sendUserMessage).not.toHaveBeenCalled();
});

it("emits explicit headless inspection output without requesting inference", async () => {
	const context = ctx();
	await boot.commands.get("agents").handler("roster", context);
	expect(boot.pi.sendMessage).toHaveBeenLastCalledWith(
		{ customType: "subagents-roster", content: expect.stringContaining('"root:s1"'), display: true },
		{ triggerTurn: false },
	);
	await boot.commands.get("agents").handler("roster", ctx({ sessionManager: {} }));
	expect(boot.pi.sendMessage).toHaveBeenLastCalledWith(
		{ customType: "subagents-roster", content: expect.stringContaining("Agent roster unavailable"), display: true },
		{ triggerTurn: false },
	);
	expect(boot.pi.sendUserMessage).not.toHaveBeenCalled();
});

it("reports missing SDK root identity without falling back to another session", async () => {
	for (const sessionManager of [undefined, {}, { getSessionId: () => "" }]) {
		const context = ctx({ sessionManager, hasUI: true });
		await boot.commands.get("agents").handler("roster", context);
		expect(context.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Agent roster unavailable"), "error");
	}
});
