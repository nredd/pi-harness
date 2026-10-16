/**
 * Box-drawing connectivity check for `plot` output: every line glyph's ports (left, right, up,
 * down) must meet a neighbour with the opposite port, except at the plot's left and right edges.
 * A dangling port is a broken line on screen (`╰╰`, a corner with no partner).
 */

const L = 1;
const R = 2;
const U = 4;
const D = 8;

export const PORTS: Record<string, number> = {
	"─": L | R,
	"│": U | D,
	"╭": R | D,
	"╮": L | D,
	"╰": U | R,
	"╯": L | U,
	"┴": L | R | U,
	"┬": L | R | D,
	"├": U | D | R,
	"┤": U | D | L,
	"┼": L | R | U | D,
};

/** Dangling ports in a grid of plot-body rows (gutter already removed), as `row:col glyph port` strings. */
export function danglingPorts(rows: readonly string[]): string[] {
	const grid = rows.map((r) => [...r]);
	const width = Math.max(0, ...grid.map((r) => r.length));
	const at = (y: number, x: number) => PORTS[grid[y]?.[x] ?? " "] ?? 0;
	const out: string[] = [];
	for (let y = 0; y < grid.length; y++) {
		for (let x = 0; x < width; x++) {
			const ch = grid[y]?.[x] ?? " ";
			const p = PORTS[ch] ?? 0;
			if (p & L && x > 0 && !(at(y, x - 1) & R)) out.push(`${y}:${x} ${ch} L`);
			if (p & R && x < width - 1 && !(at(y, x + 1) & L)) out.push(`${y}:${x} ${ch} R`);
			if (p & U && !(at(y - 1, x) & D)) out.push(`${y}:${x} ${ch} U`);
			if (p & D && !(at(y + 1, x) & U)) out.push(`${y}:${x} ${ch} D`);
		}
	}
	return out;
}
