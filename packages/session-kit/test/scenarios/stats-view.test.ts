import { expect, it } from "vitest";
import {
	AXIS_COLUMN,
	chart,
	danglingPorts,
	footer,
	history,
	hourly,
	layout,
	MODELS,
	seed,
	selectFilter,
	selectTotal,
	start,
} from "./stats-support.ts";
import { RESIZES, TerminalFixture, WIDTHS } from "./support.ts";

/** Own teardown inside the test body: runner timeouts do not cancel an async callback. */
function statsTest<Args extends unknown[]>(
	body: (fixture: TerminalFixture, ...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
	return async (...args) => {
		const fixture = new TerminalFixture();
		try {
			await body(fixture, ...args);
		} finally {
			await fixture.dispose();
		}
	};
}

it.each(WIDTHS)(
	"stats width matrix navigates and restores footer at %i",
	statsTest(async (fixture, width: number) => {
		seed(fixture);
		await start(fixture, width);
		await fixture.open("/stats");
		let shown = layout(fixture);
		expect(shown).toContain("Less ░ ▒ ▓ █ More");
		expect(shown).toMatch(/Favorite model +anthropic\/claude-opus-5-5/);
		for (const excluded of ["unreadable", "faux", "router"]) expect(shown).not.toContain(excluded);
		await fixture.key("j".repeat(30));
		chart(layout(fixture));
		await fixture.key("\t");
		shown = layout(fixture);
		expect(shown).toContain("• anthropic ");
		chart(shown);
		expect(shown.includes("• openai-codex") || shown.includes("of 4 models"), shown).toBe(true);
		expect(shown).toContain("by provider");
		await fixture.key("r");
		expect(layout(fixture)).toContain("Tokens per day");
		await fixture.key("m");
		shown = layout(fixture);
		expect(shown).toMatch(/filter: anthropic\b/);
		expect(shown).toContain("by model");
		expect(shown).not.toContain("gpt-6.1-sol");
		await fixture.key("M");
		expect(layout(fixture)).toContain("filter: All models");
		await fixture.close();
		footer(fixture);
	}),
);

it(
	"stats tabs survive virtual resize",
	statsTest(async (fixture) => {
		seed(fixture);
		await start(fixture);
		await fixture.open("/stats");
		for (const [width, height] of RESIZES) {
			fixture.requireHost().resize(width, height);
			await fixture.requireHost().settle();
			layout(fixture);
			await fixture.key("\t");
			layout(fixture);
		}
		await fixture.close("\x1b");
		footer(fixture);
	}),
);

it(
	"short viewport reaches final model without false hints",
	statsTest(async (fixture) => {
		seed(fixture);
		await start(fixture, 80, 20);
		await fixture.open("/stats");
		await fixture.key("\t");
		expect(layout(fixture)).toMatch(/models below|of 4 models/);
		const seen = new Set<string>();
		for (let i = 0; i < 60; i++) {
			const shown = layout(fixture);
			for (const match of shown.matchAll(/• (claude-[\w-]+|gpt-[\w.-]+) \(/g)) seen.add(match[1] ?? "");
			expect(shown).not.toContain("Infinity");
			await fixture.key("j");
		}
		expect([...seen].sort()).toEqual(MODELS.map(([, model]) => model).sort());
		const shown = layout(fixture);
		expect(shown).toContain("gpt-5.6-terra");
		expect(shown.split("\n").at(-1)?.split("tab tabs")[0]).not.toContain("↓");
		await fixture.close();
		footer(fixture);
	}),
);

it(
	"fullscreen chart fills available rows with connected ports",
	statsTest(async (fixture) => {
		seed(fixture);
		await start(fixture, 130, 38);
		await fixture.open("/stats");
		for (const tab of ["Overview", "Models"]) {
			if (tab === "Models") {
				await fixture.key("\t");
				expect(layout(fixture)).toContain("• anthropic ");
			}
			const rows = fixture.requireHost().viewport();
			const plot = rows.filter((row) => "┤│".includes(row[AXIS_COLUMN] ?? " "));
			expect(plot.length, rows.join("\n")).toBeGreaterThanOrEqual(6);
			expect(danglingPorts(plot.map((row) => row.slice(AXIS_COLUMN + 1))), tab).toEqual([]);
			if (tab === "Overview") {
				expect(plot).toHaveLength(16);
				const caption = rows.findIndex((row) => row.includes("total: peak"));
				expect(caption).toBeGreaterThan(-1);
				expect(rows.slice(caption + 1, -1).filter((row) => !row.trim()).length).toBeLessThan(5);
			}
		}
		await fixture.close();
		footer(fixture);
	}),
);

it(
	"batched input reaches the same scroll clamps as individual keys",
	statsTest(async (fixture) => {
		seed(fixture);
		await start(fixture, 60, 20);
		await fixture.open("/stats");
		const top = layout(fixture);
		for (let i = 0; i < 40; i++) await fixture.key("j");
		const bottom = layout(fixture);
		expect(bottom).not.toBe(top);
		await fixture.key("k".repeat(60));
		expect(layout(fixture)).toBe(top);
		// Exercise the raw host path, not a loop hidden in the fixture key helper.
		const host = fixture.requireHost();
		host.input("j".repeat(40));
		await host.settle();
		expect(layout(fixture)).toBe(bottom);
		await fixture.key("j");
		expect(layout(fixture)).toBe(bottom);
		host.input("k".repeat(60));
		await host.settle();
		expect(layout(fixture)).toBe(top);
		await fixture.key("k");
		expect(layout(fixture)).toBe(top);
		await fixture.close();
	}),
);

/** Both tabs expose hourly axes and remain navigable before returning to top of Overview. */
async function hourlyTabs(fixture: TerminalFixture): Promise<void> {
	await fixture.key("j".repeat(40));
	expect(layout(fixture)).toContain("Tokens per hour");
	chart(layout(fixture));
	await fixture.key("\t");
	expect(layout(fixture)).toContain("Tokens per hour");
	chart(layout(fixture));
	await fixture.key("\x1b[B\x1b[Ajk");
	layout(fixture);
	await fixture.key("\t");
	await fixture.key("k".repeat(60));
	expect(layout(fixture)).toMatch(/Total tokens +\d/);
}

it.each(WIDTHS)(
	"hourly ranges paint exact filtered totals at every width %i",
	statsTest(async (fixture, width: number) => {
		history(fixture.agentDir, hourly(fixture.clock.now()));
		await start(fixture, width);
		await fixture.open("/stats");
		const shown = layout(fixture);
		expect(shown).toMatch(/Total tokens +546\b/);
		expect(shown).toMatch(/local.only|never.synced/i);
		for (const [total, anthropic, codex] of [
			[78, 26, 52],
			[260, 104, 156],
			[546, 234, 312],
		]) {
			if (total === undefined) throw new Error("Missing range total");
			await selectTotal(fixture, total);
			if (total !== 546) await hourlyTabs(fixture);
			expect(await selectFilter(fixture, "anthropic")).toMatch(new RegExp(`Total tokens +${anthropic}\\b`));
			expect(await selectFilter(fixture, "openai-codex")).toMatch(new RegExp(`Total tokens +${codex}\\b`));
			await selectFilter(fixture, "All models");
		}
		await fixture.close("\x1b");
		footer(fixture);
	}),
);

it(
	"chart spans the pane with contrasting providers",
	statsTest(async (fixture) => {
		seed(fixture);
		await start(fixture, 130, 38);
		await fixture.open("/stats");
		const host = fixture.requireHost();
		const rows = host.viewport();
		const baseline = rows.find((row) => row[AXIS_COLUMN] === "└") ?? "";
		expect(baseline.length).toBe(host.terminal.columns);
		const legend = rows.findIndex((row) => row.includes("anthropic") && row.includes("●"));
		expect(legend).toBeGreaterThan(-1);
		const bullets = host.terminal.getStyledLine(legend).filter((cell) => cell.text === "●");
		expect(bullets).toHaveLength(2);
		expect(bullets[0]?.foregroundMode).not.toBe(0);
		expect(bullets[1]?.foregroundMode).not.toBe(0);
		expect(bullets[0]?.foreground).not.toBe(bullets[1]?.foreground);
		await fixture.close();
		footer(fixture);
	}),
);
