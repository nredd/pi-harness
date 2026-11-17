import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import childScopeProbe from "./session-kit-child-scope.ts";

type Handler = (event: unknown, ctx: { cwd: string }) => void;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Register the probe against a recording API in a private cwd. */
function harness(sessionName: string | undefined) {
	const cwd = mkdtempSync(join(tmpdir(), "child-scope-probe-"));
	roots.push(cwd);
	const handlers = new Map<string, Handler>();
	const tools: ToolDefinition[] = [];
	const all = ["read", "goal_update", "monitor_start", "monitor_read", "monitor_stop"].map(
		(name) => ({ name, description: name }) as ToolInfo,
	);
	let active = ["read"];
	const activations: string[][] = [];
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		getSessionName: () => sessionName,
		getAllTools: () => all,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			activations.push(names);
			active = names;
		},
	} as unknown as ExtensionAPI;
	childScopeProbe(api);
	const end = (toolName: string) =>
		handlers.get("tool_execution_end")?.({ toolName, isError: false, result: { ok: toolName } }, { cwd });
	return { cwd, tools, activations, end };
}

test("records only a general-purpose child's monitor tool results", () => {
	const { cwd, end } = harness("general-purpose#2");
	const calls = join(cwd, "session-kit-child-calls.jsonl");
	end("read");
	assert.equal(existsSync(calls), false);
	end("monitor_start");
	end("monitor_read");
	assert.deepEqual(
		readFileSync(calls, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
		[
			{ name: "monitor_start", isError: false, result: { ok: "monitor_start" } },
			{ name: "monitor_read", isError: false, result: { ok: "monitor_read" } },
		],
	);
});

test("ignores monitor results from a parent or an unnamed session", () => {
	for (const name of ["reviewer#1", undefined]) {
		const { cwd, end } = harness(name);
		end("monitor_start");
		assert.equal(existsSync(join(cwd, "session-kit-child-calls.jsonl")), false);
	}
});

test("the probe tool activates every registry tool and records what the child could reach", async () => {
	const { cwd, tools, activations } = harness("general-purpose#1");
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["session_kit_child_scope_probe"],
	);
	const [tool] = tools;
	assert.ok(tool);
	const result = await tool.execute("call-1", {}, undefined, undefined, { cwd } as never);
	const everything = ["read", "goal_update", "monitor_start", "monitor_read", "monitor_stop"];
	assert.deepEqual(activations, [everything]);
	const recorded = {
		name: "general-purpose#1",
		tools: everything.slice(1).map((name) => ({ name, description: name })),
		active: everything,
	};
	assert.deepEqual(JSON.parse(readFileSync(join(cwd, "session-kit-child-scope.json"), "utf8")), recorded);
	assert.deepEqual(result, { content: [{ type: "text", text: "Recorded child scope" }], details: recorded });
});
