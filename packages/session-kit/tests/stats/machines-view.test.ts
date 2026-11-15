import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { StatsView } from "../../src/stats/component.ts";

it("cycles to Machines, wraps provenance and scrolls every source on narrow panes", () => {
	const view = new StatsView({
		calls: [],
		sessions: [],
		rows: () => 12,
		requestRender() {},
		onClose() {},
		theme: {
			fg: (_c, s) => s,
			bg: (_c, s) => s,
			bold: (s) => s,
			style: (s) => s,
			colors: { accent: parseColor("#ffffff") } as Theme["colors"],
		},
		freshness: [
			"Producer exported: 2026-10-12T12:00:00.000Z (10d ago)",
			...Array.from({ length: 30 }, (_, i) => `Machine ${i}`),
		],
	});
	view.handleInput("\t");
	view.handleInput("\t");
	expect(view.state.tab).toBe("Machines");
	for (const width of [30, 60, 120]) {
		const lines = view.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines).toHaveLength(12);
		expect(lines.join("\n")).toContain("Producer exported:");
	}
	for (let i = 0; i < 40; i++) view.handleInput("j");
	expect(view.render(60).join("\n")).toContain("Machine 29");
	view.handleInput("\t");
	expect(view.state.tab).toBe("Overview");
	view.handleInput("\u001b[Z");
	expect(view.state.tab).toBe("Machines");
});
