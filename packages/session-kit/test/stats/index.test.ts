import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseColor } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import { register } from "../../src/stats/index.ts";
import { assistantLine, at, sessionFile } from "./fixtures.ts";

// biome-ignore lint/suspicious/noExplicitAny: fake pi/ctx surface
type Any = any;

let dir: string;
const saved = { agent: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-statscmd-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [
		["PI_CODING_AGENT_DIR", saved.agent],
		["PI_CODING_AGENT_SESSION_DIR", saved.sessions],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.restoreAllMocks();
});

function seed(): void {
	// Yesterday avoids accidentally creating future usage when run before 03:00.
	const day = new Date(Date.now() - 86400000);
	const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
	sessionFile(join(dir, "sessions", "--proj--", "a.jsonl"), {
		startMs: at(key, 1),
		lines: [
			assistantLine({
				ms: at(key, 2),
				provider: "anthropic",
				model: "claude-opus-5-5",
				input: 5,
				output: 500,
				cacheWrite: 20_000,
				cost: 0.3,
			}),
			assistantLine({
				ms: at(key, 3),
				provider: "openai-codex",
				model: "gpt-6.1-sol",
				input: 9000,
				output: 300,
				cost: 0.1,
			}),
		],
	});
}

function setup(mode: string) {
	let handler: Any;
	const sendMessage = vi.fn();
	register({ registerCommand: (_n: string, c: Any) => (handler = c.handler), sendMessage } as Any, defaultConfig());
	const rendered: string[][] = [];
	const custom = vi.fn(async (factory: Any) => {
		const view = factory(
			{ terminal: { rows: 40 }, requestRender() {} },
			{
				fg: (_c: string, s: string) => s,
				bg: (_c: string, s: string) => s,
				bold: (s: string) => s,
				style: (s: string) => s,
				colors: { accent: parseColor("#426a79") },
			},
			{},
			() => {},
		);
		rendered.push(view.render(100));
	});
	const ctx = { mode, cwd: dir, ui: { notify: vi.fn(), setStatus: vi.fn(), custom } };
	return { run: (args: string) => handler(args, ctx), ctx, custom, sendMessage, rendered };
}

describe("/stats command", () => {
	it("opens a full-screen overlay, shows loading status, clears it, and writes the cache", async () => {
		seed();
		const { run, ctx, custom, rendered } = setup("tui");
		await run("");
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("session-kit:stats", "stats: loading...");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("session-kit:stats", undefined);
		expect((custom.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%" },
		});
		expect(rendered[0]?.join("\n")).toMatch(/Favorite model +anthropic\/claude-opus-5-5/);
		expect(existsSync(join(dir, "pi-session-kit", "stats-cache.json"))).toBe(true);
	});

	it("honours PI_CODING_AGENT_SESSION_DIR", async () => {
		seed();
		process.env.PI_CODING_AGENT_SESSION_DIR = join(dir, "elsewhere");
		const { run, ctx, custom } = setup("tui");
		await run("");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"/stats: no usage recorded yet\n1 machine · local-only · never synced",
			"info",
		);
	});

	it("rejects arguments", async () => {
		const { run, ctx, custom } = setup("tui");
		await run("models");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("usage: /stats", "warning");
	});

	it("print mode writes the per-model table to stdout", async () => {
		seed();
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { run, ctx, custom } = setup("print");
		await run("");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		const text = String(out.mock.calls[0]?.[0]);
		expect(text).toMatch(/^\/stats: 30k tokens \(in \+ out \+ cache\), all time\n/);
		expect(text).toMatch(/anthropic +claude-opus-5-5 +5 +500 +0 +20k +\$0\.30 +68\.8%/);
		expect(text).toMatch(/openai-codex +gpt-6\.1-sol +9k +300/);
	});

	it("json mode adds one display message", async () => {
		seed();
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { run, sendMessage } = setup("json");
		await run("");
		expect(out).not.toHaveBeenCalled();
		const [message, options] = sendMessage.mock.calls[0] as [Any, Any];
		expect(message).toMatchObject({ customType: "session-kit:stats", display: true });
		expect(message.content).toContain("gpt-6.1-sol");
		expect(options).toEqual({ triggerTurn: false });
	});

	it("reports unreadable lines in print mode and before an empty-history notice", async () => {
		seed();
		const file = join(dir, "sessions", "--proj--", "broken.jsonl");
		sessionFile(file, { startMs: at("2026-01-01"), lines: ['{"type":"message","message":{"role":"assistant"'] });
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print").run("");
		expect(String(out.mock.calls[0]?.[0])).toContain("/stats: ! 1 unreadable lines");

		rmSync(join(dir, "sessions", "--proj--", "a.jsonl"));
		rmSync(join(dir, "pi-session-kit"), { recursive: true });
		const { run, ctx, custom } = setup("tui");
		await run("");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("/stats: ! 1 unreadable lines", "warning");
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			"/stats: no usage recorded yet\nincomplete coverage · 1 machine · local-only · never synced",
			"info",
		);
	});

	it("rpc mode notifies, and an empty history says so", async () => {
		const { run, ctx } = setup("rpc");
		await run("");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"/stats: no usage recorded yet\n1 machine · local-only · never synced",
			"info",
		);
	});
});
