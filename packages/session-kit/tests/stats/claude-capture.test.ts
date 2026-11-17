import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHarnesses } from "../../src/stats/harness/index.ts";

let home: string;
const now = Date.now();
const observed = now / 1000 - 60;
const reset = Math.floor(now / 1000) + 3600;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "claude-capture-"));
	mkdirSync(join(home, ".claude"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const capture = (value: unknown) => writeFileSync(join(home, ".claude", "rate-limits.json"), JSON.stringify(value));
const load = () =>
	loadHarnesses({ home, now, harnesses: ["claude"], cache: join(home, "cache.json"), salt: "fixture" });

describe("Claude statusLine capture through the injected-root loader", () => {
	it.each([
		null,
		[],
		1,
		"bad",
		{},
		{ observed_at: observed },
		{ observed_at: now / 1000 + 1, rate_limits: {} },
		{ observed_at: "123", rate_limits: {} },
		{ observed_at: 0, rate_limits: {} },
		{ observed_at: -1, rate_limits: {} },
	])("ignores invalid optional documents: %j", async (doc) => {
		capture(doc);
		expect((await load()).claude).toMatchObject({ quota: [], problems: [] });
	});

	it.each([
		null,
		[],
		1,
		"bad",
		{},
		{ used_percentage: "23", resets_at: reset },
		{ used_percentage: -1, resets_at: reset },
		{ used_percentage: 101, resets_at: reset },
		{ used_percentage: 23, resets_at: "123" },
		{ used_percentage: 23, resets_at: 0 },
		{ used_percentage: 23, resets_at: -1 },
		{ used_percentage: 23, resets_at: 1.5 },
		{ used_percentage: 23, resets_at: Number.MAX_SAFE_INTEGER },
	])("keeps a valid sibling but never invents an absent/invalid window: %j", async (window) => {
		capture({
			observed_at: observed,
			rate_limits: { five_hour: window, seven_day: { used_percentage: 0, resets_at: reset } },
		});
		const { claude } = await load();
		expect(claude.quota).toHaveLength(1);
		expect(claude.quota[0]).toMatchObject({ window: "7d", usedPercent: 0 });
		expect(claude.problems).toEqual([]);
	});

	it("tolerates missing, malformed, wrong-type, oversized and unreadable optional files", async () => {
		const path = join(home, ".claude", "rate-limits.json");
		expect((await load()).claude.quota).toEqual([]);
		for (const bytes of ["{", "1e999", JSON.stringify({ observed_at: 1e300 }), " ".repeat(65_537)]) {
			writeFileSync(path, bytes);
			expect((await load()).claude).toMatchObject({ quota: [], problems: [] });
		}
		rmSync(path);
		mkdirSync(path);
		expect((await load()).claude.quota).toEqual([]);
		rmSync(path, { recursive: true });
		symlinkSync(path, path);
		expect((await load()).claude).toMatchObject({ quota: [], problems: [] });
		rmSync(path);
		capture({ observed_at: observed, rate_limits: { five_hour: { used_percentage: 50, resets_at: reset } } });
		chmodSync(path, 0);
		try {
			expect((await load()).claude.quota).toEqual([]);
		} finally {
			chmodSync(path, 0o600);
		}
	});

	it("honors an explicit config root instead of the injected home default", async () => {
		const root = join(home, "custom");
		mkdirSync(root);
		writeFileSync(
			join(root, "rate-limits.json"),
			JSON.stringify({ observed_at: observed, rate_limits: { five_hour: { used_percentage: 100, resets_at: reset } } }),
		);
		const scans = await loadHarnesses({
			home,
			now,
			env: { CLAUDE_CONFIG_DIR: root },
			harnesses: ["claude"],
			cache: join(home, "cache.json"),
			salt: "fixture",
		});
		expect(scans.claude.quota[0]).toMatchObject({ window: "5h", usedPercent: 100 });
		expect((await load()).claude.quota).toEqual([]);
	});
	it("projects only named quota windows into canonical observations", async () => {
		capture({
			observed_at: observed,
			rate_limits: {
				five_hour: { used_percentage: 23.5, resets_at: reset, private: "discard" },
				seven_day: { used_percentage: 41.2, resets_at: reset + 86400 },
				unknown: { used_percentage: 100, resets_at: reset },
			},
			session_id: "discard",
		});
		const { claude } = await load();
		expect(claude.problems).toEqual([]);
		expect(claude.quota).toEqual([
			{
				harness: "claude",
				provider: "anthropic",
				limitId: "anthropic",
				window: "5h",
				usedPercent: 23.5,
				resetAt: reset * 1000,
				durationMs: 18_000_000,
				observedAt: observed * 1000,
				planType: null,
				account: "",
			},
			{
				harness: "claude",
				provider: "anthropic",
				limitId: "anthropic",
				window: "7d",
				usedPercent: 41.2,
				resetAt: (reset + 86400) * 1000,
				durationMs: 604_800_000,
				observedAt: observed * 1000,
				planType: null,
				account: "",
			},
		]);
	});
});
