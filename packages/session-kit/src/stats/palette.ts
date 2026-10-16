/**
 * Chart series colours derived from the theme's `accent`: same lightness (so they read on the
 * theme's background), saturation raised to at least `MIN_SATURATION`, hues spread evenly around the
 * OKHSL wheel. Theme tokens like `success`/`warning` are often muted variants of one hue (belafonte-day's
 * blue/olive/brown), which made provider lines nearly indistinguishable.
 */

import { type Color, colorToOkhsl, okhslColor } from "@earendil-works/pi-tui";

export const MIN_SATURATION = 0.75;
/** Keep generated colours away from the extremes, where hue stops being visible. */
const LIGHTNESS_RANGE: [number, number] = [0.35, 0.75];

/** `count` colours, the first at the base hue, the rest `360 / count` degrees apart. */
export function seriesPalette(base: Color, count: number): Color[] {
	const { h, s, l } = colorToOkhsl(base);
	const hue = Number.isFinite(h) ? h : 250;
	const sat = Math.max(Number.isFinite(s) ? s : 0, MIN_SATURATION);
	const light = Math.min(LIGHTNESS_RANGE[1], Math.max(LIGHTNESS_RANGE[0], l));
	const step = 360 / Math.max(1, count);
	return Array.from({ length: count }, (_, i) => okhslColor((hue + i * step) % 360, sat, light));
}
