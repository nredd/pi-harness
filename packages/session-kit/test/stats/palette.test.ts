import { type Color, colorToOkhsl, colorToOklch, parseColor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MIN_SATURATION, seriesPalette } from "../../src/stats/palette.ts";

/** OKLab distance: about 0.02 is a just-noticeable difference, 0.2 is a different colour family. */
function deltaE(a: Color, b: Color): number {
	const lab = (c: Color) => {
		const { l, c: ch, h } = colorToOklch(c);
		const r = (h * Math.PI) / 180;
		return [l, ch * Math.cos(r), ch * Math.sin(r)] as const;
	};
	const [x, y] = [lab(a), lab(b)];
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function minDeltaE(colors: readonly Color[]): number {
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < colors.length; i++)
		for (let j = i + 1; j < colors.length; j++) min = Math.min(min, deltaE(colors[i] as Color, colors[j] as Color));
	return min;
}

// accent, success, warning: the tokens the chart used before
const THEMES = {
	"belafonte-day": ["#426a79", "#52502f", "#6e4816"],
	"tokyonight-storm": ["#7aa2f7", "#9ece6a", "#e0af68"],
} as const;

describe("seriesPalette (regression: provider lines were near-identical on belafonte-day)", () => {
	it.each(Object.entries(THEMES))(
		"%s: two and three series are far apart, and further than the old tokens",
		(_, hexes) => {
			const old = hexes.map((h) => parseColor(h));
			const accent = old[0] as Color;
			for (const count of [2, 3]) {
				const palette = seriesPalette(accent, count);
				expect(palette).toHaveLength(count);
				expect(minDeltaE(palette)).toBeGreaterThan(0.14);
				expect(minDeltaE(palette)).toBeGreaterThan(minDeltaE(old.slice(0, count)));
			}
			// the default view: two providers, at least ~a colour family apart
			expect(minDeltaE(seriesPalette(accent, 2))).toBeGreaterThan(0.2);
		},
	);

	it("keeps the accent's hue first, spreads hues evenly and stays saturated and readable", () => {
		const accent = parseColor("#426a79");
		const base = colorToOkhsl(accent);
		const palette = seriesPalette(accent, 3).map(colorToOkhsl);
		expect(Math.abs((palette[0]?.h ?? 0) - base.h)).toBeLessThan(2);
		for (const c of palette) {
			expect(c.s).toBeGreaterThanOrEqual(MIN_SATURATION - 0.02);
			expect(c.l).toBeCloseTo(base.l, 1);
		}
		const hues = palette.map((c) => c.h);
		const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
		expect(gap(hues[0] ?? 0, hues[1] ?? 0)).toBeGreaterThan(110);
		expect(gap(hues[1] ?? 0, hues[2] ?? 0)).toBeGreaterThan(110);
	});

	it("handles a grey accent and extreme lightness", () => {
		for (const hex of ["#808080", "#000000", "#ffffff"]) {
			const palette = seriesPalette(parseColor(hex), 2);
			expect(minDeltaE(palette)).toBeGreaterThan(0.1);
		}
	});
});
