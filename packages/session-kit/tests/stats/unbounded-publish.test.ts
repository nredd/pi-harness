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
/** More than 366 days past `AHEAD`, so a manifest published there is an implausible watermark for it. */
const FAR = Date.parse("2028-11-20T12:00:00Z");
const UNBOUNDED = (reason: string, at = WALL): string =>
	`no readable published manifest bounds this export (${reason}); published at ${new Date(at).toISOString()} ` +
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

/** Make `readFile` fail with `code` for exactly `path`, as a permission denial would. */
async function deny(path: string, code = "EACCES"): Promise<void> {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(readFile).mockImplementation(async (file, options) => {
		if (file === path)
			throw Object.assign(new Error(`${code}: denied, open '${path}'`), { code, syscall: "open", path });
		return actual.readFile(file, options);
	});
}

/** Publish at the clock-ahead watermark, damage the outbox as `damage` says, then export at `clock`. */
async function exportAfter(damage: (snapshotDir: string) => unknown, options: ExportOptions = {}, clock = WALL) {
	const published = await exportStats(agent, out);
	await damage(published.snapshotDir);
	vi.mocked(Date.now).mockReturnValue(clock);
	return { published, next: await exportStats(agent, out, undefined, options) };
}

it.each([false, true])(
	"warns that a corrupt manifest leaves the export unbounded (replace %s)",
	async (replaceHarnesses) => {
		const viewer = join(root, "viewer");
		const { published, next } = await exportAfter(
			async (snapshotDir) => {
				expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
				writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
			},
			{ replaceHarnesses },
		);
		expect(next.warnings?.[0]).toBe(UNBOUNDED("manifest.json unreadable"));
		expect(manifestOf(published.snapshotDir).exportedAt).toBe(WALL);
		// The publication itself is complete: a viewer holding nothing of this machine imports it.
		expect(await importStats(join(root, "fresh"), out)).toMatchObject({ imported: 1, problems: [] });
		// The gap the warning names: a viewer holding the later snapshot keeps it. The importer rejects the
		// older `exportedAt` ("Older machine snapshot") under its per-machine catch-all problem.
		expect(await importStats(viewer, out)).toMatchObject({
			imported: 0,
			retained: 1,
			problems: [`Incomplete snapshot ${published.machineId}`],
		});
	},
);

it("still warns but loses nothing when the clock is past the lost watermark", async () => {
	const viewer = join(root, "viewer");
	const { next } = await exportAfter(
		async (snapshotDir) => {
			expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
			writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
		},
		{},
		AHEAD + 1000,
	);
	expect(next.warnings?.[0]).toBe(UNBOUNDED("manifest.json unreadable", AHEAD + 1000));
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});

it("publishes a far-future clock over a corrupt manifest, which then refuses honest exports", async () => {
	// Predates the warning: with no readable manifest neither the later-month nor the implausible-watermark
	// refusal has a watermark to compare, so this clock's instant is published and bounds later exports.
	const { published, next } = await exportAfter(
		(snapshotDir) => writeFileSync(join(snapshotDir, "manifest.json"), "corrupt"),
		{},
		FAR,
	);
	expect(next.warnings?.[0]).toBe(UNBOUNDED("manifest.json unreadable", FAR));
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(FAR);
	vi.mocked(Date.now).mockReturnValue(AHEAD);
	await expect(exportStats(agent, out)).rejects.toMatchObject({ refusal: "watermark-ahead" });
});

it("warns that a denied manifest leaves a replacement unbounded", async () => {
	const { next } = await exportAfter((snapshotDir) => deny(join(snapshotDir, "manifest.json")), {
		replaceHarnesses: true,
	});
	expect(next.warnings?.[0]).toBe(UNBOUNDED("EACCES on manifest.json"));
});

it("refuses a replacement over a denied shard instead of blaming the readable manifest", async () => {
	const published = await exportStats(agent, out);
	const [shard] = manifestOf(published.snapshotDir).shards;
	await deny(join(published.snapshotDir, shard?.file ?? "missing"));
	// A different scan, so publishing never rereads the denied shard as its own existing output.
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: WALL,
		lines: [assistantLine({ ms: WALL, provider: "physical", model: "fixture", input: 2 })],
	});
	vi.mocked(Date.now).mockReturnValue(WALL);
	await expect(exportStats(agent, out, undefined, { replaceHarnesses: true })).rejects.toMatchObject({
		code: "EACCES",
	});
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
});

it.each([
	{ bookkeeping: true, label: "with its bookkeeping" },
	{ bookkeeping: false, label: "with only its shard files" },
])("warns that a missing manifest leaves a replacement unbounded $label", async ({ bookkeeping }) => {
	const { published, next } = await exportAfter(
		(snapshotDir) => {
			rmSync(join(snapshotDir, "manifest.json"));
			if (!bookkeeping) rmSync(outboxStatePath(agent, snapshotDir));
		},
		{ replaceHarnesses: true },
	);
	expect(next.warnings?.[0]).toBe(UNBOUNDED("manifest.json missing"));
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(WALL);
});

it.each([
	{
		refusal: "history-unreadable",
		names: "EACCES on manifest.json",
		damage: (snapshotDir: string) => deny(join(snapshotDir, "manifest.json")),
	},
	{
		refusal: "manifest-missing",
		names: "manifest is missing",
		damage: (snapshotDir: string) => rmSync(join(snapshotDir, "manifest.json")),
	},
])("still refuses an ordinary export over a $refusal manifest", async ({ refusal, names, damage }) => {
	await expect(exportAfter(damage)).rejects.toMatchObject({ refusal, message: expect.stringContaining(names) });
});

it("keeps the bound once manifest.json is restored from the sync checkout", async () => {
	const published = await exportStats(agent, out);
	const path = join(published.snapshotDir, "manifest.json");
	const saved = readFileSync(path);
	writeFileSync(path, "corrupt");
	writeFileSync(path, saved);
	vi.mocked(Date.now).mockReturnValue(WALL);
	const next = await exportStats(agent, out);
	expect(next.warnings?.some((warning) => warning.startsWith("no readable published manifest"))).toBe(false);
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD + 1);
});

it("does not warn when nothing was published or a readable manifest bounds the export", async () => {
	const published = await exportStats(agent, out);
	expect(published.warnings).toBeUndefined();
	// A readable manifest bounds a replacement too, even over a missing shard.
	const [shard] = manifestOf(published.snapshotDir).shards;
	rmSync(join(published.snapshotDir, shard?.file ?? "missing"));
	vi.mocked(Date.now).mockReturnValue(AHEAD + 1000);
	const replaced = await exportStats(agent, out, undefined, { replaceHarnesses: true });
	expect(replaced.warnings).toBeUndefined();
	// An outbox that never published anything is a first export, not an unbounded one.
	rmSync(outboxStatePath(agent, published.snapshotDir));
	rmSync(out, { recursive: true });
	expect((await exportStats(agent, out)).warnings).toBeUndefined();
});
