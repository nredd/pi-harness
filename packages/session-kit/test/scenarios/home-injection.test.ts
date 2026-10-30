import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionKit } from "../../src/index.ts";
import { assistantLine } from "../stats/fixtures.ts";

type Handler = (event: unknown, context: unknown) => unknown;

interface Probe {
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, context: unknown) => unknown }>;
	entries: unknown[];
	messages: unknown[];
	pi: object;
}

function probe(): Probe {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
	const entries: unknown[] = [];
	const messages: unknown[] = [];
	let name: string | undefined;
	return {
		handlers,
		commands,
		entries,
		messages,
		pi: {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerCommand: (command: string, definition: { handler: (args: string, context: unknown) => unknown }) =>
				commands.set(command, definition),
			appendEntry: (_type: string, entry: unknown) => entries.push(entry),
			sendMessage: (message: unknown) => messages.push(message),
			getSessionName: () => name,
			setSessionName: (next: string) => {
				name = next;
			},
		},
	};
}

function homeWith(feature: string): { home: string; agent: string } {
	const home = mkdtempSync(join(tmpdir(), "pi-session-kit-injected-home-"));
	const agent = join(home, ".pi", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(
		join(agent, "pi-session-kit.json"),
		JSON.stringify({
			titles: { enabled: feature === "titles" },
			rules: { enabled: feature === "rules" },
			goal: { enabled: false },
			loop: { enabled: false },
			monitor: { enabled: false },
			diff: { enabled: false },
			stats: { enabled: feature === "stats" },
			mon: { enabled: false },
		}),
	);
	return { home, agent };
}

const homes: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it("factory loads its config from the injected home", () => {
	const { home } = homeWith("none");
	homes.push(home);
	const current = probe();
	createSessionKit({ homeDir: home })(current.pi as never);
	expect(current.handlers).toEqual(new Map());
	expect(current.commands).toEqual(new Map());
});

it("factory forwards the injected home to title aliases", async () => {
	const { home, agent } = homeWith("titles");
	homes.push(home);
	writeFileSync(
		join(agent, "enterprise.local.json"),
		JSON.stringify({ version: 1, subagents: { modelAliases: { "claude-haiku-5-5": ["isolated/title"] } } }),
		{ mode: 0o600 },
	);
	const current = probe();
	createSessionKit({ homeDir: home })(current.pi as never);
	const streamSimple = vi.fn(() => ({
		result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Isolated Title" }] }),
	}));
	await current.handlers.get("agent_end")?.(
		{},
		{
			mode: "tui",
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "name this" } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
				],
			},
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "isolated" && id === "title" ? { provider, id } : undefined,
				hasConfiguredAuth: () => true,
				streamSimple,
			},
		},
	);
	expect(streamSimple).toHaveBeenCalledOnce();
});

it("factory forwards the injected home to user rules and tilde paths", () => {
	const { home, agent } = homeWith("rules");
	homes.push(home);
	const rules = join(agent, "rules");
	mkdirSync(rules, { recursive: true });
	writeFileSync(join(rules, "isolated.md"), "---\npaths: src/**\n---\nISOLATED RULE\n");
	const current = probe();
	createSessionKit({ homeDir: home })(current.pi as never);
	const result = current.handlers.get("tool_result")?.(
		{
			toolName: "read",
			input: { path: "~/src/file.ts" },
			content: [{ type: "text", text: "original" }],
			isError: false,
		},
		{ cwd: home, sessionManager: { getBranch: () => [] } },
	) as { content?: { text: string }[] } | undefined;
	expect(result?.content?.[1]?.text).toContain("ISOLATED RULE");
});

it("factory forwards the injected home to stats session and cache loading", async () => {
	const { home, agent } = homeWith("stats");
	homes.push(home);
	const sessions = join(agent, "sessions");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(
		join(sessions, "isolated.jsonl"),
		[
			JSON.stringify({ type: "session", timestamp: "2026-10-01T00:00:00.000Z" }),
			assistantLine({ ms: Date.parse("2026-10-01T12:00:00.000Z"), provider: "isolated", model: "stats", input: 123 }),
		].join("\n"),
	);
	const current = probe();
	createSessionKit({ homeDir: home })(current.pi as never);
	await current.commands.get("stats")?.handler("", { mode: "json", ui: { notify: vi.fn(), setStatus: vi.fn() } });
	expect(current.messages).toEqual([expect.objectContaining({ content: expect.stringContaining("123") })]);
});
