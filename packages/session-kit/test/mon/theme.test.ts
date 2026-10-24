/** Actual built-in Pi themes over an actual host observation; layout bounds hold in both. */
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getThemeByName } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { MonView } from "../../src/mon/component.ts";
import type { MonSnapshot } from "../../src/mon/model.ts";
import { createSamplerSource } from "../../src/mon/source.ts";
import { snapshot } from "./fixtures.ts";

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
	it.each(["dark", "light"] as const)("%s keeps short-layout warnings and prioritizes host metrics", (name) => {
		const theme = getThemeByName(name);
		if (!theme) throw new Error(`Missing built-in ${name} theme`);
		for (const height of [6, 7, 8]) {
			const view = new MonView({ theme, rows: () => height, requestRender: vi.fn(), onClose: vi.fn() });
			for (const notice of [
				"Partial list: 2 of 40 seen (time budget)",
				"Sampling stopped. Close and reopen to retry.",
			]) {
				view.update({ ...snapshot(), status: "stale", notice });
				const lines = view.render(30);
				const text = lines.map(stripVTControlCharacters).join("\n");
				expect(text).toContain("STALE");
				expect(text).toContain(notice.startsWith("Partial") ? "Partial" : "reopen to retry");
				if (height < 8 && notice.startsWith("Partial")) expect(text).toContain("time budget");
				expect(text).toContain("sampled");
				expect(text).toContain("▸");
				expect(text).toContain("q/Esc close");
				for (const line of lines) expect(visibleWidth(line)).toBe(30);
			}
		}
		const view = new MonView({ theme, rows: () => 8, requestRender: vi.fn(), onClose: vi.fn() });
		view.update({ ...snapshot(), hint: "macOS: process CPU unavailable (see ?)" });
		const text = view.render(40).map(stripVTControlCharacters).join("\n");
		for (const metric of ["CPU 36.2%", "RAM 10.4G/24.0G", "load 3.21", "▸"]) expect(text).toContain(metric);
		expect(text).not.toContain("macOS:");
	});

	it.each(["dark", "light"] as const)(
		"%s explicitly mutes stale CPU last values, never severity-colors them",
		(name) => {
			const theme = getThemeByName(name);
			if (!theme) throw new Error(`Missing built-in ${name} theme`);
			const view = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
			view.update(snapshot(95));
			expect(view.render(80).join("\n")).toContain(theme.fg("error", "95.0%"));
			view.update({ ...snapshot(95), status: "stale" });
			const text = view.render(80).join("\n");
			expect(stripVTControlCharacters(text)).toContain("95.0% last value");
			expect(text).toContain(theme.fg("muted", "95.0%"));
			expect(text).not.toContain(theme.fg("error", "95.0%"));
		},
	);
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
