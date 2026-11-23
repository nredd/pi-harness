/**
 * Carryover through real `AgentSession`s and file-backed `SessionManager`s: core persists the first
 * session's todos, and a fresh startup session in the same cwd and session directory gets them
 * listed once on its first request, without importing them. `/new` through a real
 * `AgentSessionRuntime` lists the replaced session's live branch, not its last entry on disk.
 */
import {
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
} from "@nredd/pi-test-lib/harness";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { getState } from "../../src/state/store.ts";
import { CARRYOVER_LIST_MESSAGE_TYPE } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";

type Step = Parameters<Harness["setResponses"]>[0][number];

const HEADER = "[rpiv-todo] This is a fresh session.";
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function start(sessionManager: SessionManager, cwd: string): Promise<Harness> {
	const harness = await createHarness({
		cwd,
		sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
		extensionFactories: [(pi) => registerTodo(pi)],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	return harness;
}

function recordLast(seen: string[], reply: ReturnType<typeof fauxAssistantMessage>): Step {
	return (ctx) => {
		seen.push(getMessageText(ctx.messages.at(-1)));
		return reply;
	};
}

it("lists the previous same-cwd session's open todos once in a fresh startup session", async () => {
	const cwd = makeTestTempDir("todo-carryover-cwd-", onTestFinished);
	const sessionDir = makeTestTempDir("todo-carryover-sessions-", onTestFinished);

	const first = await start(SessionManager.create(cwd, sessionDir), cwd);
	first.setResponses([
		fauxAssistantMessage(
			fauxToolCall("todo", {
				ops: [
					{ action: "create", subject: "Ship widgets" },
					{ action: "create", subject: "Drop old widgets" },
					{ action: "update", id: 2, status: "completed", evidence: "removed in a1b2c3" },
				],
			}),
		),
		fauxAssistantMessage("Tracked."),
	]);
	await first.session.prompt("Track the widget work");
	expect(first.getPendingResponseCount()).toBe(0);

	const second = await start(SessionManager.create(cwd, sessionDir), cwd);
	const seen: string[] = [];
	second.setResponses([recordLast(seen, fauxAssistantMessage("Noted."))]);
	await second.session.prompt("Continue the handoff");
	second.setResponses([recordLast(seen, fauxAssistantMessage("Still here."))]);
	await second.session.prompt("Status?");
	expect(second.getPendingResponseCount()).toBe(0);

	expect(seen).toHaveLength(2);
	expect(seen[0]).toContain(
		`${HEADER} The previous session in this directory (${first.sessionManager.getSessionId()})`,
	);
	expect(seen[0]).toContain("- #1 pending Ship widgets\n");
	expect(seen[0]).not.toContain("Drop old widgets");
	expect(seen[1]).toBe("Status?");
	// Read-only: the fresh session's list stays empty and the list is never persisted.
	expect(getState(second.sessionManager.getSessionId()).tasks).toEqual([]);
	const persisted = JSON.stringify(second.sessionManager.getBranch());
	expect(persisted).not.toContain(CARRYOVER_LIST_MESSAGE_TYPE);
	expect(persisted).not.toContain(HEADER);
});

it("lists the live branch /new replaced, after /tree moved its leaf without writing", async () => {
	const cwd = makeTestTempDir("todo-carryover-cwd-", onTestFinished);
	const sessionDir = makeTestTempDir("todo-carryover-sessions-", onTestFinished);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const harness = await createHarness({
			cwd: options.cwd,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			extensionFactories: [(pi) => registerTodo(pi)],
		});
		harnesses.push(harness);
		const services = { cwd: options.cwd, agentDir: options.agentDir } as AgentSessionServices;
		const extensionsResult = harness.session.resourceLoader.getExtensions();
		return { session: harness.session, extensionsResult, services, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: sessionDir,
		sessionManager: SessionManager.create(cwd, sessionDir),
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	const bind = (session: typeof runtime.session) =>
		session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	const [first] = harnesses;

	first.setResponses([
		fauxAssistantMessage(fauxToolCall("todo", { action: "create", subject: "Ship widgets" })),
		fauxAssistantMessage("Tracked."),
	]);
	await runtime.session.prompt("Track the widget work");
	const tracked = first.sessionManager.getLeafId() as string;
	first.setResponses([
		fauxAssistantMessage(fauxToolCall("todo", { action: "update", id: 1, status: "completed", evidence: "a1b2c3" })),
		fauxAssistantMessage("Done."),
	]);
	await runtime.session.prompt("Finish it");
	// Back to where #1 was still open, with no summary: core moves the leaf and writes nothing.
	const written = first.sessionManager.getEntries().length;
	await runtime.session.navigateTree(tracked, { summarize: false });
	expect(first.sessionManager.getEntries()).toHaveLength(written);
	expect(first.sessionManager.getLeafId()).toBe(tracked);

	await runtime.newSession();
	const second = harnesses[1];
	expect(runtime.session).toBe(second.session);
	const seen: string[] = [];
	second.setResponses([recordLast(seen, fauxAssistantMessage("Noted."))]);
	await runtime.session.prompt("Continue");
	expect(seen[0]).toContain(`(${first.sessionManager.getSessionId()}) last recorded`);
	expect(seen[0]).toContain("- #1 pending Ship widgets\n");
});
