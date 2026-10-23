import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { freshnessLines, timestampLabel } from "../../src/stats/freshness.ts";
import { exportStats, importStats, loadCombined } from "../../src/stats/snapshot.ts";

const now = Date.parse("2026-10-22T12:00:00Z");
it("distinguishes old, absent, invalid and future producer clocks without inventing freshness", () => {
	for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 8640000000000001])
		expect(timestampLabel(value, now)).toBe("unknown");
	expect(timestampLabel(now, now)).toContain("<1m ago");
	expect(timestampLabel(now - 10 * 86400000, now)).toContain("10d ago");
	expect(timestampLabel(now + 1, now)).toContain("future; clock skew");
	expect(freshnessLines({ machines: 2, remoteMachines: 1, incomplete: false, problems: [] }, now).join("\n")).toContain(
		"Per-machine freshness unknown",
	);
});

it("keeps v1 producer times across new imports, corrupt/missing snapshots and last-good retention", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-freshness-"));
	const producer = join(root, "producer");
	const viewer = join(root, "viewer");
	const repo = join(root, "repo");
	try {
		vi.spyOn(Date, "now").mockReturnValue(now - 10 * 86400000);
		const exported = await exportStats(producer, repo);
		vi.mocked(Date.now).mockReturnValue(now);
		await importStats(viewer, repo);
		let loaded = await loadCombined(viewer);
		expect(loaded.coverage.importedAt).toBe(now);
		expect(loaded.coverage.sources?.find((s) => !s.local)?.exportedAt).toBe(now - 10 * 86400000);
		let text = freshnessLines(loaded.coverage, now).join("\n");
		expect(text).toContain("Viewer last import: 2026-10-22T12:00:00.000Z (<1m ago)");
		expect(text).toContain("Producer exported: 2026-10-12T12:00:00.000Z (10d ago)");
		expect(text).toContain(exported.machineId);
		expect(text).toContain("Local scan complete at opening");
		const path = join(exported.snapshotDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		for (const exportedAt of [undefined, "bad", 0]) {
			writeFileSync(path, JSON.stringify({ ...manifest, exportedAt }));
			expect((await importStats(viewer, repo)).problems).toHaveLength(1);
			loaded = await loadCombined(viewer);
			text = freshnessLines(loaded.coverage, now).join("\n");
			expect(text).toContain("10d ago");
			expect(text).toContain("retained last-good snapshot");
		}
		const unknownViewer = join(root, "unknown-viewer");
		await importStats(unknownViewer, repo);
		text = freshnessLines((await loadCombined(unknownViewer)).coverage, now).join("\n");
		expect(text).toContain(exported.machineId);
		expect(text).toContain("Producer exported: unknown");
		expect(text).toContain("no last-good snapshot");
		rmSync(exported.snapshotDir, { recursive: true });
		await importStats(viewer, repo);
		expect(freshnessLines((await loadCombined(viewer)).coverage, now).join("\n")).toContain(
			"retained last-good snapshot",
		);
	} finally {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	}
});

it("sanitizes labels and disambiguates duplicate labels with installation UUIDs", () => {
	const lines = freshnessLines(
		{
			machines: 2,
			remoteMachines: 1,
			incomplete: false,
			problems: [],
			sources: [
				{
					machineId: "11111111-1111-4111-8111-111111111111",
					label: "Pi machine\u001b[31m",
					local: true,
					incomplete: true,
				},
				{
					machineId: "22222222-2222-4222-8222-222222222222",
					label: "Pi machine\u001b[31m",
					local: false,
					incomplete: false,
					exportedAt: now + 60000,
				},
			],
		},
		now,
	).join("\n");
	expect(lines).not.toContain("\u001b");
	expect(lines).toContain("11111111-1111-4111-8111-111111111111");
	expect(lines).toContain("22222222-2222-4222-8222-222222222222");
	expect(lines).toContain("Local scan incomplete");
	expect(lines).toContain("future; clock skew");
});
