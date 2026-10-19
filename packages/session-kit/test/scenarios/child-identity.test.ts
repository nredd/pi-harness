import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createTestExtensionsResult,
	createTestResourceLoader,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createSessionKit } from "../../src/index.ts";
import { configFor, ScenarioFixture, sessionFile, tool } from "./support.ts";

const NAMES = ["goal_update", "monitor_start", "monitor_read", "monitor_stop"];
interface Report {
	name: string | undefined;
	active: string[];
	tools: { name: string; hidden: boolean; denied: boolean }[];
}
let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

for (const child of [true, false]) {
	it(`rename and rebind preserve child restrictions only for children (${child ? "child" : "parent"})`, async () => {
		fixture = new ScenarioFixture();
		const root = fixture.root;
		let loads = 0;
		const factory: ExtensionFactory = (pi) => {
			loads++;
			const tools = new Map<string, ToolDefinition>();
			const register = pi.registerTool.bind(pi);
			pi.registerTool = (definition) => {
				// Direct calls deliberately bypass schema validation; only execute guards are probed.
				tools.set(definition.name, definition as unknown as ToolDefinition);
				register(definition);
			};
			pi.on("session_start", (_event, ctx) => {
				if (
					ctx.sessionManager
						.getBranch()
						.some((entry) => entry.type === "custom" && entry.customType === "harness:identity-start")
				)
					return;
				pi.setSessionName(child ? "general-purpose#deadbeef" : "ordinary parent");
				pi.appendEntry("harness:identity-start", {});
			});
			createSessionKit({
				config: configFor("goal", "monitor"),
				agentDir: join(root, "agent"),
				monitorRoot: join(root, "monitors"),
			})(pi);
			pi.registerCommand("kit-rename", { handler: async () => pi.setSessionName("renamed session") });
			// A real tool context lets the probe bypass registry execution and exercise execute guards too.
			pi.registerTool({
				name: "kit_probe",
				label: "Identity probe",
				description: "Probe parent tools",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _update, ctx) {
					pi.setActiveTools([...pi.getActiveTools(), ...NAMES]);
					const report: Report = { name: pi.getSessionName(), active: pi.getActiveTools(), tools: [] };
					for (const name of NAMES) {
						const definition = tools.get(name);
						if (!definition) throw new Error(`Missing tool ${name}`);
						let denied = false;
						try {
							await definition.execute("probe", { id: "missing", argv: [], name: "probe" }, undefined, undefined, ctx);
						} catch (error) {
							denied = String(error).includes("not available in subagents");
							if (!denied && !(name === "goal_update" && String(error).includes("no active goal"))) throw error;
						}
						report.tools.push({ name, hidden: definition.exposure === "hidden", denied });
					}
					pi.appendEntry("harness:identity-probe", report);
					return { content: [{ type: "text", text: "probed" }], details: {} };
				},
			});
		};
		let result = await createTestExtensionsResult([factory], root);
		// The test loader's default reload is a no-op. Recreate factories just as DefaultResourceLoader does.
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => result,
			reload: async () => {
				result = await createTestExtensionsResult([factory], root);
			},
		};
		const harness = await fixture.start(configFor(), { resourceLoader: loader, extensionFactories: undefined });
		harness.setResponses([tool("kit_probe", {}), fauxAssistantMessage("first")]);
		await harness.session.prompt("probe");
		await harness.session.prompt("/kit-rename");
		await harness.session.reload();
		expect(loads).toBe(2);
		// reload clears API registrations; a real loader would also reload the faux-provider extension.
		const reloadedProvider = registerFauxProvider({ api: harness.getModel().api });
		try {
			reloadedProvider.setResponses([tool("kit_probe", {}), fauxAssistantMessage("finished")]);
			await harness.session.prompt("probe again");
		} finally {
			reloadedProvider.unregister();
		}
		const reports = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === "harness:identity-probe" ? [entry.data as Report] : [],
			);
		expect(reports).toHaveLength(2);
		expect(reports[1]?.name).toBe("renamed session");
		for (const report of reports) {
			expect(report.tools).toHaveLength(4);
			for (const probe of report.tools) {
				expect(probe.hidden, probe.name).toBe(child);
				expect(probe.denied, probe.name).toBe(child);
				expect(report.active.includes(probe.name), probe.name).toBe(!child);
			}
		}
		const markers = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "session-kit:child");
		expect(markers).toHaveLength(child ? 1 : 0);
		const disk = readFileSync(sessionFile(harness), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(disk.filter((entry) => entry.customType === "session-kit:child")).toHaveLength(child ? 1 : 0);
		expect(harness.eventsOfType("tool_execution_end").every((event) => !event.isError)).toBe(true);
	});
}
