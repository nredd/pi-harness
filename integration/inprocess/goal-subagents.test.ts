/** Real child sessions, manager accounting and busy-parent completion delivery. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { complete, deferred, GoalStack, goalStates, nudges, outcomes, spoken, tool } from "./goal-support.ts";
import { loadFork } from "./support.ts";

/** A real Agent request, not a replacement manager/runner. */
function agent(background: boolean) {
	return tool("Agent", {
		subagent_type: "general-purpose",
		description: "child",
		prompt: "work",
		model: "kid/child",
		run_in_background: background,
	});
}

describe("goal and real subagent sessions", () => {
	let stack: GoalStack;
	let child: FauxProviderRegistration | undefined;
	afterEach(async () => {
		await stack?.cleanup();
		child?.unregister();
	});

	/** Load the kit through the child's actual resource loader as well as the parent factory. */
	async function start(extra: ExtensionFactory[] = []) {
		stack = new GoalStack();
		const agentDir = join(stack.home.root, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The runner's REAL DefaultResourceLoader loads the kit into every child.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				extensions: [fileURLToPath(new URL("../../packages/session-kit/src/index.ts", import.meta.url))],
				enabledModels: ["kid/child"],
				packages: [],
			}),
		);
		writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ rememberAgents: true }));
		writeFileSync(
			join(agentDir, "pi-session-kit.json"),
			JSON.stringify(
				Object.fromEntries(["titles", "rules", "monitor", "diff", "stats"].map((f) => [f, { enabled: false }])),
			),
		);
		stack.usage.set("kid", 0);
		child = registerFauxProvider({ provider: "kid", models: [{ id: "child" }] });
		const h = await stack.start(
			[await loadFork("pi-subagents"), stack.router([{ provider: "kid", id: "child" }]), stack.kit(), ...extra],
			{ useModelRuntimeStream: true },
		);
		const model = child.getModel();
		h.session.modelRuntime.registerProvider("kid", {
			baseUrl: model.baseUrl,
			apiKey: "faux",
			api: child.api,
			models: child.models,
		});
		expect(await h.session.modelRuntime.getAuth(model)).toBeDefined();
		return { h, child };
	}

	it("foreground child is isolated from parent goal accounting", async () => {
		const { h, child } = await start();
		child.setResponses([
			tool("bash", { command: "/bin/echo one" }),
			tool("bash", { command: "/bin/echo two" }),
			(ctx) =>
				fauxAssistantMessage(
					`TOOLS ${getCurrentTools(ctx.messages)
						.map((t) => t.name)
						.join(",")}`,
				),
		]);
		h.setResponses([
			agent(false),
			fauxAssistantMessage("p2"),
			fauxAssistantMessage("p3"),
			fauxAssistantMessage("SHOULD NOT RUN"),
		]);
		await h.session.prompt("/goal cap test --turns 3");
		await h.session.prompt("go");
		const spawned = outcomes(h, "Agent");
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.isError, spawned[0]?.text).toBe(false);
		expect(spawned[0]?.text.match(/TOOLS /g)).toHaveLength(1);
		expect(spawned[0]?.text).not.toContain("goal_update");
		expect(child.state.callCount).toBe(3);
		const sessions = join(stack.home.root, "agent", "sessions");
		const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((file) =>
			file.endsWith(".jsonl"),
		);
		expect(files).toHaveLength(1);
		const entries: { type: string; customType?: string; data?: unknown }[] = files.flatMap((file) =>
			readFileSync(join(sessions, file), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		expect(entries.filter((e) => e.customType === "session-kit:child")).toHaveLength(1);
		expect(
			entries.filter((e) => e.customType === "session-kit:goal" || e.customType === "session-kit:goal-nudge"),
		).toEqual([]);
		expect(spoken(h)).toEqual(["p2", "p3"]);
		expect(nudges(h)).toHaveLength(1);
		expect(goalStates(h).at(-1)).toMatchObject({ status: "budget", turns: 3 });
		expect(h.getPendingResponseCount()).toBe(1);
	});

	it("background notice wins before goal nudge", async () => {
		const completed = deferred<void>();
		const held = deferred<void>();
		const release = deferred<void>();
		const { h, child } = await start([
			(pi) => {
				pi.events.on("subagents:completed", () => completed.resolve());
				pi.registerTool({
					name: "hold",
					label: "Hold",
					description: "Hold the actual parent tool boundary",
					parameters: Type.Object({}),
					execute: async () => {
						held.resolve();
						await completed.promise;
						return { content: [{ type: "text", text: "child finished" }], details: undefined };
					},
				});
			},
		]);
		child.setResponses([
			async (ctx) => {
				await release.promise;
				return fauxAssistantMessage(
					`TOOLS ${getCurrentTools(ctx.messages)
						.map((t) => t.name)
						.join(",")}`,
				);
			},
		]);
		h.setResponses([
			agent(true),
			tool("hold", {}),
			fauxAssistantMessage("waiting"),
			fauxAssistantMessage("after notice"),
			complete(),
			fauxAssistantMessage("end"),
		]);
		await h.session.prompt("/goal watch the child --turns 10");
		const run = h.session.prompt("go");
		await held.promise;
		expect(nudges(h)).toEqual([]);
		release.resolve();
		await run;
		const messages = h.sessionManager.getBranch().filter((e) => e.type === "custom_message");
		const kinds = messages.map((e) => e.customType);
		expect(kinds.filter((k) => k === "subagent-notification")).toHaveLength(1);
		expect(kinds.indexOf("subagent-notification")).toBeLessThan(kinds.indexOf("session-kit:goal-nudge"));
		const notice = messages.find((e) => e.customType === "subagent-notification");
		expect(notice?.content).toContain("TOOLS ");
		expect(notice?.content).not.toContain("goal_update");
		expect(spoken(h)).toContain("after notice");
		expect(goalStates(h).at(-1)?.status).toBe("complete");
		expect(child.state.callCount).toBe(1);
		expect(h.getPendingResponseCount()).toBe(0);
	});
});
