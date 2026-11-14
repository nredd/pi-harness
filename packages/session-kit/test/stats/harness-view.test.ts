import { type Color, colorToRgb, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { chartSeries, harnessesOf, modelTotals, overview, seriesKey } from "../../src/stats/aggregate.ts";
import { StatsView, summary } from "../../src/stats/component.ts";
import { costLabel } from "../../src/stats/format.ts";
import { freshnessLines } from "../../src/stats/freshness.ts";
import type { QuotaObservation } from "../../src/stats/harness/common.ts";
import type { Call } from "../../src/stats/load.ts";
import { claudeHasNoReading, gauge, quotaRows, usedLabel } from "../../src/stats/quota.ts";
import { at, call } from "./fixtures.ts";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");
const theme = {
	fg: (c: string, s: string) => `\u001b[3${c.length % 8}m${s}\u001b[39m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	style: (s: string) => s,
	colors: { accent: parseColor("#426a79") },
};
/** `style` paints real truecolor SGR, so a test can see which colour drew what. */
const coloured = {
	...theme,
	style: (s: string, o: { fg?: Color }) => {
		const { r, g, b } = colorToRgb(o.fg ?? parseColor("#000000"));
		return `${ESC}[38;2;${r};${g};${b}m${s}${ESC}[39m`;
	},
};
const TODAY = "2026-10-13";
const NOW = at(TODAY, 18);

const calls: Call[] = [
	call(TODAY, "anthropic", "opus", 100, 10, { cost: 1 }),
	call(TODAY, "anthropic", "opus", 200, 20, { harness: "claude", cost: null, session: "/c" }),
	call(TODAY, "openai", "sol", 300, 30, { harness: "codex", cost: null, session: "/x" }),
	call("2026-10-12", "anthropic", "opus", 50, 5, { harness: "claude", cost: null, session: "/c" }),
	call("2026-10-12", "anthropic", "opus", 50, 5, { cost: 0.5 }),
];

const quota = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
	harness: "codex",
	provider: "openai-codex",
	limitId: "codex",
	window: "7d",
	usedPercent: 47.3,
	resetAt: NOW + 3 * 3_600_000,
	durationMs: 604_800_000,
	observedAt: NOW - 12 * 60_000,
	planType: "pro",
	account: "",
	...extra,
});

function make(list: readonly Call[], extra: Partial<ConstructorParameters<typeof StatsView>[0]> = {}, rows = 60) {
	return new StatsView({
		calls: list,
		sessions: [],
		theme: theme as never,
		rows: () => rows,
		requestRender() {},
		onClose() {},
		today: TODAY,
		now: NOW,
		...extra,
	});
}
const text = (view: StatsView, width = 120) => strip(view.render(width).join("\n"));

describe("aggregation", () => {
	it("lists harnesses with data in a fixed order", () => {
		expect(harnessesOf(calls)).toEqual(["pi", "claude", "codex"]);
		expect(harnessesOf([])).toEqual([]);
	});

	it("keeps null costs out of the sum and counts them as unpriced", () => {
		const [opus, sol] = modelTotals(calls);
		expect(opus).toMatchObject({
			name: "anthropic/opus",
			cost: 1.5,
			unpriced: 2,
			calls: 4,
			harnesses: ["pi", "claude"],
		});
		expect(sol).toMatchObject({ cost: 0, unpriced: 1, calls: 1, harnesses: ["codex"] });
		expect(overview(calls, [], "all", TODAY, [TODAY])).toMatchObject({ cost: 1.5, unpriced: 3, calls: 5 });
	});

	it("splits a chart by harness only under the all filter", () => {
		expect(chartSeries({ kind: "all" }, calls, 4, true)).toMatchObject({
			by: "harness",
			keys: [{ key: "codex" }, { key: "claude" }, { key: "pi" }],
		});
		expect(chartSeries({ kind: "all" }, calls, 4).by).toBe("provider");
		expect(chartSeries({ kind: "model", name: "anthropic/opus" }, calls, 4, true).by).toBe("model");
		const c = calls[1] as Call;
		expect([seriesKey("harness")(c), seriesKey("provider")(c), seriesKey("model")(c)]).toEqual([
			"claude",
			"anthropic",
			"anthropic/opus",
		]);
	});
});

describe("costLabel", () => {
	it("never shows an unpriced call as $0", () => {
		expect(costLabel(1.5, 0, 2)).toBe("$1.50");
		expect(costLabel(1.5, 2, 4)).toBe("$1.50 + 2 unpriced");
		expect(costLabel(0, 3, 3)).toBe("unpriced");
		expect(costLabel(0, 0, 0)).toBe("$0.00");
	});
});

describe("quota rows", () => {
	it("renders a gauge and clamps out-of-range percentages", () => {
		expect([gauge(0), gauge(50), gauge(100), gauge(-5), gauge(250)]).toEqual([
			"░░░░░░░░░░",
			"█████░░░░░",
			"██████████",
			"░░░░░░░░░░",
			"██████████",
		]);
		expect([usedLabel(5), usedLabel(47.3), usedLabel(100)]).toEqual(["5%", "47.3%", "100%"]);
	});

	it("shows a live window with its reset and the reading's age, an expired one as unknown", () => {
		const [live, expired] = quotaRows(
			[quota(), quota({ window: "5h", durationMs: 18_000_000, resetAt: NOW - 5 * 60_000, usedPercent: 99 })],
			NOW,
		).sort((a, b) => Number(a.expired) - Number(b.expired));
		expect(live).toMatchObject({
			label: "openai-codex/codex 7d",
			expired: false,
			reset: "resets in 3h",
			observed: "observed 12m ago via codex",
			old: false,
		});
		expect(expired).toMatchObject({ expired: true, reset: "reset 5m ago, no newer reading" });
	});

	it("dims a reading older than 15 minutes, orders by window length and tags accounts only when needed", () => {
		const rows = quotaRows(
			[
				quota({ account: "bbbb".repeat(16), observedAt: NOW - 20 * 60_000 }),
				quota({ account: "" }),
				quota({ window: "5h", durationMs: 1, provider: "openai-codex", limitId: "openai-codex" }),
				quota({ observedAt: NOW + 60_000, window: "30d", durationMs: 9, account: "aaaa".repeat(16) }),
			],
			NOW,
		);
		expect(rows.map((r) => r.label)).toEqual([
			"openai-codex/codex 30d",
			"openai-codex/codex 7d acct none",
			"openai-codex/codex 7d acct bbbb",
			"openai-codex 5h",
		]);
		expect(rows.map((r) => r.old)).toEqual([false, false, true, false]);
		expect(rows[0]?.observed).toBe("observed 0s ago via codex");
	});

	it("drops a window reset more than one window ago, and an expired row beside a live one for any account", () => {
		const week = 604_800_000;
		const rows = quotaRows(
			[
				// reset over a window ago: long stale
				quota({ window: "5h", durationMs: 18_000_000, resetAt: NOW - 18_000_001 }),
				// reset recently, nothing live for the window: shown as reset
				quota({ window: "1d", durationMs: 86_400_000, resetAt: NOW - 60_000 }),
				// live reading for one account hides the expired one of another
				quota({ account: "aaaa".repeat(16) }),
				quota({ account: "bbbb".repeat(16), resetAt: NOW - 1, usedPercent: 99 }),
				// the same window under another limit is not hidden by it
				quota({ limitId: "other", durationMs: week, resetAt: NOW - 1 }),
			],
			NOW,
		);
		expect(rows.map((r) => [r.label, r.expired])).toEqual([
			["openai-codex/codex 1d", true],
			["openai-codex/codex 7d", false],
			["openai-codex/other 7d", true],
		]);
		// exactly one window ago still shows
		expect(quotaRows([quota({ resetAt: NOW - 604_800_000 })], NOW)).toHaveLength(1);
	});

	it("says Claude has no local reading only when Claude has data and nothing covers anthropic", () => {
		expect(claudeHasNoReading([], true)).toBe(true);
		expect(claudeHasNoReading([], false)).toBe(false);
		expect(claudeHasNoReading([quota({ provider: "anthropic" })], true)).toBe(false);
		expect(claudeHasNoReading([quota()], true)).toBe(true);
	});
});

describe("StatsView harness filter", () => {
	it("cycles All, pi, claude, codex with h and back with H, keeping the model filter when it exists", () => {
		const view = make(calls);
		expect(view.state.harness).toBe("all");
		expect(text(view)).toMatch(/harness: All +filter: All models/);
		view.handleInput("h");
		expect(view.state.harness).toBe("pi");
		expect(text(view)).toMatch(/harness: pi/);
		// only pi's two calls count: (100 + 10) + (50 + 5) = 165, not the 770 of every harness
		expect(text(view)).toMatch(/Total tokens +165 /);
		view.handleInput("h");
		view.handleInput("h");
		expect(view.state.harness).toBe("codex");
		view.handleInput("h");
		expect(view.state.harness).toBe("all");
		view.handleInput("H");
		expect(view.state.harness).toBe("codex");
		expect(text(view)).toMatch(/Favorite model +openai\/sol/);
	});

	it("keeps a model filter across harnesses that have it and resets it where they do not", () => {
		const view = make(calls);
		view.handleInput("M");
		expect(view.state.filter).toEqual({ kind: "model", name: "openai/sol" });
		view.handleInput("h");
		// pi has no openai/sol
		expect(view.state.filter).toEqual({ kind: "all" });
		const again = make(calls);
		for (let i = 0; i < 3; i++) again.handleInput("m");
		expect(again.state.filter).toEqual({ kind: "model", name: "anthropic/opus" });
		again.handleInput("h");
		again.handleInput("h");
		expect(again.state.harness).toBe("claude");
		expect(again.state.filter).toEqual({ kind: "model", name: "anthropic/opus" });
	});

	it("offers no harness choice when only one has data", () => {
		const view = make(calls.filter((c) => c.harness === "pi"));
		view.handleInput("h");
		view.handleInput("H");
		expect(view.state.harness).toBe("all");
		const shown = text(view);
		expect(shown).not.toContain("harness:");
		expect(shown).not.toContain("h harness");
		expect(text(make(calls))).toContain("h harness");
	});

	it("moves the harness under the ranges, then the filter under both, as the pane narrows", () => {
		const view = make(calls);
		const long = strip(view.render(100)[1] ?? "");
		expect(long).toMatch(/harness: All/);
		for (const width of [60, 45, 30, 20]) {
			const lines = view.render(width);
			expect(lines.every((l) => visibleWidth(l) <= width)).toBe(true);
			expect(strip(lines.join("\n"))).toContain("harness:");
		}
		const tiny = strip(view.render(30).join("\n"));
		expect(tiny).toMatch(/harness: All\n[^\n]*filter:/);
	});
});

describe("StatsView per-harness display", () => {
	it("charts one line per harness under All/All and per model once a model is picked", () => {
		const view = make(calls);
		let shown = text(view);
		expect(shown).toContain("by harness");
		for (const harness of ["pi", "claude", "codex"]) expect(shown).toMatch(new RegExp(`● ${harness}\\b`));
		view.handleInput("h");
		expect(text(view)).toContain("by provider");
		view.handleInput("h");
		view.handleInput("h");
		view.handleInput("h");
		view.handleInput("m");
		shown = text(view);
		expect(shown).toContain("by model");
	});

	it("colours Models bullets only for series the chart draws: harness lines colour no provider or model row", () => {
		// a provider that shares its name with a harness must not pick up that harness's line colour
		const named = [
			call(TODAY, "codex", "m", 100, 10, { harness: "codex", session: "/x" }),
			call(TODAY, "claude", "m", 100, 10, { harness: "claude", session: "/c" }),
		];
		const view = make(named, { theme: coloured as never });
		view.handleInput("\t");
		const raw = view.render(160).join("\n");
		expect(strip(raw)).toContain("by harness");
		expect(raw).not.toMatch(new RegExp(`${ESC}\\[38;2;[\\d;]+m•`));
		// under a model filter the chart is by model again, and its rows are coloured
		for (let i = 0; i < 3; i++) view.handleInput("m");
		expect(strip(view.render(160).join("\n"))).toContain("by model");
		expect(view.render(160).join("\n")).toMatch(new RegExp(`${ESC}\\[38;2;[\\d;]+m•`));
	});

	it("adds a harness column to the Models table, and the harness to its cards when narrow", () => {
		const view = make(calls);
		view.handleInput("\t");
		const wide = text(view, 160);
		expect(wide).toMatch(/Harness +Tokens +Share/);
		expect(wide).toMatch(/opus +pi,claude/);
		expect(wide).toMatch(/anthropic +pi,claude/);
		expect(wide).toMatch(/sol +codex/);
		const narrow = text(view, 60);
		expect(narrow).toContain("· pi,claude");
		view.handleInput("h");
		expect(text(view, 160)).not.toContain("Harness");
	});

	it("renders unpriced cost as such, never $0, with the count next to a partial total", () => {
		const view = make(calls);
		expect(text(view)).toMatch(/Notional cost +\$1\.50 \+ 3 unpriced/);
		view.handleInput("\t");
		const wide = text(view, 170);
		expect(wide).toContain("$1.50 + 2 unpriced");
		expect(wide).toMatch(/sol[^\n]*unpriced/);
		expect(text(view, 60)).toMatch(/\$1\.50 \+ 2 unpriced/);
		const claudeOnly = make(calls.filter((c) => c.harness === "claude"));
		expect(text(claudeOnly)).toMatch(/Notional cost +unpriced/);
		claudeOnly.handleInput("\t");
		expect(text(claudeOnly, 60)).toMatch(/\bunpriced\n/);
	});
});

describe("StatsView quota block", () => {
	it("shows gauge, percent, reset and reading age under the chart, dimmed when old", () => {
		const view = make(calls, {
			quota: [quota(), quota({ window: "5h", durationMs: 1, observedAt: NOW - 3_600_000, usedPercent: 5 })],
		});
		const shown = text(view, 160);
		expect(shown).toContain("Quota");
		expect(shown).toMatch(/openai-codex\/codex 7d +█████░░░░░ +47\.3% {2}resets in 3h · observed 12m ago via codex/);
		expect(shown).toMatch(/openai-codex\/codex 5h +█░░░░░░░░░ +5%/);
		// the theme paints "dim" with SGR 33 and "muted" with SGR 35
		const raw = view.render(160).join("\n");
		expect(raw).toContain(`${ESC}[33mresets in 3h · observed 1h ago`);
		expect(raw).toContain(`${ESC}[35mresets in 3h · observed 12m ago`);
	});

	it("shows an expired window as reset with no percent", () => {
		const view = make(calls, { quota: [quota({ resetAt: NOW - 60_000, usedPercent: 91 })] });
		const shown = text(view, 160);
		expect(shown).toContain("reset 1m ago, no newer reading");
		expect(shown).not.toContain("91");
	});

	it("says no local reading for Claude, and not when anthropic has one", () => {
		expect(text(make(calls), 120)).toMatch(/anthropic \(Claude Code\) +no local reading/);
		const withAnthropic = make(calls, {
			quota: [quota({ provider: "anthropic", limitId: "anthropic", harness: "claude" })],
		});
		expect(text(withAnthropic, 120)).not.toContain("no local reading");
		expect(
			text(
				make(
					calls.filter((c) => c.harness === "pi"),
					{},
				),
				120,
			),
		).not.toContain("Quota");
	});

	it("is not filtered by harness or range, wraps when narrow, and fits 60..320 columns", () => {
		const view = make(calls, { quota: [quota(), quota({ resetAt: NOW - 1, window: "5h", durationMs: 1 })] });
		view.handleInput("h");
		view.handleInput("r");
		for (const width of [60, 80, 120, 200, 320]) {
			const lines = view.render(width);
			expect(lines.every((l) => visibleWidth(l) <= width)).toBe(true);
			expect(strip(lines.join("\n"))).toContain("openai-codex/codex 7d");
		}
		const narrow = text(view, 60);
		expect(narrow).toMatch(/openai-codex\/codex 7d +█+░* +47\.3%\n +resets in 3h · observed 12m ago via codex/);
		expect(narrow).toMatch(/openai-codex 5h +reset|openai-codex\/codex 5h +\n? *reset/);
	});

	it("leaves the chart its rows when the block is short, and scrolls to the block on a short pane", () => {
		const view = make(calls, { quota: [quota()] }, 24);
		expect(view.render(100)).toHaveLength(24);
		for (let i = 0; i < 40; i++) view.handleInput("j");
		expect(text(view, 100)).toContain("openai-codex/codex 7d");
	});
});

describe("summary", () => {
	it("adds a harness column, the harness split, unpriced cost and quota rows", () => {
		const out = summary(calls, [quota(), quota({ resetAt: NOW - 1, window: "5h", durationMs: 1 })], NOW).split("\n");
		expect(out[1]).toMatch(/^provider +model +harness +in /);
		expect(out.some((l) => /opus +pi,claude/.test(l))).toBe(true);
		expect(out).toContain("by harness:");
		expect(out).toContain("  claude: 275 (35.7%), unpriced");
		expect(out).toContain("  pi: 165 (21.4%), $1.50");
		expect(out).toContain("quota:");
		expect(out).toContain("  openai-codex/codex 7d: 47.3% used, resets in 3h, observed 12m ago via codex");
		expect(out).toContain("  openai-codex/codex 5h: reset 0s ago, no newer reading, observed 12m ago via codex");
		expect(out).toContain("  anthropic (Claude Code): no local reading");
	});

	it("prints no quota section when there is nothing to say", () => {
		const out = summary(
			calls.filter((c) => c.harness !== "claude"),
			[],
			NOW,
		);
		expect(out).toContain("by harness:");
		expect(out).not.toContain("quota:");
		// live readings and no Claude data: the quota rows only
		const rowsOnly = summary(
			calls.filter((c) => c.harness !== "claude"),
			[quota()],
			NOW,
		);
		expect(rowsOnly).toContain("quota:");
		expect(rowsOnly).not.toContain("Claude Code");
		// Claude data with no reading at all still says so
		expect(
			summary(
				calls.filter((c) => c.harness !== "codex"),
				[],
				NOW,
			),
		).toContain("  anthropic (Claude Code): no local reading");
	});

	it("prints quota readings even with no usage, and the plain empty notice without them", () => {
		expect(summary([], [quota()], NOW)).toMatch(
			/^\/stats: no usage recorded yet\nquota:\n {2}openai-codex\/codex 7d: 47\.3% used/,
		);
		expect(summary([], [], NOW)).toBe("/stats: no usage recorded yet");
	});

	it("strips terminal control sequences from quota labels", () => {
		const osc = `${ESC}]0;pwned\u0007`;
		const out = summary(calls, [quota({ provider: `evil${osc}`, limitId: `evil${osc}` })], NOW);
		expect(out).toContain("quota:\n  evil");
		expect(out).not.toContain(ESC);
		expect(out).not.toContain("\u0007");
		expect(out).toContain("evil^[]0;pwned^G");
	});

	it("stays as before for one harness and no quota", () => {
		const out = summary(
			calls.filter((c) => c.harness === "pi"),
			[],
			NOW,
		);
		expect(out).not.toContain("harness");
		expect(out).not.toContain("quota:");
	});
});

describe("Machines harness lines", () => {
	it("shows found, not installed, last event, last good, stale and diagnostics per harness", () => {
		const base = { incomplete: false };
		const lines = freshnessLines(
			{
				machines: 2,
				remoteMachines: 1,
				incomplete: false,
				problems: [],
				sources: [
					{
						machineId: "L",
						label: "here",
						local: true,
						...base,
						harnesses: {
							pi: { found: true, lastEventMs: NOW - 60_000, problems: [] },
							claude: { found: true, problems: ["claude: ! 3 unreadable lines"] },
							opencode: { found: false, problems: [] },
							codex: { problems: [] },
						},
					},
					{
						machineId: "R",
						label: "there",
						local: false,
						exportedAt: NOW,
						...base,
						harnesses: {
							pi: { lastGoodAt: NOW, problems: [] },
							claude: {
								lastGoodAt: NOW - 5 * 86_400_000,
								lastEventMs: NOW - 6 * 86_400_000,
								stale: true,
								problems: [],
							},
						},
					},
				],
			},
			NOW,
		).join("\n");
		expect(lines).toMatch(/ {2}pi: found · last event .*\(1m ago\)/);
		expect(lines).toContain("  claude: found · ! 3 unreadable lines");
		expect(lines).toContain("  opencode: not installed");
		expect(lines).toContain("  codex: no data");
		expect(lines).toMatch(/ {2}pi: last read cleanly .*\(<1m ago\)/);
		expect(lines).toMatch(/ {2}claude: STALE, not read cleanly since .*\(5d ago\) · last event .*\(6d ago\)/);
	});
});
