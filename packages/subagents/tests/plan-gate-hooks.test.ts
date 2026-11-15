/**
 * plan-gate-hooks.test.ts -- #437: the hooks a child session installs for a Plan gate, driven through the real
 * `runAgent` on a faux model with a hand-written policy. The same gate under the real pi-plan-mode runs in
 * `integration/inprocess/plan-mode-children.test.ts` (#867).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import type { PlanGate } from "../src/plan-mode-children.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "../test/helpers/pi-ai.js";
import { runAgent } from "../test/helpers/run-selected-agent.js";

vi.setConfig({ testTimeout: 30_000 });

const ALPHA = fileURLToPath(new URL("../test/fixtures/ext-alpha.mjs", import.meta.url));

/** The two hooks a child session routes tool calls through, as the gate installs them. */
interface HookedSession {
	systemPrompt: string;
	agent: { beforeToolCall(call: unknown): Promise<unknown> };
	_beforeToolCall(call: unknown, parentCall: string): Promise<unknown>;
}
const notBlocked = (verdict: unknown): boolean => !(verdict as { block?: boolean } | undefined)?.block;

describe("the child's Plan gate (#437)", () => {
	let cwd: string | undefined;
	let faux: ReturnType<typeof registerFauxProvider> | undefined;
	afterEach(() => {
		faux?.unregister();
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	it("vetoes model calls and nested executeTool calls, reads the gate per call, and briefs the child", async () => {
		cwd = mkdtempSync(join(tmpdir(), "plan-gate-"));
		faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
		registerAgents(
			new Map([
				[
					"planner-child",
					{
						name: "planner-child",
						description: "plan gate",
						builtinToolNames: ["read", "write"],
						extensions: [ALPHA],
						skills: false,
						systemPrompt: "You are a child.",
						promptMode: "replace",
						isolated: false,
					} as AgentConfig,
				],
			]),
		);
		const model = faux.getModel();
		const modelRegistry = {
			find: () => model,
			getAll: () => [model],
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
			isUsingOAuth: () => false,
			getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
			registerProvider: () => {},
			unregisterProvider: () => {},
		};
		const ctx = { cwd, getSystemPrompt: () => "PARENT", isProjectTrusted: () => true, model, modelRegistry };
		const seen: Array<{ toolName: string; cwd: string; source: string | undefined }> = [];
		const gate: PlanGate = {
			policy: ({ toolName, cwd: callCwd, tool }) => {
				seen.push({ toolName, cwd: callCwd, source: tool?.sourceInfo?.source });
				return toolName === "alpha_write" || toolName === "write" ? `Plan blocks ${toolName}` : undefined;
			},
		};
		let session: HookedSession | undefined;
		try {
			await runAgent(ctx as never, "planner-child", "go", {
				pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
				model,
				planGate: gate,
				onSessionCreated: (s) => {
					session = s as unknown as HookedSession;
				},
			});
		} catch {
			// The faux model has no scripted turn; the gate is installed before the prompt.
		}

		if (!session) throw new Error("the child session was never created");
		expect(session.systemPrompt).toContain("<plan_mode>");
		await expect(session.agent.beforeToolCall({ toolCall: { name: "write" }, args: {} })).resolves.toEqual({
			block: true,
			reason: "Plan blocks write",
		});
		expect(seen[0]).toEqual({ toolName: "write", cwd, source: "builtin" });
		await expect(session.agent.beforeToolCall({ toolCall: { name: "alpha_read" }, args: {} })).resolves.toSatisfy(
			notBlocked,
		);
		// Nested calls (codemode scripts) reach extensions' tool_call handlers only.
		await expect(
			session._beforeToolCall({ toolCall: { name: "alpha_write", id: "n1" }, args: {} }, "parent-call"),
		).resolves.toMatchObject({ block: true, reason: "Plan blocks alpha_write" });

		// A resume after the parent left Plan: same hooks, no policy.
		gate.policy = undefined;
		await expect(
			session._beforeToolCall({ toolCall: { name: "alpha_write", id: "n2" }, args: {} }, "parent-call"),
		).resolves.toSatisfy(notBlocked);
		await expect(session.agent.beforeToolCall({ toolCall: { name: "write" }, args: {} })).resolves.toSatisfy(
			notBlocked,
		);
	});
});
