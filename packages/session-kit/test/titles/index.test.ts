import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import { register } from "../../src/titles/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Setup {
	mode?: string;
	name?: string;
	sessionFile?: string | undefined;
	branch?: unknown[];
	reply?: { stopReason: string; content: unknown };
	available?: string[];
	/** Mutable so a test can change what resolves between attempts. */
	availableRef?: { current: string[] };
	titleModel?: string;
}

const USER_ENTRY = { type: "message", message: { role: "user", content: "fix the login bug" } };
const ASSISTANT_ENTRY = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } };

let agentDir: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(path.join(tmpdir(), "kit-titles-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function writeManifest(manifest: unknown, mode = 0o600): void {
	const file = path.join(agentDir, "enterprise.local.json");
	writeFileSync(file, JSON.stringify(manifest), { mode });
	chmodSync(file, mode);
}

function setup(options: Setup = {}) {
	const handlers = new Map<string, Handler>();
	let name = options.name;
	const setSessionName = vi.fn((n: string) => {
		name = n;
	});
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getSessionName: () => name,
		setSessionName,
	};
	const available = options.availableRef ?? { current: options.available ?? ["anthropic/claude-haiku-5-5"] };
	const streamSimple = vi.fn((..._args: unknown[]) => ({
		result: async () => options.reply ?? { stopReason: "stop", content: [{ type: "text", text: '"Fix Login Bug."' }] },
	}));
	const ctx = {
		mode: options.mode ?? "tui",
		sessionManager: {
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/tmp/s.jsonl"),
			getBranch: () => options.branch ?? [USER_ENTRY, ASSISTANT_ENTRY],
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				available.current.includes(`${provider}/${id}`) ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
			streamSimple,
		},
	};
	register(pi as never, { ...defaultConfig(), titleModel: options.titleModel });
	return {
		pi,
		ctx,
		setSessionName,
		streamSimple,
		start: () => handlers.get("session_start")?.({}, ctx),
		end: () => handlers.get("agent_end")?.({ messages: [] }, ctx) as Promise<void>,
	};
}

describe("titles agent_end", () => {
	it("names an unnamed TUI session once", async () => {
		const t = setup();
		await t.end();
		await t.end();
		expect(t.setSessionName).toHaveBeenCalledExactlyOnceWith("Fix Login Bug");
		expect(t.streamSimple).toHaveBeenCalledTimes(1);
	});

	it.each(["print", "json", "rpc"])("skips %s mode", async (mode) => {
		const t = setup({ mode });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
	});

	it("never overwrites an existing name", async () => {
		const t = setup({ name: "mine" });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
		expect(t.setSessionName).not.toHaveBeenCalled();
	});

	it("skips --no-session", async () => {
		const t = setup({ sessionFile: undefined });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
	});

	it("skips subagent child sessions", async () => {
		const t = setup({ name: "Explore#1a2b3c4d" });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
	});

	it("skips while plan mode is active, then names after it ends", async () => {
		const plan = (enabled: boolean) => ({ type: "custom", customType: "plan-mode-state", data: { enabled } });
		const branch: unknown[] = [USER_ENTRY, ASSISTANT_ENTRY, plan(true)];
		const t = setup({ branch });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
		branch.push(plan(false));
		await t.end();
		expect(t.setSessionName).toHaveBeenCalledWith("Fix Login Bug");
	});

	it("is silent and does not retry when no model resolves", async () => {
		const t = setup({ available: [] });
		await t.end();
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
		expect(t.setSessionName).not.toHaveBeenCalled();
	});

	it("prefers titleModel, else falls back to the second default", async () => {
		const t = setup({ titleModel: "work/small", available: ["work/small", "openai-codex/gpt-6-luna"] });
		await t.end();
		expect(t.streamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: "work", id: "small" });
		const u = setup({ available: ["openai-codex/gpt-6-luna"] });
		await u.end();
		expect(u.streamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: "openai-codex" });
	});

	it("ignores an errored reply and tries only once", async () => {
		const t = setup({ reply: { stopReason: "error", content: [] } });
		await t.end();
		await t.end();
		expect(t.streamSimple).toHaveBeenCalledTimes(1);
		expect(t.setSessionName).not.toHaveBeenCalled();
	});

	it("does not name when the user named the session during the call", async () => {
		const t = setup();
		const pending = t.end();
		(t.pi as { getSessionName: () => string | undefined }).getSessionName = () => "manual";
		await pending;
		expect(t.setSessionName).not.toHaveBeenCalled();
	});

	it("resolves through machine-local aliases, haiku-5-5 first", async () => {
		writeManifest({
			version: 1,
			subagents: { modelAliases: { "claude-haiku-4-5": ["corp/h45"], "claude-haiku-5-5": ["corp/h55"] } },
		});
		const t = setup({ available: ["corp/h45", "corp/h55", "openai-codex/gpt-6-luna"] });
		await t.end();
		expect(t.streamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: "corp", id: "h55" });
	});

	it("falls to the next alias when the first is unavailable", async () => {
		writeManifest({
			version: 1,
			subagents: { modelAliases: { "claude-haiku-4-5": ["corp/h45"], "claude-haiku-5-5": ["corp/h55"] } },
		});
		const t = setup({ available: ["corp/h45"] });
		await t.end();
		expect(t.streamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: "corp", id: "h45" });
	});

	it("ignores aliases from a manifest with loose permissions", async () => {
		writeManifest({ version: 1, subagents: { modelAliases: { "claude-haiku-5-5": ["corp/h55"] } } }, 0o644);
		const t = setup({ available: ["corp/h55"] });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
	});

	it("ignores a malformed manifest silently", async () => {
		writeFileSync(path.join(agentDir, "enterprise.local.json"), "{nope", { mode: 0o600 });
		const t = setup({ available: ["openai-codex/gpt-6-luna"] });
		await t.end();
		expect(t.streamSimple.mock.calls[0]?.[0]).toMatchObject({ provider: "openai-codex" });
	});

	it("allows a fresh attempt after session_start", async () => {
		const available = { current: [] as string[] };
		const t = setup({ availableRef: available });
		await t.end();
		expect(t.streamSimple).not.toHaveBeenCalled();
		available.current = ["anthropic/claude-haiku-5-5"];
		t.start();
		await t.end();
		expect(t.streamSimple).toHaveBeenCalledTimes(1);
		expect(t.setSessionName).toHaveBeenCalledWith("Fix Login Bug");
	});
});
