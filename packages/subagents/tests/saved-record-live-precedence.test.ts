/** Saved history must never shadow actual notes; live-over-saved precedence is pinned in `agent-ref.test.ts`. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { outcomes, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import { AgentManager, type EvictedNote } from "../src/agent-manager.ts";
import { spoolDetached } from "../src/detached-results.ts";
import { answer, ScenarioSession } from "./fixtures/scenario-session.ts";

let fixture: ScenarioSession;
afterEach(async () => {
	await fixture?.dispose();
	Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

it("preserves a delivered detached note and name conflict when saved history fills the index", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession();
	const sessions = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: sessions } });
	h.setResponses([answer("CREATE PARENT")]);
	await h.session.prompt("create parent");
	for (let i = 0; i < 500; i++)
		sessions.appendCustomEntry("subagents:record", {
			id: `old-${i}`,
			type: "general-purpose",
			description: "older history",
			status: "completed",
		});
	sessions.appendCustomEntry("subagents:record", {
		id: "delivered",
		type: "general-purpose",
		description: "stale historical attempt",
		status: "stopped",
	});
	const parentFile = sessions.getSessionFile();
	if (!parentFile) throw new Error("No saved parent file");
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const result = (id: string) => ({
		id,
		content: "synthetic detached result",
		details: { id },
		evicted: [
			{ id, type: "general-purpose", description: "detached result", status: "completed" as const, evictedAfterMin: 0 },
		],
		tombstones: [
			{
				id,
				handle: "shared",
				type: "general-purpose",
				description: "detached result",
				sessionFile: join(fixture.root, `${id}.jsonl`),
				completedAt: 1,
			},
		],
		record: { id, type: "general-purpose", description: "detached result", status: "completed" },
	});
	spoolDetached(parentFile, result("a-holder"));
	spoolDetached(parentFile, result("delivered"));
	const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
	reopened.setResponses([
		toolCalls({ name: "steer_subagent", args: { agent_id: "delivered", message: "continue" } }),
		answer("CHECKED"),
	]);
	await reopened.session.prompt("inspect delivered");
	const text = outcomes(reopened, "steer_subagent")[0]?.text ?? "";
	expect(text).toContain('its name "shared" now belongs to another agent');
	expect(text).not.toContain("recovered from saved parent session");
});

it("lets actual notes supersede historical duplicates, with no cap on either class (#372)", () => {
	const manager = new AgentManager(() => {});
	const note = (id: string, historical: boolean): EvictedNote => ({
		id,
		type: "general-purpose",
		description: historical ? "historical" : "actual",
		status: "completed",
		evictedAfterMin: 0,
		...(historical ? { fromSavedSession: true } : {}),
	});
	for (let i = 0; i < 500; i++) manager.rememberEvicted(note(`actual-${i}`, false));
	manager.rememberEvicted(note("historical-late", true));
	expect(manager.getEvictedNote("historical-late")?.description).toBe("historical");
	expect(manager.getEvictedNote("actual-0")?.description).toBe("actual");
	manager.rememberEvicted(note("actual-0", true));
	expect(manager.getEvictedNote("actual-0")?.description).toBe("actual");
	const another = new AgentManager(() => {});
	another.rememberEvicted(note("duplicate", true));
	another.rememberEvicted(note("duplicate", false));
	expect(another.getEvictedNote("duplicate")?.description).toBe("actual");
	another.rememberEvicted(note("duplicate", true));
	expect(another.getEvictedNote("duplicate")?.description).toBe("actual");
});
