/** Real core, todo and child renderers composed on an interactive VirtualTerminal. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createCodingTools,
	createFindTool,
	createGrepTool,
	createLsTool,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { deferred, GoalStack, nextEvent, outcomes, tool } from "./goal-support.ts";
import { loadFork } from "./support.ts";

let stack: GoalStack;
let host: InteractiveHarness;
const releases: (() => void)[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await host?.dispose();
	await stack?.cleanup();
});
const RULE = /^┄{20,}$/;
const FINAL = "ALL ROWS DONE";

/** Restrict the oracle to actual transcript content, never the todo widget/editor/footer. */
function region(): { rows: string[]; start: number; end: number } {
	const rows = host.viewport();
	const start = rows.findIndex((row) => /^\s*go\s*$/.test(row)) + 1;
	const end =
		(rows.flatMap((row, index) => (/^│ (ALL ROWS DONE|DONE)$/.test(row.trim()) ? [index] : [])).at(-1) ?? -1) + 1;
	expect(start, rows.join("\n")).toBeGreaterThan(0);
	expect(end, rows.join("\n")).toBeGreaterThan(start);
	return { rows, start, end };
}

/** Preserve the live generic oracle: no expanded default, output spill or unexpected unmarked row. */
function oneLine(): { row: number; key: string }[] {
	const { rows, start, end } = region();
	const entries = [];
	for (let index = start; index < end; index++) {
		const row = rows[index] ?? "";
		if (!row.trim() || RULE.test(row.trim())) continue;
		expect(row, rows.join("\n")).not.toMatch(/^▾ /);
		const flat = row.startsWith("  ") && (index === start || RULE.test(rows[index - 1]?.trim() ?? ""));
		if (row.startsWith("▸ ") || flat) {
			const follower = rows[index + 1] ?? "";
			if (index + 1 < end && follower.trim()) expect(follower, row).toMatch(/^(?:▸ |▾ |\s*┄{20,}$)/);
			if (row.startsWith("▸ ")) entries.push({ row: index, key: key(row) });
		} else expect(row.trim(), rows.join("\n")).toMatch(/^│ (ALL ROWS DONE|DONE)$/);
	}
	return entries;
}

/** Stable call prefix survives renderer-specific expanded call formatting. */
function key(row: string): string {
	return row.slice(2).trim().split(" · ")[0]?.slice(0, 24).trim() ?? "";
}

/** Raw SGR click uses the production mouse dispatch and component hit testing. */
async function click(row: number): Promise<void> {
	host.input(`\x1b[<0;7;${row + 1}M`);
	host.input(`\x1b[<0;7;${row + 1}m`);
	await host.settle();
}

/** Input is real editor input, with completion fenced by the actual settled event. */
async function run(h: Harness): Promise<void> {
	const settled = nextEvent(h, "agent_settled");
	host.input("go");
	host.input("\r");
	await settled;
	await h.session.waitForIdle();
	await host.settle();
}

/** All fixtures and fork clocks belong to this test; no installed package/config discovery. */
async function start(columns: number, rows: number, factories: ExtensionFactory[] = []): Promise<Harness> {
	const cwd = join(stack.home.root, "repo");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "notes.txt"), "alpha\nbeta\n");
	host = await createInteractiveHarness({
		cwd,
		columns,
		rows,
		withConfiguredAuth: true,
		useModelRuntimeStream: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		tools: [...createCodingTools(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)],
		extensionFactories: factories,
	});
	return host.harness;
}

/** Four original built-ins, with exact live summary/entry-rule assertions at BOTH source sizes. */
function builtins() {
	return [
		tool("bash", { command: "printf 'a\\nb\\nc\\n'" }),
		tool("read", { path: "notes.txt" }),
		tool("edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "gamma" }] }),
		tool("write", { path: "new.txt", content: "one\ntwo\n" }),
	];
}

it.each([
	[120, 40],
	[80, 24],
])("built-in summaries and entry rules fit %ix%i", async (columns, rows) => {
	stack = await GoalStack.create();
	const h = await start(columns, rows);
	h.setResponses([...builtins(), fauxAssistantMessage(FINAL)]);
	await run(h);
	const screen = host.viewport();
	for (const pattern of [
		/^▸ +\$ printf .*· 3 lines output/,
		/^▸ +read notes\.txt/,
		/^▸ +edit notes\.txt · \+1 -1/,
		/^▸ +write new\.txt · 2 lines/,
	]) {
		const index = screen.findIndex((row) => pattern.test(row));
		expect(index, screen.join("\n")).toBeGreaterThanOrEqual(0);
		expect(screen[index + 1]?.trim()).toMatch(RULE);
		expect(visibleWidth(screen[index] ?? "")).toBeLessThanOrEqual(columns);
	}
	expect(screen.join("\n")).not.toMatch(/^\s*alpha\s*$/m);
});

it("all real stack entries settle into one expandable row", async () => {
	stack = await GoalStack.create();
	const [child] = stack.registerPhysical([{ provider: "kid", id: "child" }]);
	if (!child) throw new Error("Missing child provider");
	const fetched = deferred<void>();
	const notified = deferred<void>();
	const completed = deferred<void>();
	releases.push(
		() => fetched.resolve(),
		() => notified.resolve(),
	);
	const observe: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName === "get_subagent_result") fetched.resolve();
		});
		pi.events.on("subagents:completed", (event) => {
			if ((event as { description?: string }).description === "notified child") completed.resolve();
		});
	};
	const h = await start(140, 90, [
		await stack.subagents(),
		stack.router([{ provider: "kid", id: "child" }]),
		await loadFork("rpiv-todo"),
		observe,
	]);
	const model = child.getModel();
	h.session.modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux",
		api: child.api,
		models: child.models,
	});
	child.setResponses([
		fauxAssistantMessage("FOREGROUND CHILD DONE"),
		async () => {
			await fetched.promise;
			return fauxAssistantMessage("FETCHED CHILD DONE");
		},
		async () => {
			await notified.promise;
			return fauxAssistantMessage("NOTIFIED CHILD DONE");
		},
	]);
	const agent = (description: string, background: boolean) =>
		tool("Agent", {
			subagent_type: "general-purpose",
			description,
			prompt: "work",
			model: "kid/child",
			run_in_background: background,
		});
	h.setResponses([
		...builtins().slice(0, 1),
		tool("bash", { command: "echo boom >&2; exit 3" }),
		...builtins().slice(1),
		tool("grep", { pattern: "alpha", path: "." }),
		tool("find", { pattern: "*.txt" }),
		tool("ls", { path: "." }),
		tool("todo", { action: "create", subject: "Check every row" }),
		tool("no_such_tool", { anything: 1 }),
		agent("foreground child", false),
		agent("fetched child", true),
		() => {
			const result = h
				.eventsOfType("tool_execution_end")
				.filter((event) => event.toolName === "Agent")
				.at(-1)?.result as { details?: { agentId?: string } } | undefined;
			if (!result?.details?.agentId) throw new Error("Missing background ID");
			return tool("get_subagent_result", { agent_id: result.details.agentId, wait: true });
		},
		agent("notified child", true),
		async () => {
			notified.resolve();
			await completed.promise;
			return fauxAssistantMessage(FINAL);
		},
		fauxAssistantMessage("DONE"),
	]);
	await run(h);
	const screen = host.viewport().join("\n");
	for (const expected of ["$ printf", "read notes.txt", "edit notes.txt", "write new.txt", "no_such_tool"])
		expect(screen).toContain(expected);
	expect(screen.match(/notified child/g)?.length, screen).toBeGreaterThanOrEqual(2);
	for (const name of ["read", "edit", "write", "grep", "find", "ls", "todo", "Agent", "get_subagent_result"]) {
		const results = outcomes(h, name);
		expect(results.length, name).toBeGreaterThan(0);
		expect(
			results.every((result) => !result.isError),
			results.map((result) => result.text).join("\n"),
		).toBe(true);
	}
	expect(outcomes(h, "bash").map((result) => result.isError)).toEqual([false, true]);
	const entries = oneLine();
	expect(entries.length).toBeGreaterThan(10);
	for (const [occurrence, entry] of entries.entries()) {
		const row = oneLine()[occurrence]?.row;
		if (row === undefined) throw new Error(`Missing ${entry.key}`);
		await click(row);
		const expanded = region();
		const headers = expanded.rows
			.slice(expanded.start, expanded.end)
			.flatMap((text, i) => (text.startsWith("▾ ") ? [i + expanded.start] : []));
		expect(headers, expanded.rows.join("\n")).toHaveLength(1);
		const header = headers[0];
		if (header === undefined) throw new Error("Missing expanded header");
		const expandedKey = key(expanded.rows[header] ?? "");
		expect(entry.key.startsWith(expandedKey) || expandedKey.startsWith(entry.key)).toBe(true);
		await click(header);
		const collapsed = region();
		expect(
			collapsed.rows.slice(collapsed.start, collapsed.end).some((text) => text.startsWith("▾ ")),
			`${entry.key}\n${collapsed.rows.join("\n")}`,
		).toBe(false);
	}
});
