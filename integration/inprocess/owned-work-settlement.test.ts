/** Real todo boundaries with synthetic ownership, never real agents/monitors or inferred model intent. */
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestUiContext, fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELD_REMINDER_MESSAGE_TYPE, STATE_ENTRY_TYPE, type Task } from "../../packages/todo/tool/types.ts";
import { isolateStackHome, loadFork, startStack } from "./support.ts";

interface Case {
	name: string;
	tasks: Task[];
	agent?: "running" | "failed" | "done";
	monitor?: number[];
	reminder: boolean;
	group: string;
	level: "info" | "warning";
}
const held: Task = { id: 1, subject: "Implement the local fix", status: "in_progress" };
const cases: Case[] = [
	{
		name: "parent-held actionable work with no wake",
		tasks: [held],
		reminder: true,
		group: "held by the parent",
		level: "warning",
	},
	{
		name: "unrelated unlinked monitor does not mask local work",
		tasks: [held],
		monitor: [],
		reminder: true,
		group: "held by the parent",
		level: "warning",
	},
	{
		name: "monitor linked to another todo does not mask local work",
		tasks: [held, { id: 2, subject: "Wait for CI", status: "in_progress" }],
		monitor: [2],
		reminder: true,
		group: "held by the parent: #1",
		level: "warning",
	},
	// Characterize the remaining session-wide policy, do not silently change #292/#586.
	{
		name: "unrelated background agent suppresses the reminder for local work",
		tasks: [held],
		agent: "running",
		reminder: false,
		group: "held by the parent",
		level: "info",
	},
	{
		name: "all actionable work blocked on an armed monitor",
		tasks: [
			{ ...held, blockedBy: [2] },
			{ id: 2, subject: "Wait for CI", status: "in_progress" },
		],
		monitor: [2],
		reminder: false,
		group: "blocked: #1",
		level: "info",
	},
	{
		name: "explicit wait represented by a linked monitor",
		tasks: [{ ...held, subject: "Wait for approved dependency" }],
		monitor: [1],
		reminder: false,
		group: "waiting on a monitor",
		level: "info",
	},
	{
		name: "lost owner after process startup",
		tasks: [{ ...held, owner: "fixture-worker" }],
		reminder: true,
		group: "owner agent not found after resume",
		level: "warning",
	},
	{
		name: "failed owner warns without a new continuation policy",
		tasks: [{ ...held, owner: "fixture-worker" }],
		agent: "failed",
		reminder: false,
		group: "owner agent failed or stopped",
		level: "warning",
	},
	{
		name: "completed child leaves parent-owned follow-up actionable",
		tasks: [{ ...held, owner: "fixture-worker" }],
		agent: "done",
		reminder: true,
		group: "held by the parent",
		level: "warning",
	},
];

describe("owned-work settlement diagnostics", () => {
	let home: Awaited<ReturnType<typeof isolateStackHome>>;
	let h: Harness | undefined;
	beforeEach(async () => {
		home = await isolateStackHome();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Ownership diagnostics must stay offline"));
	});
	afterEach(async () => {
		await h?.session.abort();
		await h?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h?.cleanup();
		h = undefined;
		vi.restoreAllMocks();
		await home.cleanup();
	});

	it.each(cases)("$name", async ({ tasks, agent, monitor, reminder, group, level }) => {
		const manager = SessionManager.inMemory(home.root);
		manager.appendCustomEntry(STATE_ENTRY_TYPE, { persistenceVersion: 1, tasks, nextId: tasks.length + 1 });
		const decisions: boolean[] = [];
		const notices: [string, string | undefined][] = [];
		const ownership: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (agent) {
					const channel =
						agent === "running" ? "subagents:started" : agent === "failed" ? "subagents:failed" : "subagents:completed";
					pi.events.emit(channel, { id: "fixture-worker", status: agent, wakesParent: agent === "running" });
				}
				if (monitor)
					pi.events.emit("session-kit:monitor:started", {
						sessionId: ctx.sessionManager.getSessionId(),
						id: "fixture-monitor",
						name: "fixture-monitor",
						todos: monitor,
					});
			});
			// Loaded after todo: observes the chained decision, not an independent guess.
			pi.on("agent_before_settle", (event) => {
				decisions.push(event.continue);
			});
		};
		h = await startStack({
			cwd: home.root,
			sessionManager: manager,
			factories: [await loadFork("rpiv-todo"), ownership],
			mode: "rpc",
			ui: createTestUiContext({ notify: (message, severity) => notices.push([message, severity]) }),
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		h.setResponses([fauxAssistantMessage("synthetic final"), fauxAssistantMessage("synthetic reminder answer")]);
		await h.session.prompt("Follow the recorded ownership; wait only for the blocked dependency");
		expect(decisions).toEqual(reminder ? [true, false] : [false]);
		expect(h.getPendingResponseCount()).toBe(reminder ? 0 : 1);
		expect(
			manager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === HELD_REMINDER_MESSAGE_TYPE),
		).toHaveLength(reminder ? 1 : 0);
		expect(notices).toContainEqual([expect.stringContaining(group), level]);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		// Settlement does not manufacture task completion, even after the one permitted reminder.
		const saved = manager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE);
		expect(saved).toHaveLength(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("does not turn pending todos alone into a continuation condition", async () => {
		const manager = SessionManager.inMemory(home.root);
		manager.appendCustomEntry(STATE_ENTRY_TYPE, {
			persistenceVersion: 1,
			tasks: [{ ...held, status: "pending" }],
			nextId: 2,
		});
		h = await startStack({ cwd: home.root, sessionManager: manager, factories: [await loadFork("rpiv-todo")] });
		h.setResponses([fauxAssistantMessage("waiting as instructed")]);
		await h.session.prompt("Wait; do not start this pending item");
		expect(h.eventsOfType("message_end").filter(({ message }) => message.role === "assistant")).toHaveLength(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
