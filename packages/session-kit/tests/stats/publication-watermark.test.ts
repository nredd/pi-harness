import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exportStats, importStats, type Manifest } from "../../src/stats/snapshot.ts";
import { assistantLine, outboxStatePath, outboxWatermarkPath, sessionFile } from "../fixtures/stats/fixtures.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});

/** UTC instants in one month, so no fixture depends on the host time zone or crosses a month. */
const AHEAD = Date.parse("2026-11-20T12:00:00Z");
const WALL = Date.parse("2026-11-02T12:00:00Z");
/** More than 366 days past `AHEAD`. */
const FAR = Date.parse("2028-11-20T12:00:00Z");
const LAST_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

let root: string;
let agent: string;
let out: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-watermark-", onTestFinished);
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
	vi.mocked(rename).mockRestore();
});

const manifestOf = (snapshotDir: string): Manifest =>
	JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")) as Manifest;
const unboundedWarning = (warnings: string[] | undefined): boolean =>
	(warnings ?? []).some((warning) => warning.startsWith("no readable published manifest"));

/** Make `readFile` fail with EACCES for exactly `path`, as a permission denial would. */
async function deny(path: string): Promise<void> {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(readFile).mockImplementation(async (file, options) => {
		if (file === path)
			throw Object.assign(new Error(`EACCES: denied, open '${path}'`), { code: "EACCES", syscall: "open", path });
		return actual.readFile(file, options);
	});
}

it("records the published exportedAt beside the outbox bookkeeping", async () => {
	const published = await exportStats(agent, out);
	expect(JSON.parse(readFileSync(outboxWatermarkPath(agent, published.snapshotDir), "utf8"))).toEqual({
		version: 1,
		exportedAt: AHEAD,
	});
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
});

it.each([
	{ label: "a corrupt manifest", replaceHarnesses: false, damage: "corrupt" },
	{ label: "a corrupt manifest under --replace-harnesses", replaceHarnesses: true, damage: "corrupt" },
	{ label: "a denied manifest under --replace-harnesses", replaceHarnesses: true, damage: "deny" },
	{ label: "a missing manifest under --replace-harnesses", replaceHarnesses: true, damage: "remove" },
])("follows the recorded watermark over $label", async ({ replaceHarnesses, damage }) => {
	const viewer = join(root, "viewer");
	const published = await exportStats(agent, out);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const manifest = join(published.snapshotDir, "manifest.json");
	if (damage === "corrupt") writeFileSync(manifest, "corrupt");
	else if (damage === "deny") await deny(manifest);
	else rmSync(manifest);
	vi.mocked(Date.now).mockReturnValue(WALL);
	const next = await exportStats(agent, out, undefined, { replaceHarnesses });
	vi.mocked(readFile).mockRestore();
	expect(unboundedWarning(next.warnings)).toBe(false);
	expect(next.warnings?.[0]).toMatch(/^clock is behind the last published export /);
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD + 1);
	// The viewer holding the earlier snapshot accepts this one as newer: no gap to wait out.
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});

it("follows the recorded watermark past a restored older manifest", async () => {
	const published = await exportStats(agent, out);
	const path = join(published.snapshotDir, "manifest.json");
	const older = readFileSync(path);
	vi.mocked(Date.now).mockReturnValue(AHEAD + 1000);
	await exportStats(agent, out);
	writeFileSync(path, older);
	vi.mocked(Date.now).mockReturnValue(WALL);
	await exportStats(agent, out);
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD + 1001);
});

it("refuses a recorded watermark more than 366 days ahead, naming its file", async () => {
	const published = await exportStats(agent, out);
	const path = outboxWatermarkPath(agent, published.snapshotDir);
	writeFileSync(path, JSON.stringify({ version: 1, exportedAt: FAR }));
	await expect(exportStats(agent, out, undefined, { replaceHarnesses: true })).rejects.toMatchObject({
		refusal: "watermark-ahead",
		message: expect.stringMatching(
			new RegExp(
				`^Recorded usage publication watermark exportedAt \\(${new Date(FAR).toISOString()}\\) is more than 366 ` +
					`days ahead .*\\(${JSON.stringify(path).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\)`,
			),
		),
	});
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
});

it.each([
	{ label: "not JSON", contents: "corrupt" },
	{ label: "an extra field", contents: JSON.stringify({ version: 1, exportedAt: AHEAD, extra: 1 }) },
	{ label: "another version", contents: JSON.stringify({ version: 2, exportedAt: AHEAD }) },
	{ label: "a negative instant", contents: JSON.stringify({ version: 1, exportedAt: -1 }) },
	{ label: "a zero instant", contents: JSON.stringify({ version: 1, exportedAt: 0 }) },
	{ label: "an instant past year 9999", contents: JSON.stringify({ version: 1, exportedAt: LAST_ISO_MS + 1 }) },
])("supplies no bound from a recorded watermark with $label, as if it were lost", async ({ contents }) => {
	const published = await exportStats(agent, out);
	writeFileSync(outboxWatermarkPath(agent, published.snapshotDir), contents);
	writeFileSync(join(published.snapshotDir, "manifest.json"), "corrupt");
	vi.mocked(Date.now).mockReturnValue(WALL);
	const next = await exportStats(agent, out);
	expect(unboundedWarning(next.warnings)).toBe(true);
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(WALL);
	// The wall-clock publication recorded a fresh watermark over the invalid one.
	expect(JSON.parse(readFileSync(outboxWatermarkPath(agent, published.snapshotDir), "utf8"))).toEqual({
		version: 1,
		exportedAt: WALL,
	});
});

it("fails the export with nothing published when the watermark cannot be recorded", async () => {
	const published = await exportStats(agent, out);
	const path = outboxWatermarkPath(agent, published.snapshotDir);
	rmSync(path);
	// A directory in its place: unreadable as a watermark, and no file can be renamed over it.
	mkdirSync(join(path, "blocked"), { recursive: true });
	vi.mocked(Date.now).mockReturnValue(AHEAD + 1000);
	await expect(exportStats(agent, out)).rejects.toThrow();
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
});

it("leaves an unpublished exportedAt recorded if manifest rename fails, refusing watermark-ahead after a jumped clock is fixed", async () => {
	const published = await exportStats(agent, out);
	const manifestPath = join(published.snapshotDir, "manifest.json");
	const watermarkPath = outboxWatermarkPath(agent, published.snapshotDir);
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(Date.now).mockReturnValue(FAR);
	vi.mocked(rename).mockImplementation(async (from, to) => {
		if (to === manifestPath) throw new Error("manifest rename failed");
		await actual.rename(from, to);
	});
	await expect(exportStats(agent, out)).rejects.toThrow("manifest rename failed");
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
	expect(JSON.parse(readFileSync(watermarkPath, "utf8"))).toEqual({ version: 1, exportedAt: FAR });

	vi.mocked(rename).mockRestore();
	vi.mocked(Date.now).mockReturnValue(AHEAD);
	await expect(exportStats(agent, out, undefined, { replaceHarnesses: true })).rejects.toMatchObject({
		refusal: "watermark-ahead",
		message: expect.stringMatching(/^Recorded usage publication watermark exportedAt /),
	});
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD);
});

it.each(["corrupt", "restored"] as const)(
	"does not bound past an older kit's unrecorded later export or warn over a %s manifest",
	async (damage) => {
		const viewer = join(root, "viewer");
		vi.mocked(Date.now).mockReturnValue(WALL);
		const first = await exportStats(agent, out);
		const manifestPath = join(first.snapshotDir, "manifest.json");
		const recordedManifest = readFileSync(manifestPath);
		// Older kit publishes at AHEAD: updates manifest.json without advancing .published.json past WALL.
		writeFileSync(
			manifestPath,
			JSON.stringify({ ...manifestOf(first.snapshotDir), exportedAt: AHEAD, lastGoodAt: { pi: AHEAD } }),
		);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });

		if (damage === "corrupt") writeFileSync(manifestPath, "corrupt");
		else writeFileSync(manifestPath, recordedManifest);
		const next = await exportStats(agent, out);
		expect(unboundedWarning(next.warnings)).toBe(false);
		expect(manifestOf(first.snapshotDir).exportedAt).toBe(WALL + 1);
		expect(await importStats(viewer, out)).toMatchObject({
			imported: 0,
			retained: 1,
			problems: [`Incomplete snapshot ${first.machineId}`],
		});
	},
);

it("keeps the bound across a real outbox move when rebound (retaining the greater valid watermark), and warns when not", async () => {
	const viewer = join(root, "viewer");
	const published = await exportStats(agent, out);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });

	// Moving the checkout without rebinding rekeys both files: ordinary export lacks a recorded harness set,
	// and --replace-harnesses publishes unbounded by the wall clock.
	const unrebound = join(root, "unrebound");
	renameSync(out, unrebound);
	const unreboundSnapshot = join(unrebound, "machines", published.machineId);
	writeFileSync(join(unreboundSnapshot, "manifest.json"), "corrupt");
	vi.mocked(Date.now).mockReturnValue(WALL);
	await expect(exportStats(agent, unrebound)).rejects.toMatchObject({ refusal: "harness-set-unknown" });
	const missed = await exportStats(agent, unrebound, undefined, { replaceHarnesses: true });
	expect(unboundedWarning(missed.warnings)).toBe(true);
	expect(manifestOf(unreboundSnapshot).exportedAt).toBe(WALL);

	// Rebinding state + watermark to a fresh destination key preserves the bound across a real move.
	vi.mocked(Date.now).mockReturnValue(AHEAD);
	await exportStats(agent, unrebound);
	const rebound = join(root, "rebound");
	const oldState = outboxStatePath(agent, unreboundSnapshot);
	const oldWatermark = outboxWatermarkPath(agent, unreboundSnapshot);
	renameSync(unrebound, rebound);
	const reboundSnapshot = join(rebound, "machines", published.machineId);
	renameSync(oldState, outboxStatePath(agent, reboundSnapshot));
	renameSync(oldWatermark, outboxWatermarkPath(agent, reboundSnapshot));
	writeFileSync(join(reboundSnapshot, "manifest.json"), "corrupt");
	vi.mocked(Date.now).mockReturnValue(WALL);
	const kept = await exportStats(agent, rebound);
	expect(unboundedWarning(kept.warnings)).toBe(false);
	expect(manifestOf(reboundSnapshot).exportedAt).toBe(AHEAD + 1);
	expect(await importStats(viewer, rebound)).toMatchObject({ imported: 1, problems: [] });

	// Moving back onto a key that already holds a newer valid watermark retains the greater exportedAt.
	mkdirSync(join(out, "machines", published.machineId), { recursive: true });
	const destState = outboxStatePath(agent, published.snapshotDir);
	const destWatermark = outboxWatermarkPath(agent, published.snapshotDir);
	writeFileSync(destWatermark, JSON.stringify({ version: 1, exportedAt: AHEAD + 500 }));
	rmSync(out, { recursive: true });
	const srcState = outboxStatePath(agent, reboundSnapshot);
	const srcWatermark = outboxWatermarkPath(agent, reboundSnapshot);
	renameSync(rebound, out);
	renameSync(srcState, destState);
	const reconciled = Math.max(
		JSON.parse(readFileSync(srcWatermark, "utf8")).exportedAt as number,
		JSON.parse(readFileSync(destWatermark, "utf8")).exportedAt as number,
	);
	writeFileSync(destWatermark, JSON.stringify({ version: 1, exportedAt: reconciled }));
	rmSync(srcWatermark);
	writeFileSync(join(published.snapshotDir, "manifest.json"), "corrupt");
	const merged = await exportStats(agent, out);
	expect(unboundedWarning(merged.warnings)).toBe(false);
	expect(manifestOf(published.snapshotDir).exportedAt).toBe(AHEAD + 501);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});
