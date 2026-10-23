/** Actual built-in Pi themes over an actual host observation; layout bounds hold in both. */
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getThemeByName } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { MonView } from "../../src/mon/component.ts";
import type { MonSnapshot } from "../../src/mon/model.ts";
import { createSamplerSource } from "../../src/mon/source.ts";

const SIZES = [
	[40, 12],
	[60, 20],
	[80, 24],
	[120, 40],
] as const;
let observations: MonSnapshot[] = [];

beforeAll(async () => {
	const source = createSamplerSource();
	const signal = new AbortController().signal;
	try {
		observations = [await source.sample(signal)];
		await sleep(120);
		observations.push(await source.sample(signal));
	} finally {
		await source.dispose();
	}
});

function render(name: "dark" | "light", width: number, height: number): string[] {
	const theme = getThemeByName(name);
	if (!theme) throw new Error(`Missing built-in ${name} theme`);
	const view = new MonView({ theme, rows: () => height, requestRender: vi.fn(), onClose: vi.fn() });
	for (const observation of observations) view.update(observation);
	return view.render(width);
}

describe("mon with built-in themes", () => {
	it.each(SIZES)("dark and light both fit %ix%i and differ only in styling", (width, height) => {
		const dark = render("dark", width, height);
		const light = render("light", width, height);
		for (const lines of [dark, light]) {
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(lines.join("\n")).toContain("\u001b[");
		}
		expect(dark.map((l) => stripVTControlCharacters(l))).toEqual(light.map((l) => stripVTControlCharacters(l)));
		expect(dark).not.toEqual(light);
		expect(stripVTControlCharacters(dark[0] ?? "")).toContain("LIVE");
	});
});
