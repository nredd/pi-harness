import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseColor } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatsView, summary } from "../../src/stats/component.ts";
import { quotaRows } from "../../src/stats/quota.ts";
import { loadCombined } from "../../src/stats/snapshot.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

let dir: string;
let root: string;
const cli = fileURLToPath(new URL("../../dist/pi-stats-export.mjs", import.meta.url));
const now = Date.now();
const observed = now / 1000 - 1200;
const reset = Math.floor(now / 1000) + 3600;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "capture-export-"));
	root = seedHarnessHome(join(dir, "home")).claude;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Execute the distributed no-network CLI in an isolated home, never the operator's environment. */
function run(...args: string[]): string {
	const result = spawnSync(process.execPath, [cli, ...args], {
		env: { PATH: process.env.PATH, HOME: join(dir, "home"), PI_OFFLINE: "1" },
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}
function publish(): string {
	return run(
		"export",
		"--agent-dir",
		join(dir, "producer"),
		"--output",
		join(dir, "repo"),
		"--harness",
		"claude",
		"--claude-dir",
		root,
	);
}
async function readback() {
	run("import", "--agent-dir", join(dir, "viewer"), "--input", join(dir, "repo"));
	return loadCombined(join(dir, "viewer"), undefined, now, { home: join(dir, "viewer-home") });
}
function capture(value: unknown) {
	writeFileSync(join(root, "rate-limits.json"), JSON.stringify(value));
}

/** Render the same canonical observations as the print display, without a second UI data shape. */
function view(combined: Awaited<ReturnType<typeof readback>>, at = now): string {
	const theme = {
		fg: (_: string, s: string) => s,
		bg: (_: string, s: string) => s,
		bold: (s: string) => s,
		style: (s: string) => s,
		colors: { accent: parseColor("#426a79") },
	};
	return new StatsView({
		calls: combined.calls,
		sessions: combined.sessions,
		quota: combined.quota,
		theme: theme as never,
		rows: () => 60,
		now: at,
		requestRender() {},
		onClose() {},
	})
		.render(160)
		.join("\n");
}

describe("captured Claude quota across CLI publication and stats readback", () => {
	it("drops reset timestamps outside the canonical snapshot bound without breaking export", async () => {
		capture({
			observed_at: observed,
			rate_limits: {
				five_hour: { used_percentage: 99, resets_at: 8_700_000_000_000 },
				seven_day: { used_percentage: 41.2, resets_at: 8_640_000_000_000 },
			},
		});
		publish();
		const combined = await readback();
		expect(combined.quota).toHaveLength(1);
		expect(combined.quota[0]).toMatchObject({ window: "7d", resetAt: 8_640_000_000_000_000 });
	});
	it("exports only allowlisted observations and preserves canonical stale/reset UI behavior", async () => {
		capture({
			observed_at: observed,
			private: "PRIVATE_SENTINEL",
			rate_limits: {
				five_hour: { used_percentage: 23.5, resets_at: reset, path: "PRIVATE_SENTINEL" },
				seven_day: { used_percentage: 41.2, resets_at: reset + 86400 },
				account: "PRIVATE_SENTINEL",
				unknown: { used_percentage: 99, resets_at: reset },
			},
		});
		const result = JSON.parse(publish());
		const combined = await readback();
		expect(combined.quota).toHaveLength(2);
		expect(quotaRows(combined.quota, now).map((r) => [r.label, r.old])).toEqual([
			["anthropic 5h", true],
			["anthropic 7d", true],
		]);
		expect(summary(combined.calls, combined.quota, now)).toContain("23.5% used");
		expect(view(combined)).toContain("23.5%");
		const expiredAt = (reset + 60) * 1000;
		expect(view(combined, expiredAt)).toContain("reset 1m ago, no newer reading");
		expect(view(combined, expiredAt)).not.toContain("23.5%");
		expect(summary(combined.calls, combined.quota, expiredAt)).not.toContain("23.5%");
		expect(quotaRows(combined.quota, (reset + 18_001) * 1000).map((r) => r.label)).toEqual(["anthropic 7d"]);
		const manifest = JSON.parse(readFileSync(join(result.snapshotDir, "manifest.json"), "utf8"));
		const published = manifest.shards
			.map((s: { file: string }) => readFileSync(join(result.snapshotDir, s.file), "utf8"))
			.join("");
		expect(published).not.toContain("PRIVATE_SENTINEL");
		expect(published).not.toContain(root);
		expect(published).not.toContain("used_percentage");
		expect(combined.quota.every((q) => q.account === "" && q.planType === null)).toBe(true);
	});

	it("renders already expired producer readings as unknown, not current usage", async () => {
		capture({
			observed_at: observed,
			rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.floor(now / 1000) - 60 } },
		});
		publish();
		const combined = await readback();
		expect(view(combined)).toContain("no newer reading");
		expect(view(combined)).not.toContain("99%");
	});

	it("replaces a partial reading without inventing a missing window and tolerates a broken optional capture", async () => {
		capture({ observed_at: observed, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: reset } } });
		publish();
		const partial = await readback();
		expect(partial.quota.map((q) => q.window)).toEqual(["5h"]);
		expect(view(partial)).not.toContain("anthropic 7d");
		writeFileSync(join(root, "rate-limits.json"), "{invalid");
		const result = JSON.parse(publish());
		expect(result.harnesses.claude).toEqual({ found: true, problems: [] });
		const broken = await readback();
		expect(broken.calls).toEqual(partial.calls);
		expect(broken.calls.length).toBeGreaterThan(0);
		expect(broken.quota).toEqual([]);
		expect(view(broken)).toContain("no local reading");
	});

	it("uses the same capture in the local stats loader without CLI publication", async () => {
		capture({ observed_at: observed, rate_limits: { seven_day: { used_percentage: 41.2, resets_at: reset } } });
		const local = await loadCombined(join(dir, "local-agent"), undefined, now, {
			home: join(dir, "home"),
			harnesses: ["claude"],
		});
		expect(local.quota).toHaveLength(1);
		expect(view(local)).toContain("41.2%");
		const beforeObservation = await loadCombined(join(dir, "local-agent"), undefined, now - 1201_000, {
			home: join(dir, "home"),
			harnesses: ["claude"],
		});
		expect(beforeObservation.quota).toEqual([]);
	});
});
