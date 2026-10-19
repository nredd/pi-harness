/** Fixed history fixtures and terminal oracles ported from the live stats scenarios. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import { configFor, STATUS, type TerminalFixture } from "./support.ts";

export const MODELS = [
	["anthropic", "claude-opus-5-5", 9],
	["anthropic", "claude-sonnet-5-5", 4],
	["openai-codex", "gpt-6.1-sol", 6],
	["openai-codex", "gpt-5.6-terra", 2],
] as const;
const HOUR = 3_600_000;
export const AXIS_COLUMN = 8;
const TITLE = /^ \/stats\s+Overview\s+Models/;

/** Physical assistant usage, with 26 total tokens per output token and stable preserved entry IDs. */
export function assistant(ms: number, provider: string, model: string, tokens: number) {
	return {
		type: "message",
		id: ms.toString(16),
		timestamp: new Date(ms).toISOString(),
		message: {
			role: "assistant",
			content: [],
			provider,
			model,
			timestamp: ms,
			usage: {
				input: tokens * 2,
				output: tokens,
				cacheRead: tokens * 20,
				cacheWrite: tokens * 3,
				totalTokens: tokens * 26,
				cost: { total: tokens / 100_000 },
			},
		},
	};
}

/** Session JSONL, not pre-aggregated component data; loading/dedup/cache stay production code. */
export function history(dir: string, entries: readonly unknown[], id = "hourly", extra: object = {}): string {
	const first = entries[0] as { timestamp: string } | undefined;
	if (!first) throw new Error("History requires entries");
	const path = join(dir, "sessions", "--seed--", `${id}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${[{ type: "session", version: 3, id, timestamp: first.timestamp, cwd: "/seed", ...extra }, ...entries]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	return path;
}

/** Faux/router/tool-result usage would dwarf real usage if any exclusions broke. */
function excluded(now: number): unknown[] {
	return [
		assistant(now, "faux", "faux-1", 10_000_000),
		assistant(now, "router", "default", 0),
		{
			type: "message",
			timestamp: new Date(now).toISOString(),
			message: {
				role: "toolResult",
				toolName: "steer_subagent",
				content: [],
				usage: { input: 50_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
	];
}

/** The live 45-day/four-model fixture, including its copied newest entry in a fork. */
export function seed(fixture: TerminalFixture): void {
	const now = fixture.clock.now() - HOUR;
	const entries = [];
	for (let back = 0; back < 45; back++) {
		for (const [provider, model, weight] of MODELS) {
			if ((back + weight) % 4 === 0) continue;
			entries.push(assistant(now - back * 24 * HOUR, provider, model, weight * 1000 * (1 + (back % 6))));
		}
	}
	const path = history(fixture.agentDir, [...entries, ...excluded(now)], "seed");
	history(fixture.agentDir, [entries.at(-1)], "fork", { parentSession: path, timestamp: new Date(now).toISOString() });
}

/** Exact rolling range fixture: All=546, 5h=78, 24h=260; future calls do not count. */
export function hourly(now: number) {
	const calls = [
		[1, "anthropic", "claude-opus-5-5", 1],
		[4, "openai-codex", "gpt-6.1-sol", 2],
		[6, "anthropic", "claude-opus-5-5", 3],
		[23, "openai-codex", "gpt-6.1-sol", 4],
		[25, "anthropic", "claude-opus-5-5", 5],
		[45 * 24, "openai-codex", "gpt-6.1-sol", 6],
	] as const;
	return [
		...calls.map(([hours, provider, model, tokens]) => assistant(now - hours * HOUR, provider, model, tokens)),
		assistant(now + 48 * HOUR, "anthropic", "claude-opus-5-5", 1_000_000),
		...excluded(now),
	];
}

/** Start the real stats command on a full interactive host. */
export async function start(fixture: TerminalFixture, columns = 120, rows = columns === 320 ? 60 : 40): Promise<void> {
	await fixture.startTerminal(configFor("stats"), { columns, rows });
}

/** Title first, help last, every row within terminal cell bounds, footer fully covered. */
export function layout(fixture: TerminalFixture): string {
	const host = fixture.requireHost();
	const rows = host.viewport();
	const shown = rows.join("\n");
	expect(rows, shown).toHaveLength(host.terminal.rows);
	expect(rows[0], shown).toMatch(TITLE);
	for (const row of rows) expect(visibleWidth(row), shown).toBeLessThanOrEqual(host.terminal.columns);
	const help = rows
		.at(-1)
		?.trim()
		.replace(/^[↑ ]? ?[↓ ]? *(\d+-\d+ of \d+ models|\d+ models below)/, "")
		.trim();
	expect(help, shown).toMatch(/^tab tabs/);
	expect(shown).not.toContain(STATUS);
	return shown;
}

/** Unique native core context row followed by extension status after an overlay closes. */
export function footer(fixture: TerminalFixture): void {
	const rows = fixture.requireHost().viewport();
	const shown = rows.join("\n");
	expect(
		rows.some((row) => TITLE.test(row)),
		shown,
	).toBe(false);
	const indices = rows.flatMap((row, i) => (/\b(?:ctx )?\d+(\.\d+)?%\/\S+ \(auto\)/.test(row) ? [i] : []));
	expect(indices, shown).toHaveLength(1);
	expect(rows.slice((indices[0] ?? -1) + 1).join("\n"), shown).toContain(STATUS);
}

/** A visible chart needs a titled header, multiple numeric y ticks and its zero axis. */
export function chart(shown: string): void {
	expect(shown).toMatch(/Tokens per (hour|day|\d+ days|week)/);
	expect(shown.split("\n").filter((row) => /^\s*\d+(\.\d)?[kMB]? ┤/.test(row)).length, shown).toBeGreaterThanOrEqual(2);
	expect(
		shown.split("\n").some((row) => /^\s*0 ┼/.test(row)),
		shown,
	).toBe(true);
}

/** Preserve exact accounting, including the source's rejection of rounded/widened totals. */
export async function selectTotal(fixture: TerminalFixture, tokens: number): Promise<void> {
	for (let range = 0; range < 6; range++) {
		await fixture.key("k".repeat(60));
		if (new RegExp(`Total tokens: ${tokens}(?![\\d.,kMB])`).test(layout(fixture))) return;
		await fixture.key("r");
	}
	throw new Error(`No range reports exactly ${tokens} tokens\n${layout(fixture)}`);
}

/** Select by label rather than coupling the test to filter order. */
export async function selectFilter(fixture: TerminalFixture, label: string): Promise<string> {
	for (let i = 0; i < 12; i++) {
		const shown = layout(fixture);
		if (new RegExp(`filter:\\s*${label}(?=\\s|$)`).test(shown)) return shown;
		await fixture.key("m");
	}
	throw new Error(`Missing filter ${label}`);
}

/** Every port of each plotted glyph must meet the opposite port, except open left/right edges. */
export function danglingPorts(rows: string[]): string[] {
	const ports: Record<string, string> = {
		"─": "LR",
		"│": "UD",
		"╭": "RD",
		"╮": "LD",
		"╰": "UR",
		"╯": "LU",
		"┴": "LRU",
		"┬": "LRD",
		"├": "UDR",
		"┤": "UDL",
		"┼": "LRUD",
	};
	const opposite: Record<string, [number, number, string]> = {
		L: [0, -1, "R"],
		R: [0, 1, "L"],
		U: [-1, 0, "D"],
		D: [1, 0, "U"],
	};
	const width = Math.max(0, ...rows.map((row) => row.length));
	const out: string[] = [];
	for (const [y, row] of rows.entries())
		for (const [x, ch] of [...row].entries())
			for (const port of ports[ch] ?? "") {
				const offset = opposite[port];
				if (!offset) throw new Error(`Unknown port ${port}`);
				if ((port === "L" && x === 0) || (port === "R" && x === width - 1)) continue;
				const [dy, dx, need] = offset;
				if (!(ports[rows[y + dy]?.[x + dx] ?? ""] ?? "").includes(need)) out.push(`${y}:${x} ${ch} ${port}`);
			}
	return out;
}

/** Future weekdays have trimmed blank cells: the widest weekday is the actual heatmap extent. */
export function widestHeatmapRow(rows: string[]): string {
	const weekday = rows.filter((row) => row.length > 5 && /^[·░▒▓█ ]+$/.test(row.slice(5)));
	const widest = weekday.sort((a, b) => b.length - a.length)[0];
	if (!widest) throw new Error("Missing heatmap weekdays");
	return widest;
}
