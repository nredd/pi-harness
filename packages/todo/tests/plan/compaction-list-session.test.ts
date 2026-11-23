/**
 * The post-compaction todo list through a real `AgentSession`: core compacts the branch, emits
 * `session_compact`, and the first model request after it carries the open list once, unpersisted.
 */
import {
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
} from "@nredd/pi-test-lib/harness";
import { afterEach, expect, it } from "vitest";
import { COMPACTION_LIST_MESSAGE_TYPE } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";

type Step = Parameters<Harness["setResponses"]>[0][number];

const HEADER = "[rpiv-todo] The conversation was compacted";
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** A step that records the last message text of the request it answers. */
function recordLast(seen: string[], reply: ReturnType<typeof fauxAssistantMessage>): Step {
	return (ctx) => {
		seen.push(getMessageText(ctx.messages.at(-1)));
		return reply;
	};
}

it("lists open todos on the first request after a compaction, once and unpersisted", async () => {
	const harness = await createHarness({
		settings: { compaction: { enabled: false } },
		extensionFactories: [(pi) => registerTodo(pi)],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("todo", {
				ops: [
					{ action: "create", subject: "Ship widgets" },
					{ action: "create", subject: "Verify widgets", blockedBy: [1] },
					{ action: "create", subject: "Drop old widgets" },
					{ action: "update", id: 3, status: "completed", evidence: "removed in a1b2c3" },
				],
			}),
		),
		fauxAssistantMessage("Tracked."),
	]);
	await harness.session.prompt("Track the widget work");
	expect(harness.getPendingResponseCount()).toBe(0);

	harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } });
	harness.setResponses([fauxAssistantMessage("Summary: widget work tracked."), fauxAssistantMessage("Prefix.")]);
	await harness.session.compact();
	expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);

	const seen: string[] = [];
	harness.setResponses([
		recordLast(seen, fauxAssistantMessage(fauxToolCall("todo", { action: "list" }))),
		recordLast(seen, fauxAssistantMessage("Listed.")),
	]);
	await harness.session.prompt("Continue");
	harness.setResponses([recordLast(seen, fauxAssistantMessage("Still here."))]);
	await harness.session.prompt("Status?");
	expect(harness.getPendingResponseCount()).toBe(0);

	expect(seen).toHaveLength(3);
	expect(seen[0]).toContain(HEADER);
	expect(seen[0]).toContain("- #1 pending Ship widgets\n- #2 pending Verify widgets (blocked by #1)\n");
	expect(seen[0]).not.toContain("Drop old widgets");
	expect(seen[1]).not.toContain(HEADER);
	expect(seen[2]).toBe("Status?");
	const persisted = JSON.stringify(harness.sessionManager.getBranch());
	expect(persisted).not.toContain(COMPACTION_LIST_MESSAGE_TYPE);
	expect(persisted).not.toContain(HEADER);
});
