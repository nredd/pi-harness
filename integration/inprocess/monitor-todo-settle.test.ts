/** A todo held while a real session-kit monitor is armed for it is waiting, not held by the parent. */
import { join } from "node:path";
import { createTestUiContext, fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import {
	ControlledProcesses,
	configFor,
	FakeClock,
	nextEvent,
} from "../../packages/session-kit/test/scenarios/support.ts";
import { isolateStackHome, loadFork, startStack } from "./support.ts";

const WAITING = "waiting on a monitor, which wakes the parent: #1 CI green (monitor ci)";
const HELD = "held by the parent: #1 CI green";

describe("todo settle with a linked session-kit monitor", () => {
	let home: Awaited<ReturnType<typeof isolateStackHome>>;
	let h: Harness | undefined;
	let processes: ControlledProcesses;
	let notices: string[];

	beforeEach(async () => {
		home = await isolateStackHome();
		const clock = new FakeClock();
		processes = new ControlledProcesses(clock);
		notices = [];
		h = await startStack({
			cwd: home.root,
			factories: [
				await loadFork("rpiv-todo"),
				createSessionKit({
					config: configFor("monitor"),
					agentDir: join(home.root, "agent"),
					monitorRoot: join(home.root, "monitors"),
					clock,
					spawnMonitor: processes.spawn,
				}),
			],
			mode: "rpc",
			ui: createTestUiContext({ notify: (message) => notices.push(message) }),
			settings: { compaction: { enabled: false } },
		});
	});
	afterEach(async () => {
		await h?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h?.cleanup();
		await home.cleanup();
	});

	const todoNotices = () => notices.filter((n) => n.includes("in_progress todo"));

	it("shows the todo as waiting, then held again when the monitor exits", async () => {
		if (!h) throw new Error("no harness");
		const [created, started, watching] = await runTools(h, [
			{ name: "todo", args: { action: "create", subject: "CI green" } },
			{ name: "todo", args: { action: "update", id: 1, status: "in_progress" } },
			{ name: "monitor_start", args: { name: "ci", argv: ["/bin/echo", "run"], match: "PASS|FAIL", todo: 1 } },
		]);
		for (const outcome of [created, started, watching]) expect(outcome?.isError, outcome?.text).toBe(false);
		expect(todoNotices()).toHaveLength(1);
		expect(todoNotices()[0]).toContain(WAITING);

		// The monitor exits: its wake turn settles with the todo still in_progress and nothing armed.
		h.setResponses([fauxAssistantMessage("woke")]);
		const settled = nextEvent(h, "agent_settled");
		processes.last.exit(0);
		await settled;
		await h.session.waitForIdle();
		expect(todoNotices()).toHaveLength(2);
		expect(todoNotices()[1]).toContain(HELD);
	});
});
