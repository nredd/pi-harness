/** Manager-owned run and root identity, independent from model/session payloads. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { resumeAgent, runAgent } from "../src/agent-runner.ts";

vi.mock("../src/agent-runner.ts", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
let manager: AgentManager;
afterEach(() => manager?.dispose());

it("binds the SDK root, retains it for a branch and renews identity for an accepted resume", async () => {
	manager = new AgentManager();
	vi.mocked(runAgent).mockResolvedValue({
		responseText: "private",
		session: { dispose: vi.fn() } as never,
		aborted: false,
		steered: false,
	});
	vi.mocked(resumeAgent).mockResolvedValue({ text: "private continuation", aborted: false, steered: false });
	const pi = {} as never;
	const context = { cwd: "/tmp", sessionManager: { getSessionId: () => "root-one" } } as never;
	const { record } = await manager.spawnAndWait(pi, context, "Explore", "private prompt", { description: "inspect" });
	expect(record.rootSessionId).toBe("root-one");
	const run = record.runId;
	expect(run).toMatch(/^[0-9a-f-]{36}$/);
	await manager.resume(record.id, "again");
	expect(record.runId).not.toBe(run);
	const branch = await manager.spawnAndWait(pi, context, "Explore", "private", {
		description: "nested",
		rootSessionId: record.rootSessionId,
		parentAgentId: record.id,
		depth: 2,
	});
	expect(branch.record.rootSessionId).toBe("root-one");
	expect(branch.record.runId).not.toBe(record.runId);
	const unscoped = await manager.spawnAndWait(pi, { cwd: "/tmp", sessionManager: {} } as never, "Explore", "private", {
		description: "no identity",
	});
	expect(unscoped.record.rootSessionId).toBeUndefined();
	expect(manager.roster.parent("root-one").agents.map((r) => r.id)).toContain(branch.id);
	expect(manager.roster.parent("root-one").agents.map((r) => r.id)).not.toContain(unscoped.id);
});
