/** A held real child stays visible across raw Plan commands on the interactive host. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { expect, it } from "vitest";
import { deferred, GoalStack, nextEvent, outcomes, tool } from "./goal-support.ts";
import { loadFork } from "./support.ts";

const MAIN = /^\s+[●○] main\s*$/m;
const CHILD = /^\s+[●○] general-purpose\s+probe child/m;

/** Dispatch through the actual editor, awaiting command completion and the renderer. */
async function command(host: InteractiveHarness, text: string): Promise<void> {
	host.input(text);
	host.input("\r");
	await host.settle();
}

/** Persisted production state proves the command ran, not just an old transcript mention. */
function planEnabled(host: InteractiveHarness): boolean | undefined {
	const states = host.harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "plan-mode-state"
				? [(entry.data as { enabled: boolean }).enabled]
				: [],
		);
	return states.at(-1);
}

it("Plan round trip preserves running fleet", async () => {
	const stack = await GoalStack.create();
	let host: InteractiveHarness | undefined;
	const entered = deferred<void>();
	const release = deferred<void>();
	const completed = deferred<void>();
	const admission = deferred<void>();
	let childEntered = false;
	let childCompleted = false;
	try {
		const agentDir = join(stack.home.root, "agent");
		const agents = join(agentDir, "agents");
		const cwd = join(stack.home.root, "work");
		mkdirSync(agents, { recursive: true });
		mkdirSync(cwd);
		writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ rememberAgents: false, widgetMode: "off" }));
		// The frozen scenario used a named general-purpose definition, not upstream's "Agent" display alias.
		writeFileSync(
			join(agents, "general-purpose.md"),
			"---\nname: general-purpose\ndescription: General-purpose fixture\n---\nDo the requested work.\n",
		);
		const [child] = stack.registerPhysical([{ provider: "fauxchild", id: "child" }]);
		if (!child) throw new Error("Missing child provider");
		child.setResponses([
			async () => {
				childEntered = true;
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("CHILD DONE");
			},
		]);
		const observe: ExtensionFactory = (pi) => {
			pi.events.on("router:rpc:admit", () => admission.resolve());
			pi.events.on("subagents:completed", () => {
				childCompleted = true;
				completed.resolve();
			});
		};
		host = await createInteractiveHarness({
			cwd,
			columns: 160,
			rows: 40,
			withConfiguredAuth: true,
			useModelRuntimeStream: true,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [await stack.subagents(), await loadFork("pi-plan-mode"), observe],
		});
		const h = host.harness;
		const model = child.getModel();
		h.session.modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux",
			api: child.api,
			models: child.models,
		});
		h.setResponses([
			tool("Agent", {
				subagent_type: "general-purpose",
				description: "probe child",
				prompt: "work",
				run_in_background: true,
				model: "fauxchild/child",
			}),
			fauxAssistantMessage("SPAWNED"),
		]);
		const settled = nextEvent(h, "agent_settled");
		host.input("go");
		host.input("\r");
		await admission.promise;
		// No router is installed. Run the production fail-open callback on the ONE injected clock.
		stack.clock.advance(100);
		await entered.promise;
		await settled;
		await h.session.waitForIdle();
		stack.clock.advance(200);
		await host.settle();
		expect(outcomes(h, "Agent").map((result) => result.isError)).toEqual([false]);
		expect(host.viewport().join("\n")).toContain("agents: 1 running");
		host.input("\x1b[97;6u"); // explicitly expand; plan-mode disposal must preserve this choice
		await host.settle();
		const before = host.viewport().join("\n");
		expect(before).toContain("SPAWNED");
		expect(before).toMatch(CHILD);
		expect(before).toMatch(MAIN);

		await command(host, "/plan start");
		expect(host.viewport().join("\n")).toMatch(/plan/i);
		expect(planEnabled(host)).toBe(true);
		await command(host, "/plan exit");
		expect(planEnabled(host)).toBe(false);
		stack.clock.advance(200);
		await host.settle();
		expect(host.viewport().join("\n")).toMatch(CHILD);
		expect(host.viewport().join("\n")).toMatch(MAIN);
		expect(childCompleted).toBe(false);
		expect(child.state.callCount).toBe(1);
		expect(h.getPendingResponseCount()).toBe(0);
	} finally {
		release.resolve();
		if (childEntered) await completed.promise;
		try {
			await host?.dispose();
		} finally {
			await stack.cleanup();
		}
	}
});
