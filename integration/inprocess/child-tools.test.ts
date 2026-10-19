/** A real child cannot regain parent capabilities via search, registry reset or undeclared calls. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { ControlledProcesses, configFor, FakeClock } from "../../packages/session-kit/test/scenarios/support.ts";
import { agentStack, ask, call, closeAgentStack, jsonFile, listTools, ROOT } from "./agents-support.ts";
import childProbe from "./fixtures/child-probe.ts";
import { OPTIONS } from "./fixtures/pi-session-kit/index.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

const TOOLS = ["monitor_start", "monitor_read", "monitor_stop"];

it.each([false, true])(
	"children cannot regain monitor tools in either factory order: kitFirst=%s",
	async (kitFirst) => {
		const home = isolateStackHome();
		const clock = new FakeClock();
		const processes = new ControlledProcesses(clock);
		const kitOptions = {
			config: configFor("goal", "monitor"),
			clock,
			spawnMonitor: processes.spawn,
			agentDir: join(home.root, "agent"),
			monitorRoot: join(home.root, "monitors"),
		};
		(globalThis as Record<symbol, unknown>)[OPTIONS] = kitOptions;
		const kit = createSessionKit(kitOptions);
		const kitPackage = fileURLToPath(new URL("fixtures/pi-session-kit", import.meta.url));
		const subagentsPackage = join(ROOT, "forks/pi-subagents");
		const packages = kitFirst ? [kitPackage, subagentsPackage] : [subagentsPackage, kitPackage];
		jsonFile(join(home.root, "agent/deferred-tools.json"), {
			alwaysActive: ["Agent", "session_kit_child_scope_probe", "monitor_read"],
			neverDefer: ["Agent", "session_kit_child_scope_probe", "monitor_read"],
		});
		jsonFile(join(home.root, "agent/settings.json"), {});
		const h = await agentStack(home.root, {
			first: kitFirst ? [kit] : [],
			factories: [...(kitFirst ? [] : [kit]), childProbe, await loadThirdParty("deferred")],
			packages: [...packages, fileURLToPath(new URL("./", import.meta.resolve("pi-deferred-context-engine")))],
		});
		// The child runner discovers extensions from explicit fixture settings, not the parent's in-memory loader.
		jsonFile(join(home.root, "agent/settings.json"), {
			packages: [
				join(ROOT, "packages/preset"),
				...packages,
				fileURLToPath(new URL("./", import.meta.resolve("pi-deferred-context-engine"))),
			],
			extensions: [fileURLToPath(new URL("fixtures/child-probe.ts", import.meta.url))],
		});
		try {
			h.setResponses([call("search_tools", { query: "background monitor", kind: "tool" }), listTools]);
			await h.session.prompt("promote and list");
			const parent = h.session.messages
				.filter((m) => m.role === "assistant")
				.flatMap((m) => ("content" in m ? m.content : []));
			const parentText = JSON.stringify(parent);
			for (const tool of TOOLS) expect(parentText).toContain(tool);
			const answer = await ask(h, "general-purpose", [
				call("session_kit_child_scope_probe", {}),
				call("search_tools", { query: "background monitor", kind: "tool" }),
				call("monitor_read", { id: "parent" }),
				call("monitor_start", { argv: ["/bin/echo", "CHILD MUST NOT SPAWN"], name: "child" }),
				call("monitor_stop", { id: "parent" }),
				listTools,
			]);
			expect(answer).toContain("TOOLS ");
			for (const name of [...TOOLS, "goal_update"]) expect(answer).not.toContain(name);
			const snapshot = JSON.parse(readFileSync(join(home.root, "child-scope.json"), "utf8")) as {
				name: string;
				tools: { name: string; exposure: string; source?: unknown }[];
				active: string[];
			};
			expect(snapshot.name).toMatch(/^general-purpose#/);
			expect(snapshot.tools.map((t) => t.name).sort()).toEqual([...TOOLS, "goal_update"].sort());
			for (const tool of snapshot.tools) {
				expect(tool.exposure).toBe("hidden");
				expect(snapshot.active).not.toContain(tool.name);
			}
			expect(JSON.stringify(snapshot.tools)).toContain(kitPackage);
			const denied = readFileSync(join(home.root, "child-calls.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line): { name: string; isError: boolean; result: unknown } => JSON.parse(line));
			expect(denied.map((d) => d.name).sort()).toEqual([...TOOLS].sort());
			for (const entry of denied) {
				expect(entry.isError).toBe(true);
				expect(JSON.stringify(entry.result)).toMatch(/not available|not found/);
			}
			expect(processes.calls).toEqual([]);
		} finally {
			await closeAgentStack(h);
			delete (globalThis as Record<symbol, unknown>)[OPTIONS];
			home.cleanup();
		}
	},
);
