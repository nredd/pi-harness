import assert from "node:assert/strict";
import { test } from "vitest";
import * as c from "../lib/footer-cache.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const TTL = 300;
const at = (seconds) => T0 + seconds * 1000;

/** Assistant entry; `hit` is the cache-read share of a 1000 token prompt. */
const turn = (seconds, hit, extra = {}) => ({
	type: "message",
	timestamp: new Date(at(seconds)).toISOString(),
	message: {
		role: "assistant",
		provider: "anthropic",
		model: "sonnet",
		timestamp: at(seconds),
		usage: { input: 1000 - hit * 10, cacheRead: hit * 10, cacheWrite: 0 },
		...extra,
	},
});
const user = (seconds) => ({ type: "message", message: { role: "user", timestamp: at(seconds) } });
const compaction = (seconds) => ({ type: "compaction", timestamp: new Date(at(seconds)).toISOString() });
const analyze = (entries, nowS) => c.analyzeCache(entries, at(nowS), TTL);

test("ttl: promptCache.short in seconds, else 300", () => {
	assert.equal(c.cacheTtlSeconds({ short: 120 }), 120);
	assert.equal(c.cacheTtlSeconds({}), 300);
	assert.equal(c.cacheTtlSeconds(undefined), 300);
	assert.equal(c.cacheTtlSeconds({ short: 0 }), 300);
	assert.equal(c.cacheTtlSeconds({ short: Number.NaN }), 300);
});

test("no usage yet: empty status, empty marker", () => {
	assert.deepEqual(analyze([], 0), {});
	assert.deepEqual(analyze([user(0)], 5), {});
	assert.equal(c.formatCacheMarker({}, "full"), "");
});

test("warm inside the ttl, cold at and after it", () => {
	const entries = [turn(0, 95)];
	assert.equal(analyze(entries, 299).temperature, "warm");
	assert.equal(analyze(entries, 299).coldAt, at(300));
	assert.equal(analyze(entries, 300).temperature, "cold");
	assert.equal(analyze(entries, 300).coldAt, undefined);
	assert.equal(analyze(entries, 3600).temperature, "cold");
});

test("custom ttl comes from the argument", () => {
	assert.equal(c.analyzeCache([turn(0, 90)], at(100), 60).temperature, "cold");
	assert.equal(c.analyzeCache([turn(0, 90)], at(100), 3600).temperature, "warm");
});

test("healthy turns carry no cause", () => {
	const status = analyze([turn(0, 95), turn(10, 96)], 20);
	assert.equal(status.cause, undefined);
	assert.equal(status.hitRate, 96);
});

test("first turn with a cold cache is not a drop", () => {
	assert.equal(analyze([turn(0, 0)], 5).cause, undefined);
});

test("low turn after a low flat turn is not a drop", () => {
	assert.equal(analyze([turn(0, 10), turn(10, 5)], 20).cause, undefined);
	assert.equal(analyze([turn(0, 40), turn(10, 38)], 20).cause, undefined);
	assert.equal(analyze([turn(0, 40), turn(10, 31)], 20).cause, undefined);
});

test("further drop below the healthy line is still diagnosed", () => {
	assert.equal(analyze([turn(0, 40), turn(10, 0)], 20).cause, "prefix-changed");
	assert.equal(analyze([turn(0, 40), turn(10, 30)], 20).cause, "prefix-changed");
	assert.equal(analyze([turn(0, 40), turn(10, 0, { model: "opus" })], 20).cause, "model-switch");
	assert.equal(analyze([turn(0, 40), turn(301, 0)], 302).cause, "idle>ttl");
});

test("a rise or a healthy turn after a low turn is never tagged", () => {
	assert.equal(analyze([turn(0, 0), turn(10, 40)], 20).cause, undefined);
	assert.equal(analyze([turn(0, 0), turn(10, 90)], 20).cause, undefined);
});

test("only the latest pair counts: an old drop is forgotten", () => {
	assert.equal(analyze([turn(0, 95), turn(10, 0), turn(20, 0)], 30).cause, undefined);
});

test("threshold is exclusive: exactly healthy is not a drop", () => {
	assert.equal(analyze([turn(0, 95), turn(10, c.HEALTHY_HIT_PERCENT)], 20).cause, undefined);
	assert.equal(analyze([turn(0, 95), turn(10, c.HEALTHY_HIT_PERCENT - 1)], 20).cause, "prefix-changed");
});

test("cause idle>ttl when the gap exceeds the ttl", () => {
	assert.equal(analyze([turn(0, 95), turn(301, 0)], 302).cause, "idle>ttl");
	assert.equal(analyze([turn(0, 95), turn(300, 0)], 302).cause, "prefix-changed");
});

test("idle wins over model-switch and compaction", () => {
	const entries = [turn(0, 95), compaction(100), turn(1000, 0, { model: "opus" })];
	assert.equal(analyze(entries, 1001).cause, "idle>ttl");
});

test("cause model-switch on model or provider change", () => {
	assert.equal(analyze([turn(0, 95), turn(10, 0, { model: "opus" })], 11).cause, "model-switch");
	assert.equal(analyze([turn(0, 95), turn(10, 0, { provider: "openai-codex" })], 11).cause, "model-switch");
});

test("router model: unchanged virtual id is not a switch, a routed change is", () => {
	const router = { provider: "router", model: "default" };
	assert.equal(analyze([turn(0, 95, router), turn(10, 0, router)], 11).cause, "prefix-changed");
	assert.equal(analyze([turn(0, 95, router), turn(10, 0)], 11).cause, "model-switch");
});

test("missing provider or model never reads as a switch", () => {
	const bare = { provider: undefined, model: undefined };
	assert.equal(analyze([turn(0, 95), turn(10, 0, bare)], 11).cause, "prefix-changed");
	assert.equal(analyze([turn(0, 95, bare), turn(10, 0)], 11).cause, "prefix-changed");
});

test("cause compaction only when the entry sits between the two turns", () => {
	assert.equal(analyze([turn(0, 95), compaction(5), turn(10, 0)], 11).cause, "compaction");
	assert.equal(analyze([compaction(0), turn(1, 95), turn(10, 0)], 11).cause, "prefix-changed");
	assert.equal(analyze([turn(0, 95), turn(10, 0), compaction(11)], 12).cause, "prefix-changed");
});

test("cause prefix-changed is the fallback", () => {
	assert.equal(analyze([turn(0, 95), user(5), turn(10, 0)], 11).cause, "prefix-changed");
});

test("zero prompt tokens are skipped, not a drop", () => {
	const empty = turn(20, 0, { usage: { input: 0, cacheRead: 0, cacheWrite: 0 } });
	const status = analyze([turn(0, 95), empty], 30);
	assert.equal(status.hitRate, 95);
	assert.equal(status.cause, undefined);
	assert.deepEqual(analyze([empty], 30), {});
});

test("cache write counts toward the prompt", () => {
	const write = turn(0, 0, { usage: { input: 0, cacheRead: 0, cacheWrite: 1000 } });
	assert.equal(analyze([write], 1).hitRate, 0);
});

test("assistant without usage and non-message entries are ignored", () => {
	const noUsage = turn(5, 0, { usage: undefined });
	const status = analyze([turn(0, 95), noUsage, { type: "usage" }, { type: "model_change" }], 6);
	assert.equal(status.hitRate, 95);
});

test("subagent and tool-result rows are not turns", () => {
	const toolResult = {
		type: "message",
		message: { role: "toolResult", usage: { input: 5, cacheRead: 0, cacheWrite: 0 } },
	};
	const subagent = { type: "custom_message", message: { role: "assistant", usage: { input: 5, cacheRead: 0 } } };
	const status = analyze([turn(0, 95), toolResult, subagent], 6);
	assert.equal(status.hitRate, 95);
	assert.equal(status.cause, undefined);
});

test("missing timestamps: no marker, no idle cause; entry timestamp is a fallback", () => {
	const noStamp = (hit) => turn(0, hit, { timestamp: undefined, usage: turn(0, hit).message.usage });
	const bare = (hit) => {
		const entry = noStamp(hit);
		entry.timestamp = undefined;
		return entry;
	};
	const status = analyze([bare(95), bare(0)], 9999);
	assert.equal(status.temperature, undefined);
	assert.equal(status.cause, "prefix-changed");
	assert.equal(c.formatCacheMarker(status, "full"), " prefix-changed");
	const viaEntry = bare(95);
	viaEntry.timestamp = new Date(at(0)).toISOString();
	assert.equal(analyze([viaEntry], 10).temperature, "warm");
	viaEntry.timestamp = "not a date";
	assert.equal(analyze([viaEntry], 10).temperature, undefined);
});

test("marker text per tier", () => {
	assert.equal(c.formatCacheMarker({ temperature: "warm" }, "full"), " warm");
	assert.equal(c.formatCacheMarker({ temperature: "cold" }, "full"), " cold");
	assert.equal(c.formatCacheMarker({ temperature: "warm" }, "compact"), " w");
	assert.equal(c.formatCacheMarker({ temperature: "cold", cause: "idle>ttl" }, "compact"), " c idle");
	assert.equal(c.formatCacheMarker({ temperature: "cold", cause: "prefix-changed" }, "compact"), " c prefix");
	assert.equal(c.formatCacheMarker({ cause: "model-switch" }, "compact"), " model");
	assert.equal(c.formatCacheMarker({ temperature: "cold", cause: "compaction" }, "full"), " cold compaction");
});
