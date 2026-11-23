import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ExportOptions, exportStats, importStats, type Manifest } from "../../src/stats/snapshot.ts";
import { assistantLine, outboxStatePath, sessionFile } from "../fixtures/stats/fixtures.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});

/** UTC instants in one month, so no fixture depends on the host time zone or crosses a month. */
const AHEAD = Date.parse("2026-11-20T12:00:00Z");
const WALL = Date.parse("2026-11-02T12:00:00Z");
const UNBOUNDED = (reason: string): string =>
	`no readable published manifest bounds this export (${reason}); published at ${new Date(WALL).toISOString()} ` +
	"by this clock, so viewers holding a later snapshot of this machine keep it until this clock passes it";

let root: string;
let agent: string;
let out: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-unbounded-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	vi.spyOn(Date, "now").mockReturnValue(AHEAD);
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: WALL,
		lines: [assistantLine({ ms: WALL, provider: "physical", model: "fixture", input: 1 })],
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(readFile).mockRestore();
});

const manifestOf = (snapshotDir: string): Manifest =>
	JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")) as Manifest;

/** Publish at the clock-ahead watermark, damage the outbox as `damage` says, then export behind it. */
async function behindAfter(damage: (snapshotDir: string) => unknown, options: ExportOptions = {}) {
	const first = await exportStats(agent, out);
	await damage(first.snapshotDir);
	vi.mocked(Date.now).mockReturnValue(WALL);
	return { first, second: await exportStats(agent, out, undefined, options) };
}

it.each([false, true])(
	"warns that a corrupt manifest leaves the export unbounded (replace %s)",
	async (replaceHarnesses) => {
		const viewer = join(root, "viewer");
		const { first, second } = await behindAfter(
			async (snapshotDir) => {
				expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
				writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
			},
			{ replaceHarnesses },
		);
		expect(second.warnings?.[0]).toBe(UNBOUNDED("manifest.json unreadable"));
		expect(manifestOf(first.snapshotDir).exportedAt).toBe(WALL);
		// The gap the warning names: a viewer holding the later snapshot keeps it and rejects this one.
		expect(await importStats(viewer, out)).toMatchObject({
			imported: 0,
			problems: [`Incomplete snapshot ${first.machineId}`],
		});
	},
);

it("warns that a denied manifest leaves a replacement unbounded", async () => {
	const failure = (path: string) =>
		Object.assign(new Error(`EACCES: denied, open '${path}'`), { code: "EACCES", syscall: "open", path });
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const { second } = await behindAfter(
		(snapshotDir) => {
			const path = join(snapshotDir, "manifest.json");
			vi.mocked(readFile).mockImplementation(async (file, options) => {
				if (file === path) throw failure(path);
				return actual.readFile(file, options);
			});
		},
		{ replaceHarnesses: true },
	);
	expect(second.warnings?.[0]).toBe(UNBOUNDED("EACCES on manifest.json"));
});

it.each([
	{ bookkeeping: true, label: "with its bookkeeping" },
	{ bookkeeping: false, label: "with only its shard files" },
])("warns that a missing manifest leaves a replacement unbounded $label", async ({ bookkeeping }) => {
	const { first, second } = await behindAfter(
		(snapshotDir) => {
			rmSync(join(snapshotDir, "manifest.json"));
			if (!bookkeeping) rmSync(outboxStatePath(agent, snapshotDir));
		},
		{ replaceHarnesses: true },
	);
	expect(second.warnings?.[0]).toBe(UNBOUNDED("manifest.json missing"));
	expect(manifestOf(first.snapshotDir).exportedAt).toBe(WALL);
});

it("does not warn when nothing was published or a readable manifest bounds the export", async () => {
	const first = await exportStats(agent, out);
	expect(first.warnings).toBeUndefined();
	// A readable manifest bounds a replacement too, even over a missing shard.
	const [shard] = manifestOf(first.snapshotDir).shards;
	rmSync(join(first.snapshotDir, shard?.file ?? "missing"));
	vi.mocked(Date.now).mockReturnValue(AHEAD + 1000);
	const replaced = await exportStats(agent, out, undefined, { replaceHarnesses: true });
	expect(replaced.warnings).toBeUndefined();
	// An outbox that never published anything is a first export, not an unbounded one.
	rmSync(outboxStatePath(agent, first.snapshotDir));
	rmSync(out, { recursive: true });
	expect((await exportStats(agent, out)).warnings).toBeUndefined();
});
