import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodex } from "../../../src/stats/harness/codex.ts";
import { entryHash, sessionHash } from "../../../src/stats/harness/common.ts";
import type { HarnessCache } from "../../../src/stats/harness/scan.ts";
import {
	CANARY,
	codexContext,
	codexMessage,
	codexMeta,
	codexRecord,
	codexTokenCount,
	limits,
	writeLines,
} from "./fixtures.ts";

let root: string;
const rollout = (name: string, day = "2026/10/02") => join(root, "sessions", day, `rollout-${name}.jsonl`);
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psk-codex-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const weekly = { used_percent: 12.5, window_minutes: 10080, resets_at: 1_790_000_000 };
const fiveHour = { used_percent: 40, window_minutes: 300, resets_at: 1_789_000_000 };

describe("readCodex", () => {
	it("reports a missing root as not installed, silently", async () => {
		expect(await readCodex(join(root, "nope"), {})).toMatchObject({ found: false, problems: [] });
	});

	it("joins usage to the turn's model and splits the cached subset out of input", async () => {
		writeLines(rollout("a"), [
			codexMeta(),
			codexContext("turn-1", "gpt-6.1-sol"),
			codexMessage(),
			codexRecord({ turn: "turn-1", response: "resp-1" }),
			// the record may precede its turn_context, and a response may be reported twice
			codexRecord({
				turn: "turn-2",
				response: "resp-2",
				ts: "2026-10-02T10:05:00.000Z",
				usage: { input_tokens: 500, cached_input_tokens: 100, cache_write_input_tokens: 50, output_tokens: 7 },
			}),
			codexContext("turn-2", "gpt-6.1-mini"),
			codexRecord({ turn: "turn-1", response: "resp-1" }),
		]);
		const scan = await readCodex(root, {});
		expect(scan.problems).toEqual([]);
		expect(scan.calls).toHaveLength(2);
		expect(scan.calls[0]).toMatchObject({
			harness: "codex",
			provider: "openai",
			model: "gpt-6.1-sol",
			input: 200,
			output: 50,
			cacheRead: 800,
			cacheWrite: 0,
			cost: 0,
			entryId: entryHash("codex", "resp-1"),
			session: sessionHash("codex", "thread-1"),
		});
		expect(scan.calls[1]).toMatchObject({
			model: "gpt-6.1-mini",
			input: 350,
			output: 7,
			cacheRead: 100,
			cacheWrite: 50,
		});
		for (const c of scan.calls) expect(c.input + c.cacheRead + c.cacheWrite).toBe(c.model.endsWith("sol") ? 1000 : 500);
		expect(scan.sessions).toHaveLength(1);
	});

	it("falls back to a generic provider and flags spawned threads as children", async () => {
		writeLines(rollout("child"), [
			codexMeta("thread-2", { model_provider: undefined, parent_thread_id: "thread-1" }),
			codexContext(),
			codexRecord({ response: "resp-9" }),
		]);
		const scan = await readCodex(root, {});
		expect(scan.calls[0]?.provider).toBe("openai");
		expect(scan.sessionMetadata).toHaveLength(1);
		expect(scan.sessionMetadata[0]?.child).toBe(true);
		expect(scan.sessions).toEqual([]);
	});

	it("takes thread identity from the first session_meta and detects children by agent_path too", async () => {
		writeLines(rollout("fork"), [
			codexMeta("thread-a", { model_provider: "azure", agent_path: "/root/worker" }),
			codexMeta("thread-b", { model_provider: "other", agent_path: undefined }),
			codexContext(),
			codexRecord(),
		]);
		const scan = await readCodex(root, {});
		expect(scan.calls[0]).toMatchObject({ provider: "azure", session: sessionHash("codex", "thread-a") });
		expect(scan.sessionMetadata[0]?.child).toBe(true);
	});

	it("collapses a response copied into a forked or archived rollout", async () => {
		const body = [codexMeta(), codexContext(), codexRecord()];
		writeLines(rollout("a"), body);
		writeLines(join(root, "archived_sessions", "rollout-a.jsonl"), body);
		const scan = await readCodex(root, {});
		expect(scan.calls).toHaveLength(1);
	});

	it("skips rollouts without per-turn records, with a diagnostic and no approximation", async () => {
		writeLines(rollout("old"), [codexMeta(), codexContext(), codexTokenCount(limits(weekly))]);
		writeLines(rollout("new"), [codexMeta("thread-3"), codexContext(), codexRecord(), codexTokenCount(null)]);
		const scan = await readCodex(root, {});
		expect(scan.calls).toHaveLength(1);
		expect(scan.problems).toEqual(["codex: 1 files skipped, no per-turn usage records"]);
		// quota from the skipped rollout is still a valid reading
		expect(scan.quota).toHaveLength(1);
	});

	it("counts records it cannot attribute or read", async () => {
		writeLines(rollout("a"), [
			codexMeta(),
			codexRecord({ turn: "no-model", response: "r1" }),
			codexContext("turn-1"),
			codexRecord({ turn: "turn-1", response: "r2", usage: { input_tokens: "many" } }),
			codexRecord({ turn: "turn-1", response: "" }),
			codexRecord({ turn: "turn-1", response: "r3", ts: "garbage" }),
			codexRecord({ turn: "turn-1", response: "r4", usage: { input_tokens: 5, output_tokens: 1 } }),
			'{"type":"token_usage_record", broken',
			"{not wanted and fine}",
			"truncated {",
			{ type: "token_usage_record", payload: { response_id: "r5", turn_id: "turn-1" } },
			{ type: "turn_context" },
		]);
		const scan = await readCodex(root, {});
		expect(scan.calls.map((c) => c.input)).toEqual([5]);
		expect(scan.problems).toEqual(["codex: ! 7 unreadable lines"]);
	});

	it("drops usage that has no session_meta", async () => {
		writeLines(rollout("orphan"), [{ type: "session_meta", payload: {} }, codexContext(), codexRecord()]);
		const scan = await readCodex(root, {});
		expect(scan.calls).toEqual([]);
		expect(scan.problems).toEqual(["codex: ! 1 unreadable lines"]);
	});

	describe("quota", () => {
		it("reads a weekly-only plan: primary is 10080 minutes, secondary null", async () => {
			writeLines(rollout("a"), [codexMeta(), codexTokenCount(limits(weekly))]);
			expect((await readCodex(root, {})).quota).toEqual([
				{
					harness: "codex",
					provider: "openai-codex",
					limitId: "codex",
					window: "7d",
					usedPercent: 12.5,
					resetAt: 1_790_000_000_000,
					durationMs: 604_800_000,
					observedAt: Date.parse("2026-10-02T10:00:03Z"),
					planType: "pro",
				},
			]);
		});

		it("reads both windows, names odd spans in seconds, clamps, and prefers the freshest reading", async () => {
			writeLines(rollout("a"), [
				codexMeta(),
				codexTokenCount(
					limits(
						{ ...fiveHour, used_percent: 10 },
						{ ...weekly, used_percent: 150 },
						{ limit_id: undefined, plan_type: undefined },
					),
					"2026-10-02T10:00:03Z",
				),
				codexTokenCount(
					limits(
						{ ...fiveHour, used_percent: 30 },
						{ used_percent: 5, window_minutes: 60, resets_at: 1_788_000_000 },
						{ limit_id: undefined, plan_type: undefined },
					),
					"2026-10-02T10:30:00Z",
				),
				// older than what is already held: ignored
				codexTokenCount(
					limits({ ...fiveHour, used_percent: 1 }, null, { limit_id: undefined }),
					"2026-10-02T09:00:00Z",
				),
				// unusable windows and rows are ignored
				codexTokenCount(
					limits({ used_percent: "x", window_minutes: 300, resets_at: 1 }, { used_percent: 1, window_minutes: 300 }),
				),
				codexTokenCount(null),
				codexTokenCount(undefined, "garbage"),
			]);
			const quota = (await readCodex(root, {})).quota;
			const by = Object.fromEntries(quota.map((q) => [q.window, q]));
			expect(Object.keys(by).sort()).toEqual(["3600s", "5h", "7d"]);
			expect(by["5h"]).toMatchObject({ usedPercent: 30, limitId: "codex", planType: null });
			expect(by["7d"]?.usedPercent).toBe(100);
		});

		it("keeps the freshest reading across rollouts", async () => {
			writeLines(rollout("a"), [
				codexMeta(),
				codexTokenCount(limits({ ...fiveHour, used_percent: 20 }), "2026-10-02T10:00:00Z"),
			]);
			writeLines(rollout("b", "2026/10/03"), [
				codexMeta("t2"),
				codexTokenCount(limits({ ...fiveHour, used_percent: 60 }), "2026-10-03T10:00:00Z"),
			]);
			writeLines(rollout("c", "2026/10/09"), [
				codexMeta("t3"),
				codexTokenCount(limits({ ...fiveHour, used_percent: 90 }), "2026-10-01T10:00:00Z"),
			]);
			const quota = (await readCodex(root, {})).quota;
			expect(quota.map((q) => q.usedPercent)).toEqual([60]);
		});
	});

	it("never lets content, cwd, account IDs, credits or native IDs reach the scan or its cache", async () => {
		writeLines(rollout("a"), [
			codexMeta(),
			codexContext(),
			codexMessage(),
			codexRecord(),
			codexTokenCount(limits(weekly, fiveHour)),
		]);
		writeLines(join(root, "history.jsonl"), [{ text: `${CANARY} prompt` }]);
		writeLines(join(root, "auth.json"), [{ access_token: CANARY }]);
		const cache: HarnessCache = {};
		const scan = await readCodex(root, cache);
		expect(scan.calls).toHaveLength(1);
		for (const text of [JSON.stringify(scan), JSON.stringify(Object.values(cache.codex ?? {}))]) {
			expect(text).not.toContain(CANARY);
			for (const native of ["thread-1", "resp-1", "turn-1", "creator", "balance"]) expect(text).not.toContain(native);
		}
		expect(Object.keys(cache.codex ?? {})).toHaveLength(1);
	});
});
