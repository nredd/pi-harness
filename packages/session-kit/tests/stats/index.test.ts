import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseColor } from "@earendil-works/pi-tui";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realClock } from "../../src/clock.ts";
import { defaultConfig } from "../../src/config.ts";
import { register } from "../../src/stats/index.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";
import { codexMeta, codexTokenCount, limits, writeLines } from "../fixtures/stats/harness/fixtures.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

// biome-ignore lint/suspicious/noExplicitAny: fake pi/ctx surface
type Any = any;

let dir: string;
const saved = { agent: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };

beforeEach(({ onTestFinished }) => {
	dir = makeTestTempDir("psk-statscmd-", onTestFinished);
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
});
afterEach(() => {
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

function setup(mode: string, options: Parameters<typeof register>[2] = { homeDir: join(dir, "home") }) {
	let handler: Any;
	const sendMessage = vi.fn();
	register(
		{ registerCommand: (_n: string, c: Any) => (handler = c.handler), sendMessage } as Any,
		defaultConfig(),
		options,
	);
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
	const ctx = {
		mode,
		cwd: dir,
		modelRegistry: { getAll: vi.fn(() => []) },
		ui: { notify: vi.fn(), setStatus: vi.fn(), custom },
	};
	return { run: (args: string) => handler(args, ctx), ctx, custom, sendMessage, rendered };
}

function seedRouterView(first: string, ...rest: string[]) {
	const fixture = JSON.parse(
		readFileSync(new URL("../../../subscription-router/tests/fixtures/views.json", import.meta.url), "utf8"),
	) as { views: { name: string; now: number; usage: { views: unknown[] } }[] };
	const readCase = (name: string) => {
		const entry = fixture.views.find((view) => view.name === name);
		if (!entry) throw new Error(`Missing router view fixture: ${name}`);
		return entry;
	};
	const entry = readCase(first);
	const root = join(dir, "router-state", "v1");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "view.json"), JSON.stringify([entry, ...rest.map(readCase)].flatMap((c) => c.usage.views)));
	return { agentDir: dir, clock: { ...realClock, now: () => entry.now } };
}

describe("/stats command", () => {
	it.each([
		["legacy-assumed", "OpenAI 5h (assumed span)", "10%"],
		["inferred-span", "faux-subscription short-quota (inferred span)", "100%"],
	])("shows %s span provenance separately from the utilization basis", async (fixture, label, percent) => {
		const opts = seedRouterView(fixture);
		const { run, rendered } = setup("tui", opts);
		await run("");
		expect(rendered[0]?.join("\n")).toContain(label);
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print", opts).run("");
		expect(String(out.mock.calls[0]?.[0])).toContain(`${label}: ${percent} used · reported`);
	});

	it("shows router gauges, observed counts and inferred blocks without any session history", async () => {
		const opts = seedRouterView("inferred-span", "metered");
		const { run, rendered } = setup("tui", opts);
		await run("");
		expect(rendered).toHaveLength(1);
		const overlay = rendered[0]?.join("\n");
		expect(overlay).toMatch(/short-quota \(inferred span\) +██████████ +100% +reported/);
		expect(overlay).toMatch(/rpd +37\/250 requests +observed · resets 00:00 PT/);
		expect(overlay).toMatch(/blocked until 2026-01-16 08:00 UTC +inferred/);
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print", opts).run("");
		const printed = String(out.mock.calls[0]?.[0]);
		expect(printed).toContain("short-quota (inferred span): 100% used · reported");
		expect(printed).toContain("Google spend-10m: $1.24 · observed");
		expect(printed).toContain("Google/faux-fast rpd: 37/250 requests · observed · resets 00:00 PT");
		expect(printed).toContain("blocked until 2026-01-16 08:00 UTC · inferred");
	});

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
			expect.stringContaining("/stats: no usage recorded yet\n1 machine · local-only · viewer never imported"),
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
		expect(ctx.modelRegistry.getAll).toHaveBeenCalledTimes(1);
		expect(text).toContain("recorded cost");
		expect(text).toContain("Current-rate API-equivalent estimate: unknown");
		expect(text).toContain("0 priced / 2 unpriced events");
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
			expect.stringContaining(
				"/stats: no usage recorded yet\nincomplete coverage · 1 machine · local-only · viewer never imported",
			),
			"info",
		);
	});

	it("reports local session errors in print mode so partial totals are not read as complete", async () => {
		seed();
		const locked = join(dir, "sessions", "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		try {
			const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			await setup("print").run("");
			expect(String(out.mock.calls[0]?.[0])).toContain("/stats: 1 local session/cache errors");
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	it("rpc mode notifies, and an empty history says so", async () => {
		const { run, ctx } = setup("rpc");
		await run("");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("/stats: no usage recorded yet\n1 machine · local-only · viewer never imported"),
			"info",
		);
	});

	it("shows the other harnesses found in the home, labelled, with unpriced cost and quota", async () => {
		seed();
		seedHarnessHome(join(dir, "home"));
		// a live reading: the seeded one has long reset, and is dropped
		writeLines(join(dir, "home", ".codex", "sessions", "2026", "10", "03", "rollout-live.jsonl"), [
			codexMeta(),
			codexTokenCount(
				limits({ used_percent: 12.5, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 }),
			),
		]);
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print").run("");
		const text = String(out.mock.calls[0]?.[0]);
		expect(text).toMatch(/provider +model +harness/);
		expect(text).toContain("by harness:");
		expect(text).toMatch(/claude: .*unpriced/);
		expect(text).toContain("quota:");
		expect(text).toContain("openai-codex/codex 7d");
		expect(text).toContain("  codex: found");
		expect(text).toContain("  opencode: found");
	});

	it("reads no other harness for an isolated agent dir, and says when it cannot", async () => {
		seed();
		seedHarnessHome(join(dir, "home"));
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print", { agentDir: dir }).run("");
		const isolated = String(out.mock.calls[0]?.[0]);
		expect(isolated).not.toContain("harness");
		expect(isolated).not.toContain("quota:");
		// an explicit home opts back in
		out.mockClear();
		await setup("print", { agentDir: dir, homeDir: join(dir, "home") }).run("");
		expect(String(out.mock.calls[0]?.[0])).toContain("by harness:");
		out.mockClear();
		mkdirSync(join(dir, "pi-session-kit"), { recursive: true });
		writeFileSync(join(dir, "pi-session-kit", "export-state.json"), "{ nope");
		await setup("print").run("");
		expect(String(out.mock.calls[0]?.[0])).toContain("/stats: other harnesses not read: export state unreadable");
	});

	it("still shows quota readings when there is no usage to total", async () => {
		// a Codex rollout with a rate-limit reading but no per-turn usage records
		writeLines(join(dir, "home", ".codex", "sessions", "2026", "10", "02", "rollout-a.jsonl"), [
			codexMeta(),
			codexTokenCount(
				limits({ used_percent: 12.5, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 }),
			),
		]);
		const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await setup("print").run("");
		expect(String(out.mock.calls[0]?.[0])).toMatch(
			/^\/stats: no usage recorded yet\nquota:\n {2}openai-codex\/codex 7d: /,
		);
		const { run, custom, rendered } = setup("tui");
		await run("");
		expect(custom).toHaveBeenCalledOnce();
		expect(rendered[0]?.join("\n")).toMatch(/Quota[\s\S]*openai-codex\/codex 7d/);
	});
});
