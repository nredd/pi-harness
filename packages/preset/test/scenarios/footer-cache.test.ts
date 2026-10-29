import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import {
	COLD,
	DROP_COLD,
	DROP_IDLE,
	DROP_SWITCH,
	DROP_WARM,
	FooterFixture,
	STATUS,
	type Turn,
	WARM,
	WIDTHS,
} from "./support.ts";

const STATS = /\bhit \d+\.\d%|\bCH\d+\.\d%/;
const FULL =
	/^\s*in \S+ out \S+ (?:read \S+ )?(?:write \S+ )?hit (?<rate>\d+\.\d)%(?<marker> (?:warm|cold))(?<cause> \S+)? cost \$\S+ ctx \S+\/\S+ \(auto\)(?:\s+.*)?$/;
const COMPACT =
	/^\s*↑\S+ ↓\S+ (?:R\S+ )?(?:W\S+ )?CH(?<rate>\d+\.\d)%(?<marker> [wc])(?<cause> \S+)?\s+\$\S+\s+\S+\/\S+ \(auto\)/;
const COMPACT_CAUSE: Record<string, string> = {
	"idle>ttl": "idle",
	"model-switch": "model",
	compaction: "compact",
	"prefix-changed": "prefix",
};
let fixture: FooterFixture;
afterEach(async () => fixture?.dispose());

/** Four contiguous rows around the unique rendered stats anchor, bounded in display cells. */
function layout(width: number) {
	const host = fixture.requireHost();
	const screen = host.viewport();
	const shown = screen.join("\n");
	const stats = screen.flatMap((row, i) => (STATS.test(row) ? [i] : []));
	expect(stats, shown).toHaveLength(1);
	const at = stats[0] ?? -1;
	const status = screen.findIndex((row, i) => i > at && row.includes(STATUS));
	expect(status, shown).toBeGreaterThan(at);
	const rows = screen.slice(at - 1, status + 1);
	expect(rows, shown).toHaveLength(4);
	for (const row of screen) expect(visibleWidth(row), shown).toBeLessThanOrEqual(width);
	expect(rows[2]).toMatch(/^\s*(Quota left:|Left:)/);
	expect(rows[3]).toContain(STATUS);
	expect(rows[0]).not.toMatch(STATS);
	expect(rows[2]).not.toMatch(STATS);
	const text = rows[1] ?? "";
	const full = text.match(FULL);
	const compact = text.match(COMPACT);
	const match = full ?? compact;
	if (!match?.groups) throw new Error(`Neither stats tier fits: ${text}`);
	return {
		rows,
		tier: full ? "full" : "compact",
		marker: match.groups.marker,
		cause: (match.groups.cause ?? "").trim(),
		rate: Number(match.groups.rate),
	};
}

it.each(WIDTHS)("cache marker fits the width and history matrix: %i", async (width) => {
	for (const [turns, marker, cause] of [
		[WARM, "warm", ""],
		[DROP_COLD, "cold", "prefix-changed"],
	] as const) {
		fixture = new FooterFixture();
		await fixture.start({ turns, columns: width, rows: width === 320 ? 60 : 40 });
		const result = layout(width);
		const compact = width <= 80;
		expect(result.tier).toBe(compact ? "compact" : "full");
		expect(result.marker).toBe(` ${compact ? marker[0] : marker}`);
		expect(result.cause).toBe(compact && cause ? COMPACT_CAUSE[cause] : cause);
		if (width >= 120) expect(result.rows[1]?.trimEnd()).toMatch(/main$/);
		// Without OpenAI 5h the full quota row is 59 columns, so it now fits every tested width untruncated.
		expect(result.rows[2]?.trimEnd()).toBe("Quota left: Anthropic 5h 80% weekly 60% | OpenAI weekly 50%");
		await fixture.dispose();
	}
});

const STATES: { name: string; turns: Turn[]; marker: string; cause: string; compaction?: boolean }[] = [
	{ name: "warm", turns: WARM, marker: "warm", cause: "" },
	{ name: "cold", turns: COLD, marker: "cold", cause: "" },
	{ name: "drop-warm", turns: DROP_WARM, marker: "warm", cause: "prefix-changed" },
	{ name: "drop-cold", turns: DROP_COLD, marker: "cold", cause: "prefix-changed" },
	{ name: "idle", turns: DROP_IDLE, marker: "warm", cause: "idle>ttl" },
	{ name: "model-switch", turns: DROP_SWITCH, marker: "warm", cause: "model-switch" },
	{ name: "compaction", turns: DROP_WARM, marker: "warm", cause: "compaction", compaction: true },
];
it.each(STATES)(
	"history causes paint the expected cache marker: $name",
	async ({ turns, marker, cause, compaction }) => {
		fixture = new FooterFixture();
		await fixture.start({ turns, columns: 160, compaction });
		const result = layout(160);
		expect(result.tier).toBe("full");
		expect(result.marker).toBe(` ${marker}`);
		expect(result.cause).toBe(cause);
		if (!cause) expect(result.rate).toBeGreaterThanOrEqual(50);
		if (turns === WARM) {
			// Includes the monorepo-only healthy-footer row, merged into this case in the live e2e copy.
			expect(result.rows[1]).toContain("hit 96.8% warm cost");
			expect(result.rows[1]).not.toMatch(/idle>ttl|model-switch|compaction|prefix-changed/);
		}
	},
);

it("idle cache expiry repaints once and disposes", async () => {
	fixture = new FooterFixture();
	await fixture.start({
		turns: [
			{ age: 120, read: 0, input: 100, write: 3000 },
			{ age: 75, read: 3000, input: 100 },
		],
		columns: 160,
		ttl: 120,
	});
	expect(layout(160).rows[1]).toContain(" warm ");
	const initialTime = fixture.clock.now();
	await fixture.advance(45_049);
	expect(layout(160).rows[1]).toContain(" warm ");
	const fired = fixture.clock.fired.length;
	await fixture.advance(1);
	expect(fixture.clock.now() - initialTime).toBe(45_050);
	expect(layout(160).rows[1]).toContain(" cold ");
	expect(fixture.clock.fired.length - fired).toBe(1);
	const pending = fixture.clock.pending;
	await fixture.advance(1000);
	expect(fixture.clock.fired.length - fired).toBe(1);
	expect(fixture.clock.pending).toBe(pending);
	await fixture.requireHost().dispose();
	expect(fixture.clock.pending).toBe(0);
});

it("empty history has no cache segment", async () => {
	fixture = new FooterFixture();
	const host = await fixture.start({ columns: 160 });
	const screen = host.viewport().join("\n");
	expect(screen).toMatch(/Quota left:|Left:/);
	expect(screen).not.toMatch(/CH\d|hit \d/);
	expect(screen).toContain("ctx ");
	expect(screen).toContain(STATUS);
});

it.each([60, 120, 320])("long cwd branch and name stay on the first row: %i", async (width) => {
	fixture = new FooterFixture();
	const cwd = join(fixture.root, "a-very-long-directory-name-that-keeps-going", "segment-".repeat(12), "project");
	await fixture.start({
		cwd,
		gitBranch: `feature/${"very-long-branch-name-".repeat(5)}`,
		name: "named-session-for-the-footer",
		turns: DROP_COLD,
		columns: width,
	});
	const result = layout(width);
	expect(result.tier).toBe(width === 60 ? "compact" : "full");
	expect(result.cause).toBe(width === 60 ? "prefix" : "prefix-changed");
	const holders = fixture
		.requireHost()
		.viewport()
		.filter((row) => row.includes(cwd.slice(0, 16)) || row.includes("very-long-branch"));
	expect(holders).toEqual([result.rows[0]]);
	if (width === 320) expect(result.rows[0]).toContain("(feature/");
	else expect(result.rows[0]?.trimEnd()).toMatch(/\.\.\.$/);
});

it("short session name fits beside cwd", async () => {
	fixture = new FooterFixture();
	await fixture.start({ turns: WARM, columns: 160, name: "my-session" });
	expect(layout(160).rows[0]?.trimEnd()).toMatch(/my-session$/);
});

it.each(["fullscreen", "regular"] as const)("both renderer modes preserve footer rows: %s", async (tuiMode) => {
	fixture = new FooterFixture();
	await fixture.start({ turns: DROP_IDLE, columns: 160, tuiMode });
	const result = layout(160);
	expect([result.tier, result.marker, result.cause]).toEqual(["full", " warm", "idle>ttl"]);
});
