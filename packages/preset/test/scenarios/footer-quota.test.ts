import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { parseUsageReply } from "../../lib/footer-quota.ts";
import { FooterFixture, providerSegment, quotaRow, quotaRows, STATUS, snapshot, values } from "./support.ts";

let fixture: FooterFixture;
afterEach(async () => fixture?.dispose());

it.each([
	["anthropic", "claude-haiku-4-5"],
	["openai-codex", "gpt-5.4"],
	["router", "default"],
])("direct and virtual selections show both providers after startup: %s/%s", async (provider, id) => {
	fixture = new FooterFixture();
	fixture.usage.codex = [30.5, 99.9];
	const host = await fixture.start({
		deferStart: true,
		extensionFactories: [
			(pi) => {
				if (provider === "router")
					pi.registerVirtualModel({
						provider,
						id,
						name: id,
						route: (_request, ctx) => {
							const model = ctx.modelRegistry.find("faux", "main");
							if (!model) throw new Error("Missing faux route target");
							return { model, thinkingLevel: "off" };
						},
					});
				else
					pi.registerProvider(provider, {
						baseUrl: "https://fixture.invalid",
						apiKey: "fixture-only",
						api: "faux-api",
						models: [
							{
								id,
								name: id,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					});
				pi.on("session_start", async (_event, ctx) => {
					const selected = ctx.modelRegistry.find(provider, id);
					if (!selected) throw new Error(`Missing selection ${provider}/${id}`);
					expect(await pi.setModel(selected)).toBe(true);
				});
			},
		],
	});
	expect(fixture.usage.requests).toHaveLength(0);
	await fixture.advance(0);
	expect(values(host, "anthropic")).toEqual(["80%", "60%"]);
	expect(values(host, "openai-codex")).toEqual(["0%"]);
	expect(quotaRow(host)).toContain("Anthropic");
	expect(quotaRow(host)).toContain("OpenAI");
	expect(host.harness.session.model).toMatchObject({ provider, id });
	expect(fixture.usage.requests[0]).toMatchObject({ ready: true, refresh: true });
});

it("missing provider paints dashes", async () => {
	fixture = new FooterFixture();
	fixture.usage.anthropic = [10, 10];
	fixture.usage.codex = undefined;
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	expect(values(host, "openai-codex")).toEqual(["--"]);
});

it("quota thresholds paint distinct ANSI styles", async () => {
	fixture = new FooterFixture();
	const rounds = [
		{
			used: [50, 80, 81, 95],
			expected: [
				[50, "ok"],
				[20, "warning"],
				[19, "warning"],
				[5, "error"],
			],
		},
		{
			used: [79, 82, 96, 100],
			expected: [
				[21, "ok"],
				[18, "warning"],
				[4, "error"],
				[0, "error"],
			],
		},
	] as const;
	const styles = new Map<string, Set<string>>();
	const host = await fixture.start({ deferStart: true });
	for (const [i, round] of rounds.entries()) {
		fixture.usage.anthropic = [round.used[0], round.used[1]];
		fixture.usage.codex = [round.used[2], round.used[3]];
		await fixture.advance(i === 0 ? 0 : 60_000);
		expect(values(host, "anthropic")).toEqual(round.expected.slice(0, 2).map(([left]) => `${left}%`));
		expect(values(host, "openai-codex")).toEqual(round.expected.slice(3).map(([left]) => `${left}%`));
		const row = quotaRow(host);
		const cells = host.terminal.getStyledLine(host.viewport().indexOf(row));
		// OpenAI has no 5h quota, so its first fixture window (index 2) is never rendered.
		for (const [left, level] of round.expected.filter((_, i) => i !== 2)) {
			const cell = cells[row.indexOf(`${left}%`)];
			if (!cell) throw new Error(`No styled cell for ${left}%`);
			const found = styles.get(level) ?? new Set<string>();
			found.add(`${cell.foregroundMode}:${cell.foreground}:${cell.bold}`);
			styles.set(level, found);
		}
	}
	for (const found of styles.values()) expect(found.size).toBe(1);
	expect(new Set([...styles.values()].flatMap((found) => [...found])).size).toBe(3);
});

it("quota tier follows injected terminal resize", async () => {
	fixture = new FooterFixture();
	const host = await fixture.start();
	expect(quotaRow(host)).toMatch(/^Quota left:/);
	host.resize(50, 30);
	await host.settle();
	expect(quotaRow(host)).toMatch(/^Left:/);
	expect(quotaRow(host)).toContain("Anth");
	expect(quotaRow(host)).toContain("OAI");
	expect(values(host, "anthropic")).toEqual(["80%", "60%"]);
	for (const row of host.viewport()) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
	host.resize(120, 40);
	await host.settle();
	expect(quotaRow(host)).toMatch(/^Quota left:/);
});

it("idle quota poll repaints without disturbing other rows", async () => {
	fixture = new FooterFixture();
	fixture.usage.anthropic = fixture.usage.codex = [10, 10];
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	fixture.usage.anthropic = [60, 70];
	await fixture.advance(60_000);
	expect(values(host, "anthropic")).toEqual(["40%", "30%"]);
	expect(host.viewport().join("\n")).toContain(STATUS);
	expect(host.viewport().join("\n")).toContain("ctx");
	expect(fixture.usage.requests).toHaveLength(2);
});

it("stale provider recovers independently", async () => {
	fixture = new FooterFixture();
	fixture.usage.anthropic = fixture.usage.codex = [10, 10];
	fixture.usage.statuses = ["stale", "available"];
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	expect(providerSegment(host, "anthropic")).toContain("stale");
	expect(providerSegment(host, "openai-codex")).not.toContain("stale");
	fixture.usage.statuses = ["available", "available"];
	await fixture.advance(60_000);
	expect(providerSegment(host, "anthropic")).not.toContain("stale");
});

it.each(["hang", "error"] as const)("hung and errored polls retain then recover: %s", async (mode) => {
	fixture = new FooterFixture();
	fixture.usage.anthropic = fixture.usage.codex = [10, 10];
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	expect(providerSegment(host, "anthropic")).not.toContain("stale");
	fixture.usage.anthropic = fixture.usage.codex = [50, 50];
	fixture.usage.mode = mode;
	await fixture.advance(60_000);
	if (mode === "hang") {
		expect(providerSegment(host, "anthropic")).not.toContain("stale");
		await fixture.advance(11_999);
		expect(providerSegment(host, "anthropic")).not.toContain("stale");
		await fixture.advance(1);
	}
	for (const provider of ["anthropic", "openai-codex"] as const)
		expect(providerSegment(host, provider)).toContain("stale");
	await fixture.advance(132_000);
	for (const provider of ["anthropic", "openai-codex"] as const) {
		expect(values(host, provider)).toEqual(provider === "anthropic" ? ["90%", "90%"] : ["90%"]);
		expect(providerSegment(host, provider)).toContain("stale");
	}
	expect(host.viewport().join("\n")).toContain(STATUS);
	fixture.usage.mode = "ok";
	await fixture.advance(60_000);
	for (const provider of ["anthropic", "openai-codex"] as const) {
		expect(values(host, provider)).toEqual(provider === "anthropic" ? ["50%", "50%"] : ["50%"]);
		expect(providerSegment(host, provider)).not.toContain("stale");
	}
});

it.each(["/reload", "/new"])("reload and new leave one quota poller: %s", async (command) => {
	fixture = new FooterFixture();
	fixture.usage.anthropic = fixture.usage.codex = [10, 10];
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	fixture.usage.mode = "hang";
	await fixture.advance(60_000);
	const oldReply = fixture.usage.requests.at(-1)?.reply;
	if (!oldReply) throw new Error("No pending old request");
	fixture.usage.mode = "ok";
	const oldSession = host.harness.session;
	host.input(command);
	host.input("\r");
	await host.settle();
	await fixture.advance(0);
	expect(host.harness.session === oldSession).toBe(command === "/reload");
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	expect(host.viewport().join("\n")).toContain(STATUS);
	fixture.usage.anthropic = fixture.usage.codex = [99, 99];
	oldReply();
	await host.settle();
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	fixture.usage.anthropic = fixture.usage.codex = [10, 10];
	const before = fixture.usage.requests.length;
	await fixture.advance(240_000);
	expect(fixture.usage.requests.length - before).toBe(4);
	expect(values(host, "anthropic")).toEqual(["90%", "90%"]);
	await host.dispose();
	expect(fixture.clock.pending).toBe(0);
});

it("25-column quota wraps by provider; every value keeps its provider label", async () => {
	fixture = new FooterFixture();
	const host = await fixture.start();
	expect(values(host, "anthropic")).toEqual(["80%", "60%"]);
	host.resize(25, 30);
	await fixture.advance(120_000);
	const rows = host.viewport();
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(25);
	expect(quotaRow(host)).toBe("Left: Anth 5h 80% 7d 60%");
	expect(quotaRows(host)).toEqual(["Left: Anth 5h 80% 7d 60%", "OAI 7d 50%"]);
	expect(values(host, "openai-codex")).toEqual(["50%"]);
	host.resize(120, 40);
	await host.settle();
	expect(quotaRow(host)).toMatch(/^Quota left:/);
	expect(values(host, "openai-codex")).toEqual(["50%"]);
});

const RESETS = {
	anthropic: [Date.parse("2026-10-19T14:30:00Z"), Date.parse("2026-10-22T09:00:00Z")],
	codex: [Date.parse("2026-10-19T13:00:00Z"), Date.parse("2026-10-24T11:05:00Z")],
};

it("wide footer shows Anthropic 5h reset time, weekly reset dates, and no OpenAI 5h", async () => {
	fixture = new FooterFixture();
	fixture.usage.anthropicResets = RESETS.anthropic;
	// The router reports a 5h-named OpenAI window too; the footer must not surface it.
	fixture.usage.codexResets = RESETS.codex;
	const host = await fixture.start();
	host.resize(200, 40);
	await host.settle();
	expect(quotaRows(host)).toEqual([
		"Quota left: Anthropic 5h 80% (resets 14:30) weekly 60% (resets Oct 22 09:00) | OpenAI weekly 50% (resets Oct 24 11:05)",
	]);
	expect(host.viewport().join("\n")).not.toMatch(/OpenAI 5h|OAI 5h|13:00/);
	host.resize(110, 40);
	await host.settle();
	expect(quotaRows(host)).toEqual(["Left: Anth 5h 80% @14:30 7d 60% @Oct 22 09:00 | OAI 7d 50% @Oct 24 11:05"]);
});

it("narrow footer wraps by provider keeping resets, then drops them before clipping", async () => {
	fixture = new FooterFixture();
	fixture.usage.anthropicResets = RESETS.anthropic;
	fixture.usage.codexResets = RESETS.codex;
	const host = await fixture.start();
	host.resize(60, 40);
	await host.settle();
	expect(quotaRows(host)).toEqual(["Left: Anth 5h 80% @14:30 7d 60% @Oct 22 09:00", "OAI 7d 50% @Oct 24 11:05"]);
	host.resize(30, 40);
	await host.settle();
	expect(quotaRows(host)).toEqual(["Left: Anth 5h 80% 7d 60%", "OAI 7d 50%"]);
	for (const row of host.viewport()) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
});

it("unknown, past and stale resets: omitted, unknown percent, retained", async () => {
	fixture = new FooterFixture();
	// Anthropic: no 5h reset reported; weekly reset already passed. OpenAI: weekly reset known.
	fixture.usage.anthropicResets = [undefined, Date.parse("2026-10-19T11:59:00Z")];
	fixture.usage.codexResets = [undefined, RESETS.codex[1]];
	const host = await fixture.start();
	host.resize(200, 40);
	await host.settle();
	expect(quotaRows(host)).toEqual(["Quota left: Anthropic 5h 80% weekly -- | OpenAI weekly 50% (resets Oct 24 11:05)"]);
	// A failed poll keeps the last reading and its reset, marked stale.
	fixture.usage.mode = "error";
	await fixture.advance(60_000);
	expect(quotaRows(host)).toEqual([
		"Quota left: Anthropic (stale) 5h 80% weekly -- | OpenAI (stale) weekly 50% (resets Oct 24 11:05)",
	]);
});

it("absent usage listener leaves quota hidden", async () => {
	fixture = new FooterFixture();
	const host = await fixture.start({ absent: true });
	await fixture.advance(240_000);
	expect(host.viewport().join("\n")).not.toMatch(/Quota left:|Left:/);
	expect(host.viewport().join("\n")).toContain("ctx");
});

it("production poll cadence is exactly sixty seconds", async () => {
	fixture = new FooterFixture();
	const host = await fixture.start();
	quotaRow(host);
	expect(fixture.usage.requests).toHaveLength(1);
	await fixture.advance(59_999);
	expect(fixture.usage.requests).toHaveLength(1);
	await fixture.advance(1);
	expect(fixture.usage.requests).toHaveLength(2);
	expect((fixture.usage.requests[1]?.at ?? 0) - (fixture.usage.requests[0]?.at ?? 0)).toBe(60_000);
});

it("usage envelopes validate providers and omit missing snapshots", () => {
	fixture = new FooterFixture();
	const snap = snapshot("anthropic", [10, 20], fixture.clock.now(), "stale");
	expect(snap.windows.map((window) => window.name)).toEqual(["five_hour", "seven_day"]);
	expect(snap.status).toBe("stale");
	expect(snapshot("openai-codex", undefined, fixture.clock.now()).windows).toEqual([]);
	expect(() => snapshot("nope", [1, 2], fixture.clock.now())).toThrow("Unknown provider");
	fixture.usage.codex = undefined;
	fixture.usage.mode = "hang";
	expect(fixture.usage.envelope()).toMatchObject({ success: true, data: { snapshots: [{ provider: "anthropic" }] } });
	expect(fixture.usage.requests).toEqual([]);
	const parsed = parseUsageReply(
		{ success: true, data: { snapshots: [snap, { provider: "nope", windows: [] }] } },
		fixture.clock.now(),
	);
	expect(Object.keys(parsed ?? {})).toEqual(["anthropic", "openai-codex"]);
	expect(parsed?.anthropic).toMatchObject({ fiveHour: 90, weekly: 80, stale: true });
	expect(parsed?.["openai-codex"]).toMatchObject({ fiveHour: undefined, weekly: undefined, stale: true });
});
