/**
 * Nudge budget persistence through a real `AgentSession` and `SessionManager`: core commits the
 * settle drafts in order, projects only the marker into model context, and a resume reads the
 * budget from the bookkeeping entry.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	fauxToolCall,
	type Harness,
} from "@nredd/pi-test-lib/harness";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_REMINDER_MARKER } from "../../src/plan/hooks.ts";
import { EMPTY_REMINDER_MESSAGE_TYPE, NUDGE_BUDGET_ENTRY_TYPE } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";
import { TEST_HOME } from "../fixtures/setup.ts";

const config = join(TEST_HOME, ".config", "rpiv-todo", "config.json");
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	rmSync(config, { force: true });
});

/** A non-todo tool, so the parent does work without a list. */
const probe: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "probe",
		label: "probe",
		description: "Test probe",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	});
};

async function start(sessionManager: SessionManager, reason?: "resume"): Promise<Harness> {
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, JSON.stringify({ emptyAfterToolCalls: 1, emptyReminderCooldownSettles: 1 }));
	const harness = await createHarness({
		sessionManager,
		sessionStartEvent: reason ? { type: "session_start", reason } : undefined,
		extensionFactories: [(pi) => registerTodo(pi), probe],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	return harness;
}

const work = () => [fauxAssistantMessage(fauxToolCall("probe", {})), fauxAssistantMessage("done")];
const custom = (harness: Harness, type: string) =>
	harness.sessionManager.getBranch().filter((entry) => "customType" in entry && entry.customType === type);

it("persists the budget as bookkeeping outside the projected model context", async () => {
	const harness = await start(SessionManager.inMemory());
	harness.setResponses([...work(), fauxAssistantMessage("listed")]);
	await harness.session.prompt("Work");

	const [budget] = custom(harness, NUDGE_BUDGET_ENTRY_TYPE);
	const [marker] = custom(harness, EMPTY_REMINDER_MESSAGE_TYPE);
	expect(budget).toMatchObject({ type: "custom", data: { persistenceVersion: 1, nudge: "empty" } });
	expect(marker).toMatchObject({ type: "custom_message", content: EMPTY_REMINDER_MARKER, parentId: budget?.id });
	const projected = harness.sessionManager.buildSessionProjection().entries;
	expect(projected.find((entry) => entry.sourceEntry.id === budget?.id)?.messages ?? []).toEqual([]);
	expect(projected.find((entry) => entry.sourceEntry.id === marker?.id)?.messages).toMatchObject([
		{ role: "custom", customType: EMPTY_REMINDER_MESSAGE_TYPE },
	]);
	expect(harness.getPendingResponseCount()).toBe(0);
});

it("fails closed when the budget persists but the marker does not", async () => {
	const manager = SessionManager.inMemory();
	const harness = await start(manager);
	const append = manager.appendCustomMessageEntry.bind(manager);
	vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation((customType, ...rest) => {
		if (customType === EMPTY_REMINDER_MESSAGE_TYPE) throw new Error("disk full");
		return append(customType, ...rest);
	});
	harness.setResponses(work());
	await harness.session.prompt("Work").catch(() => undefined);
	expect(custom(harness, NUDGE_BUDGET_ENTRY_TYPE)).toHaveLength(1);
	expect(custom(harness, EMPTY_REMINDER_MESSAGE_TYPE)).toEqual([]);
	vi.restoreAllMocks();

	// No live human input after the resume: the restored spent budget keeps the next settle quiet.
	const resumed = await start(manager, "resume");
	resumed.setResponses(work());
	await resumed.session.prompt("Continue", { source: "extension" });
	expect(custom(resumed, NUDGE_BUDGET_ENTRY_TYPE)).toHaveLength(1);
	expect(custom(resumed, EMPTY_REMINDER_MESSAGE_TYPE)).toEqual([]);
	expect(resumed.getPendingResponseCount()).toBe(0);
});
