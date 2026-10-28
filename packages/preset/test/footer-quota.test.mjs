import assert from "node:assert/strict";
import { test } from "vitest";
import * as q from "../lib/footer-quota.ts";

const NOW = 1_000_000;
const win = (name, usedPercent, scope = "provider") => ({
	name,
	usedPercent,
	scope,
});
const reply = (snapshots) => ({
	success: true,
	data: { snapshots, blocks: [] },
});
const snap = (provider, windows, extra = {}) => ({
	provider,
	status: "available",
	windows,
	expiresAt: NOW + 1,
	...extra,
});
const plain = (_c, t) => t;

function fakeEnv() {
	const handlers = new Map();
	const emitted = [];
	const timers = [];
	let intervals = 0;
	let changes = 0;
	const events = {
		on(ch, fn) {
			handlers.set(ch, fn);
			return () => handlers.delete(ch);
		},
		emit(ch, data) {
			emitted.push({ ch, data });
		},
	};
	let n = 0;
	const clock = { now: NOW };
	const deps = {
		events,
		onChange: () => changes++,
		now: () => clock.now,
		newId: () => `id${++n}`,
		setTimeout: (fn, ms) => {
			const timer = {
				ms,
				live: true,
				fn: () => {
					timer.live = false;
					fn();
				},
			};
			timers.push(timer);
			return timers.length - 1;
		},
		clearTimeout: (h) => {
			timers[h].live = false;
		},
		setInterval: () => ++intervals,
		clearInterval: () => {
			intervals--;
		},
	};
	const live = (ms) => timers.filter((t) => t.live && t.ms === ms);
	return {
		deps,
		handlers,
		emitted,
		timers,
		clock,
		live,
		changes: () => changes,
		intervals: () => intervals,
	};
}

const ok = (extra = {}) => snap("anthropic", [win("five_hour", 24), win("seven_day", 42)], extra);
const both = () =>
	reply([
		ok({ expiresAt: NOW + 100_000 }),
		snap("openai-codex", [win("5h", 18), win("7d", 37)], {
			expiresAt: NOW + 100_000,
		}),
	]);
const prior = {
	anthropic: { fiveHour: 76, weekly: 58, stale: false, expiresAt: NOW + 10 },
	"openai-codex": {
		fiveHour: 82,
		weekly: 63,
		stale: false,
		expiresAt: NOW + 10,
	},
};

test("remainingPercent clamps, floors, rejects invalid", () => {
	assert.equal(q.remainingPercent(24.5), 75);
	assert.equal(q.remainingPercent(0), 100);
	assert.equal(q.remainingPercent(100), 0);
	assert.equal(q.remainingPercent(-5), 100);
	assert.equal(q.remainingPercent(250), 0);
	for (const bad of [Number.NaN, Infinity, -Infinity, "3", null, undefined])
		assert.equal(q.remainingPercent(bad), undefined);
});

test("parse: fresh snapshots read provider windows only", () => {
	const state = q.parseUsageReply(
		reply([
			snap("anthropic", [win("five_hour", 24), win("seven_day", 42), win("seven_day_opus", 99, "model")], {
				expiresAt: NOW + 5,
			}),
			snap("openai-codex", [win("5h", 18), win("7d", 37)], {
				expiresAt: NOW + 6,
			}),
		]),
		NOW,
	);
	assert.deepEqual(state.anthropic, {
		fiveHour: 76,
		weekly: 58,
		stale: false,
		expiresAt: NOW + 5,
	});
	// OpenAI has no 5h quota: its "5h" window is never surfaced.
	assert.deepEqual(state["openai-codex"], {
		weekly: 63,
		stale: false,
		expiresAt: NOW + 6,
	});
});

test("parse: malformed envelopes rejected", () => {
	for (const bad of [
		null,
		"x",
		[],
		{ success: false, error: "x" },
		{ success: true },
		{ success: true, data: {} },
		{ success: true, data: { snapshots: {} } },
	]) {
		assert.equal(q.parseUsageReply(bad, NOW), undefined);
	}
});

test("parse: fresh requires finite future expiresAt, known status, windows array", () => {
	const cases = {
		missing: { expiresAt: undefined },
		nan: { expiresAt: Number.NaN },
		inf: { expiresAt: Infinity },
		string: { expiresAt: String(NOW + 5) },
		expired: { expiresAt: NOW },
		unknownStatus: { status: "weird", expiresAt: NOW + 5 },
		staleStatus: { status: "stale", expiresAt: NOW + 5 },
		noStatus: { status: undefined, expiresAt: NOW + 5 },
	};
	for (const [name, extra] of Object.entries(cases)) {
		const state = q.parseUsageReply(reply([ok(extra)]), NOW);
		assert.equal(state.anthropic.stale, true, name);
	}
	const noWindows = { ...ok({ expiresAt: NOW + 5 }), windows: "nope" };
	assert.equal(q.parseUsageReply(reply([noWindows]), NOW).anthropic.stale, true);
});

test("parse: provider error/unavailable/empty windows retain last-known values as stale", () => {
	for (const extra of [
		{ status: "error", windows: [] },
		{ status: "unavailable", windows: [] },
		{ windows: [] },
		{ windows: undefined },
	]) {
		const state = q.parseUsageReply(reply([snap("anthropic", [], { expiresAt: NOW + 5, ...extra })]), NOW, prior);
		assert.equal(state.anthropic.stale, true);
		assert.equal(state.anthropic.fiveHour, 76);
		assert.equal(state.anthropic.weekly, 58);
		// provider missing from reply entirely
		assert.equal(state["openai-codex"].stale, true);
		assert.equal(state["openai-codex"].fiveHour, 82);
	}
});

test("parse: stale merge is per field, valid snapshot values win", () => {
	const state = q.parseUsageReply(
		reply([
			snap("anthropic", [win("five_hour", 50)], {
				status: "stale",
				expiresAt: NOW + 5,
			}),
		]),
		NOW,
		prior,
	);
	assert.equal(state.anthropic.fiveHour, 50);
	assert.equal(state.anthropic.weekly, 58);
	assert.equal(state.anthropic.stale, true);
});

test("parse: fresh with missing/invalid windows shows -- and does not retain", () => {
	const fresh = snap("anthropic", [win("five_hour", Number.NaN), win("seven_day", 42, "model")], {
		expiresAt: NOW + 5,
	});
	const state = q.parseUsageReply(
		reply([fresh, snap("openai-codex", [win("5h", 1, "model")], { expiresAt: NOW + 5 })]),
		NOW,
		prior,
	);
	assert.deepEqual(state.anthropic, {
		fiveHour: undefined,
		stale: false,
		expiresAt: NOW + 5,
	});
	assert.equal(state["openai-codex"].fiveHour, undefined);
	assert.equal(state["openai-codex"].stale, false);
});

test("format: full, compact, boundaries and colors", () => {
	const state = {
		anthropic: { fiveHour: 76, weekly: 58, stale: false },
		"openai-codex": { fiveHour: 82, weekly: 63, stale: false },
	};
	assert.equal(q.formatQuotaRow(state, "full", plain), "Quota left: Anthropic 5h 76% weekly 58% | OpenAI weekly 63%");
	assert.equal(q.formatQuotaRow(state, "compact", plain), "Left: Anth 5h 76% 7d 58% | OAI 7d 63%");
	const colorsFor = (value) => {
		const colors = [];
		q.formatQuotaRow({ anthropic: { fiveHour: value, stale: false } }, "compact", (c, t) => {
			colors.push(`${c}:${t}`);
			return t;
		});
		return colors;
	};
	assert.ok(colorsFor(0).includes("error:0%"));
	assert.ok(colorsFor(5).includes("error:5%"));
	assert.ok(colorsFor(6).includes("warning:6%"));
	assert.ok(colorsFor(20).includes("warning:20%"));
	for (const v of [21, 100]) assert.ok(!colorsFor(v).some((c) => c.endsWith(`:${v}%`) && !c.startsWith("dim")));
	const text = q.formatQuotaRow({ anthropic: { fiveHour: 3, stale: true } }, "compact", plain);
	assert.equal(text, "Left: Anth (stale) 5h 3% 7d -- | OAI (stale) 7d --");
});

test("poller: request shape and unique ids across pollers (default newId)", () => {
	const env = fakeEnv();
	const { newId, ...rest } = env.deps;
	const a = q.createQuotaPoller(rest);
	const b = q.createQuotaPoller(rest);
	a.start();
	b.start();
	const [x, y] = env.emitted.map((e) => e.data.requestId);
	assert.notEqual(x, y);
	assert.match(x, /^[0-9a-f-]{36}$/);
	assert.equal(env.emitted[0].ch, "router:rpc:usage");
	assert.equal(env.emitted[0].data.refresh, true);
	a.dispose();
	b.dispose();
});

test("poller: timeout with no data stays hidden; one outstanding request", () => {
	const env = fakeEnv();
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	poller.start();
	assert.equal(env.emitted.length, 1);
	assert.equal(env.live(12_000).length, 1);
	env.live(12_000)[0].fn();
	assert.equal(poller.getState(), undefined);
	assert.equal(env.changes(), 0);
	assert.equal(env.handlers.size, 0);
	poller.dispose();
});

test("poller: timeout after data keeps figures, marks stale, notifies", () => {
	const env = fakeEnv();
	let tick;
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.get("router:rpc:usage:reply:id1")(both());
	assert.equal(poller.getState().anthropic.stale, false);
	assert.equal(env.changes(), 1);
	tick();
	assert.equal(env.emitted.length, 2);
	tick(); // outstanding: no second request
	assert.equal(env.emitted.length, 2);
	const before = env.changes();
	env.live(12_000)[0].fn();
	const state = poller.getState();
	assert.equal(state.anthropic.stale, true);
	assert.equal(state.anthropic.fiveHour, 76);
	assert.equal(state["openai-codex"].weekly, 63);
	assert.equal(env.changes(), before + 1);
	assert.equal(env.handlers.size, 0);
	poller.dispose();
});

test("poller: error reply and failed snapshot retain values", () => {
	const env = fakeEnv();
	let tick;
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.get("router:rpc:usage:reply:id1")(both());
	tick();
	env.handlers.get("router:rpc:usage:reply:id2")({
		success: false,
		error: "boom",
	});
	assert.equal(poller.getState().anthropic.stale, true);
	assert.equal(poller.getState().anthropic.fiveHour, 76);
	tick();
	env.handlers.get("router:rpc:usage:reply:id3")(
		reply([snap("anthropic", [], { status: "error" }), snap("openai-codex", [], { status: "unavailable" })]),
	);
	assert.equal(poller.getState().anthropic.fiveHour, 76);
	assert.equal(poller.getState()["openai-codex"].weekly, 63);
	assert.equal(poller.getState().anthropic.stale, true);
	poller.dispose();
});

test("poller: staleness progresses with the clock while a request is pending", () => {
	const env = fakeEnv();
	let tick;
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.get("router:rpc:usage:reply:id1")(
		reply([
			ok({ expiresAt: NOW + 5_000 }),
			snap("openai-codex", [win("5h", 18), win("7d", 37)], {
				expiresAt: NOW + 9_000,
			}),
		]),
	);
	tick(); // request pending from here on
	assert.equal(poller.getState().anthropic.stale, false);
	const expiry = env.live(5_000);
	assert.equal(expiry.length, 1);

	env.clock.now = NOW + 5_000;
	const before = env.changes();
	expiry[0].fn(); // timer fires: notify, schedule next
	assert.equal(env.changes(), before + 1);
	let state = poller.getState();
	assert.equal(state.anthropic.stale, true);
	assert.equal(state.anthropic.fiveHour, 76);
	assert.equal(state["openai-codex"].stale, false);
	assert.equal(env.live(4_000).length, 1);

	env.clock.now = NOW + 9_000;
	env.live(4_000)[0].fn();
	state = poller.getState();
	assert.equal(state["openai-codex"].stale, true);
	assert.equal(state["openai-codex"].weekly, 63);
	poller.dispose();
	assert.equal(env.live(5_000).length + env.live(4_000).length, 0);
});

test("poller: late replies are ignored after dispose, timeout and supersession", () => {
	const env = fakeEnv();
	let tick;
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	const late1 = env.handlers.get("router:rpc:usage:reply:id1");
	env.live(12_000)[0].fn(); // times out with nothing
	late1(both());
	assert.equal(poller.getState(), undefined);
	assert.equal(env.changes(), 0);

	tick(); // id2 outstanding
	const late2 = env.handlers.get("router:rpc:usage:reply:id2");
	assert.ok(late2);
	poller.dispose();
	late2(both());
	assert.equal(env.changes(), 0);
	assert.equal(poller.getState(), undefined);
	tick();
	assert.equal(env.emitted.length, 2);
	assert.equal(env.handlers.size, 0);
});

test("poller: interval cleared on dispose", () => {
	const env = fakeEnv();
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	assert.equal(env.intervals(), 1);
	poller.dispose();
	assert.equal(env.intervals(), 0);
});

test("poller: stale reply from superseded request cannot settle the current one", () => {
	const env = fakeEnv();
	let tick;
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	const late1 = env.handlers.get("router:rpc:usage:reply:id1");
	env.live(12_000)[0].fn();
	tick();
	late1(both());
	assert.equal(poller.getState(), undefined);
	env.handlers.get("router:rpc:usage:reply:id2")(both());
	assert.equal(poller.getState().anthropic.fiveHour, 76);
	poller.dispose();
});

// --- reset times ---------------------------------------------------------

const at = (iso) => Date.parse(iso);
const resetWin = (name, usedPercent, resetAt) => ({ ...win(name, usedPercent), resetAt });

test("parse: reset times come from router windows; OpenAI 5h is ignored even when reported", () => {
	const state = q.parseUsageReply(
		reply([
			snap("anthropic", [resetWin("five_hour", 24, 5_000), resetWin("seven_day", 42, 9_000)]),
			snap("openai-codex", [resetWin("5h", 18, 6_000), resetWin("7d", 37, 8_000)]),
		]),
		NOW,
	);
	assert.equal(state.anthropic.fiveHourResetAt, 5_000);
	assert.equal(state.anthropic.weeklyResetAt, 9_000);
	assert.equal(state["openai-codex"].weekly, 63);
	assert.equal(state["openai-codex"].weeklyResetAt, 8_000);
	assert.ok(!("fiveHour" in state["openai-codex"]));
	assert.ok(!("fiveHourResetAt" in state["openai-codex"]));
});

test("parse: unknown or invalid resetAt is omitted, never invented", () => {
	for (const bad of [undefined, null, 0, -1, Number.NaN, Infinity, "2026-01-01T00:00:00Z"]) {
		const state = q.parseUsageReply(
			reply([snap("anthropic", [resetWin("five_hour", 24, bad), resetWin("seven_day", 42, bad)])]),
			NOW,
		);
		assert.ok(!("fiveHourResetAt" in state.anthropic), String(bad));
		assert.ok(!("weeklyResetAt" in state.anthropic), String(bad));
		assert.equal(state.anthropic.weekly, 58);
	}
});

test("parse: stale merge keeps a retained percent with its reset; a new percent brings its own", () => {
	const prior = {
		anthropic: { fiveHour: 10, fiveHourResetAt: 111, weekly: 20, weeklyResetAt: 222, stale: false, expiresAt: NOW + 1 },
	};
	const failed = { provider: "anthropic", status: "error", windows: [], expiresAt: NOW + 1 };
	const kept = q.parseUsageReply(reply([failed]), NOW, prior);
	assert.equal(kept.anthropic.fiveHourResetAt, 111);
	assert.equal(kept.anthropic.weeklyResetAt, 222);
	const partial = q.parseUsageReply(reply([{ ...failed, windows: [resetWin("seven_day", 50, 333)] }]), NOW, prior);
	assert.deepEqual(
		[
			partial.anthropic.fiveHour,
			partial.anthropic.fiveHourResetAt,
			partial.anthropic.weekly,
			partial.anthropic.weeklyResetAt,
		],
		[10, 111, 50, 333],
	);
	// New weekly percent without a reset does not inherit the old reset.
	const noReset = q.parseUsageReply(reply([{ ...failed, windows: [win("seven_day", 60)] }]), NOW, prior);
	assert.equal(noReset.anthropic.weekly, 40);
	assert.ok(!("weeklyResetAt" in noReset.anthropic));
	// Fresh replacement drops everything it does not report.
	const fresh = q.parseUsageReply(reply([snap("anthropic", [win("five_hour", 1)])]), NOW, prior);
	assert.ok(!("weeklyResetAt" in fresh.anthropic));
	assert.ok(!("fiveHourResetAt" in fresh.anthropic));
	assert.equal(q.markStale(prior).anthropic.fiveHourResetAt, 111);
});

const UTC = "UTC";
const CLOCK = at("2026-01-10T12:00:00Z");
const resetState = (extra = {}) => ({
	anthropic: {
		fiveHour: 66,
		fiveHourResetAt: at("2026-01-10T14:30:00Z"),
		weekly: 35,
		weeklyResetAt: at("2026-01-14T09:00:00Z"),
		stale: false,
		...extra,
	},
	"openai-codex": { weekly: 76, weeklyResetAt: at("2026-01-15T11:05:00Z"), stale: false },
});

test("format: full and compact rows carry reset time (5h same day) and date/time (weekly)", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	assert.equal(
		q.formatQuotaRow(resetState(), "full", plain, opts),
		"Quota left: Anthropic 5h 66% (resets 14:30) weekly 35% (resets Jan 14 09:00) | OpenAI weekly 76% (resets Jan 15 11:05)",
	);
	assert.equal(
		q.formatQuotaRow(resetState(), "compact", plain, opts),
		"Left: Anth 5h 66% @14:30 7d 35% @Jan 14 09:00 | OAI 7d 76% @Jan 15 11:05",
	);
	assert.ok(!q.formatQuotaRow(resetState(), "full", plain, opts).includes("OpenAI 5h"));
});

test("format: unknown reset is omitted per window, percent stays", () => {
	const state = resetState({ fiveHourResetAt: undefined, weeklyResetAt: undefined });
	assert.equal(
		q.formatQuotaRow(state, "compact", plain, { now: CLOCK, timeZone: UTC }),
		"Left: Anth 5h 66% 7d 35% | OAI 7d 76% @Jan 15 11:05",
	);
	assert.equal(
		q.formatQuotaRow({ anthropic: { stale: true } }, "full", plain, { now: CLOCK }),
		"Quota left: Anthropic (stale) 5h -- weekly -- | OpenAI (stale) weekly --",
	);
});

test("format: stale readings keep label and reset; an elapsed reset hides only its own text, never the percent", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	assert.match(
		q.formatQuotaRow(resetState({ stale: true }), "full", plain, opts),
		/^Quota left: Anthropic \(stale\) 5h 66% \(resets 14:30\)/,
	);
	const elapsed = resetState({ fiveHourResetAt: CLOCK, weeklyResetAt: CLOCK - 1 });
	assert.equal(
		q.formatQuotaRow(elapsed, "compact", plain, opts),
		"Left: Anth 5h 66% 7d 35% | OAI 7d 76% @Jan 15 11:05",
	);
	const hot = q.formatQuotaRow(
		{ anthropic: { fiveHour: 3, fiveHourResetAt: CLOCK + 60_000, stale: false } },
		"compact",
		(c, t) => `${c}:${t}`,
		opts,
	);
	assert.ok(hot.includes("error:3%"));
	assert.ok(hot.includes("dim: @12:01"));
});

test("formatResetAt: injected timezone, same-day and midnight boundaries", () => {
	const t = at("2026-01-10T23:59:00Z");
	assert.equal(q.formatResetAt(at("2026-01-10T23:59:30Z"), t, UTC), "23:59");
	assert.equal(q.formatResetAt(at("2026-01-11T00:00:00Z"), t, UTC), "Jan 11 00:00");
	assert.equal(q.formatResetAt(at("2026-01-10T23:59:30Z"), t, UTC, true), "Jan 10 23:59");
	// Same instants, another zone: calendar day is the zone's, not UTC's.
	assert.equal(q.formatResetAt(at("2026-01-11T00:00:00Z"), t, "Asia/Tokyo"), "09:00");
	assert.equal(q.formatResetAt(at("2026-01-11T15:00:00Z"), t, "Asia/Tokyo"), "Jan 12 00:00");
	assert.equal(q.formatResetAt(at("2026-01-11T00:00:00Z"), t, "America/Los_Angeles"), "16:00");
	// Default zone is the process-local one.
	const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
	assert.equal(q.formatResetAt(at("2026-06-01T10:00:00Z"), t), q.formatResetAt(at("2026-06-01T10:00:00Z"), t, local));
});

test("formatResetAt: DST gaps and weekly resets across a transition are wall-clock, not now+7d", () => {
	const NY = "America/New_York";
	// 2026-03-08 07:00Z is the spring-forward instant: 05:00Z is 00:00 EST, 10:00Z is 06:00 EDT.
	assert.equal(q.formatResetAt(at("2026-03-08T10:00:00Z"), at("2026-03-08T05:00:00Z"), NY), "06:00");
	// Weekly reset 7 real days after a noon-UTC reading straddles the change: 07:00 EST -> 08:00 EDT.
	assert.equal(q.formatResetAt(at("2026-03-05T12:00:00Z"), at("2026-03-05T12:00:00Z"), NY, true), "Mar 5 07:00");
	assert.equal(q.formatResetAt(at("2026-03-12T12:00:00Z"), at("2026-03-05T12:00:00Z"), NY, true), "Mar 12 08:00");
	// Fall back 2026-11-01: 05:30Z is 01:30 EDT, 06:30Z is 01:30 EST: same label, both valid.
	assert.equal(q.formatResetAt(at("2026-11-01T06:30:00Z"), at("2026-11-01T04:00:00Z"), NY), "01:30");
});

test("fitQuotaRows: widest layout that fits; narrow widths wrap by provider, never clip it away", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	const rows = (width, state = resetState()) => q.fitQuotaRows(state, width, plain, opts);
	const full = q.formatQuotaRow(resetState(), "full", plain, opts);
	const compact = q.formatQuotaRow(resetState(), "compact", plain, opts);
	assert.deepEqual(rows(full.length), [full]);
	assert.deepEqual(rows(full.length - 1), [compact]);
	assert.deepEqual(rows(compact.length), [compact]);
	const wrapped = rows(compact.length - 1);
	assert.deepEqual(wrapped, ["Left: Anth 5h 66% @14:30 7d 35% @Jan 14 09:00", "OAI 7d 76% @Jan 15 11:05"]);
	assert.deepEqual(rows(45), wrapped);
	// Narrower than the reset-bearing provider rows: drop reset times, keep both providers.
	assert.deepEqual(rows(44), ["Left: Anth 5h 66% 7d 35%", "OAI 7d 76%"]);
	assert.deepEqual(rows(24), ["Left: Anth 5h 66% 7d 35%", "OAI 7d 76%"]);
	// Below even that, rows are still provider-led (the caller clips the tail, never the label).
	for (const row of rows(5)) assert.match(row, /^(Left: )?(Anth|OAI) /);
	// Default clock works.
	assert.equal(q.fitQuotaRows({}, 200, plain).length, 1);
});

// --- OpenAI window identity (router `spanSource`) ---------------------------

const WEEK = 604_800_000;
const span = (name, usedPercent, durationMs, spanSource, resetAt) => ({
	...win(name, usedPercent),
	durationMs,
	spanSource,
	resetAt,
});
const codexOf = (windows) =>
	q.parseUsageReply(reply([snap("openai-codex", windows, { expiresAt: NOW + 5 })]), NOW)["openai-codex"];

test("identity: reported weekly primary (no 5h, no secondary) is weekly with its reset", () => {
	const state = codexOf([span("7d", 38, WEEK, "reported", 9_000)]);
	assert.deepEqual(state, { weekly: 62, weeklyResetAt: 9_000, stale: false, expiresAt: NOW + 5 });
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: weekly is chosen by reported duration, not by name", () => {
	const state = codexOf([span("weekly-ish", 10, WEEK, "reported", 7_000)]);
	assert.equal(state.weekly, 90);
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: reported 18000s window is hidden; with no weekly the provider shows `weekly --`", () => {
	const state = codexOf([span("5h", 10, 18_000_000, "reported", 7_000)]);
	assert.ok(!("weekly" in state) || state.weekly === undefined);
	assert.ok(!("fiveHour" in state));
	assert.ok(!("weeklyUnknown" in state));
	assert.equal(
		q.formatQuotaRow({ "openai-codex": state }, "full", plain, { now: CLOCK }).split("| ")[1],
		"OpenAI weekly --",
	);
});

test("identity: reported other spans (3600s) never become weekly or unknown", () => {
	const state = codexOf([span("3600s", 10, 3_600_000, "reported", 7_000)]);
	assert.ok(!("weeklyUnknown" in state));
	assert.equal(state.weekly, undefined);
});

test("identity: assumed-only window is an unidentified quota, never weekly; most limiting wins", () => {
	const only = codexOf([span("5h", 38, 18_000_000, "assumed", 9_000)]);
	assert.deepEqual(only, { weekly: 62, weeklyResetAt: 9_000, weeklyUnknown: true, stale: false, expiresAt: NOW + 5 });
	const both = codexOf([span("5h", 38, 18_000_000, "assumed", 9_000), span("7d", 80, WEEK, "assumed", 8_000)]);
	assert.deepEqual([both.weekly, both.weeklyResetAt, both.weeklyUnknown], [20, 8_000, true]);
	const tie = codexOf([span("5h", 50, 1, "assumed", 1_000), span("7d", 50, 2, "assumed", 2_000)]);
	assert.equal(tie.weeklyResetAt, 1_000);
});

test("identity: a proven weekly suppresses any assumed window", () => {
	const state = codexOf([span("5h", 99, 18_000_000, "assumed", 1_000), span("7d", 38, WEEK, "reported", 9_000)]);
	assert.deepEqual([state.weekly, state.weeklyResetAt], [62, 9_000]);
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: an assumed `7d` (positional secondary) is not proven weekly", () => {
	const state = codexOf([span("7d", 38, WEEK, "assumed", 9_000)]);
	assert.equal(state.weeklyUnknown, true);
});

test("identity: snapshots without spanSource keep the legacy `7d` behavior and ignore legacy 5h", () => {
	const state = codexOf([resetWin("5h", 99, 1_000), resetWin("7d", 38, 9_000)]);
	assert.deepEqual([state.weekly, state.weeklyResetAt], [62, 9_000]);
	assert.ok(!("weeklyUnknown" in state));
	const only5h = codexOf([resetWin("5h", 99, 1_000)]);
	assert.equal(only5h.weekly, undefined);
	assert.ok(!("weeklyUnknown" in only5h));
});

test("identity: model-scoped and malformed windows are ignored", () => {
	const scoped = { ...span("7d", 38, WEEK, "assumed", 9_000), scope: "model" };
	assert.equal(codexOf([scoped]).weekly, undefined);
	assert.equal(codexOf([span("7d", Number.NaN, WEEK, "assumed", 9_000)]).weeklyUnknown, true);
	assert.equal(codexOf([span("7d", Number.NaN, WEEK, "assumed", 9_000)]).weekly, undefined);
});

test("identity: stale merge keeps unidentified flag with its pair, and never displaces a proven weekly", () => {
	const unknownPrior = {
		"openai-codex": { weekly: 40, weeklyResetAt: 5_000, weeklyUnknown: true, stale: false, expiresAt: NOW + 1 },
	};
	const failed = { provider: "openai-codex", status: "error", windows: [], expiresAt: NOW + 1 };
	const kept = q.parseUsageReply(reply([failed]), NOW, unknownPrior)["openai-codex"];
	assert.deepEqual([kept.weekly, kept.weeklyResetAt, kept.weeklyUnknown, kept.stale], [40, 5_000, true, true]);
	// Proven weekly arrives later: replaces the unidentified reading and clears the flag.
	const proven = q.parseUsageReply(
		reply([{ ...failed, windows: [span("7d", 10, WEEK, "reported", 6_000)] }]),
		NOW,
		unknownPrior,
	)["openai-codex"];
	assert.deepEqual([proven.weekly, proven.weeklyResetAt], [90, 6_000]);
	assert.ok(!("weeklyUnknown" in proven));
	// An unidentified reading cannot displace a retained proven weekly.
	const provenPrior = { "openai-codex": { weekly: 70, weeklyResetAt: 4_000, stale: false, expiresAt: NOW + 1 } };
	const guarded = q.parseUsageReply(
		reply([{ ...failed, windows: [span("5h", 10, 18_000_000, "assumed", 6_000)] }]),
		NOW,
		provenPrior,
	)["openai-codex"];
	assert.deepEqual([guarded.weekly, guarded.weeklyResetAt], [70, 4_000]);
	assert.ok(!("weeklyUnknown" in guarded));
});

test("format: unidentified OpenAI quota says so, full and compact, with date and time", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	const state = {
		anthropic: {
			fiveHour: 66,
			fiveHourResetAt: at("2026-01-10T14:30:00Z"),
			weekly: 35,
			weeklyResetAt: at("2026-01-14T09:00:00Z"),
			stale: false,
		},
		"openai-codex": { weekly: 62, weeklyResetAt: at("2026-01-15T11:05:00Z"), weeklyUnknown: true, stale: false },
	};
	assert.equal(
		q.formatQuotaRow(state, "full", plain, opts),
		"Quota left: Anthropic 5h 66% (resets 14:30) weekly 35% (resets Jan 14 09:00) | OpenAI quota 62% (resets Jan 15 11:05; window unknown)",
	);
	assert.equal(
		q.formatQuotaRow(state, "compact", plain, opts),
		"Left: Anth 5h 66% @14:30 7d 35% @Jan 14 09:00 | OAI quota? 62% @Jan 15 11:05",
	);
	const bare = { "openai-codex": { weekly: 62, weeklyUnknown: true, stale: false } };
	assert.equal(q.formatQuotaRow(bare, "full", plain, opts).split("| ")[1], "OpenAI quota 62% (window unknown)");
	assert.equal(q.formatQuotaRow(bare, "compact", plain, opts).split("| ")[1], "OAI quota? 62%");
	assert.ok(!/weekly|7d/.test(q.formatQuotaRow(bare, "full", plain, opts).split("| ")[1]));
	// A past reset omits only the text.
	const past = { "openai-codex": { weekly: 62, weeklyResetAt: CLOCK - 1, weeklyUnknown: true, stale: false } };
	assert.equal(q.formatQuotaRow(past, "full", plain, opts).split("| ")[1], "OpenAI quota 62% (window unknown)");
	// Narrowest layout keeps the `?` provenance.
	assert.equal(q.fitQuotaRows(state, 20, plain, opts).at(-1), "OAI quota? 62%");
});

test("format: a past reset never blanks a percent or changes its color", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	const colored = [];
	const text = q.formatQuotaRow(
		{ anthropic: { fiveHour: 3, fiveHourResetAt: CLOCK - 1, weekly: 4, weeklyResetAt: CLOCK, stale: false } },
		"compact",
		(c, t) => {
			colored.push(`${c}:${t}`);
			return t;
		},
		opts,
	);
	assert.match(text, /^Left: Anth 5h 3% 7d 4% \|/);
	assert.ok(colored.includes("error:3%") && colored.includes("error:4%"));
});

test("identity: unrecognized provider windows are ignored; invalid assumed percents never win limiting", () => {
	const anth = q.parseUsageReply(
		reply([snap("anthropic", [win("mystery", 1), win("five_hour", 10)], { expiresAt: NOW + 5 })]),
		NOW,
	).anthropic;
	assert.deepEqual([anth.fiveHour, anth.weekly], [90, undefined]);
	const nanSecond = codexOf([span("5h", 30, 1, "assumed", 1_000), span("7d", Number.NaN, 2, "assumed", 2_000)]);
	assert.deepEqual([nanSecond.weekly, nanSecond.weeklyResetAt], [70, 1_000]);
	const nanFirst = codexOf([span("5h", Number.NaN, 1, "assumed", 1_000), span("7d", 30, 2, "assumed", 2_000)]);
	assert.deepEqual([nanFirst.weekly, nanFirst.weeklyResetAt], [70, 2_000]);
	const looser = codexOf([span("5h", 30, 1, "assumed", 1_000), span("7d", 10, 2, "assumed", 2_000)]);
	assert.equal(looser.weekly, 70);
});
