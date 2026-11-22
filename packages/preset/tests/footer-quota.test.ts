import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, vi } from "vitest";
import * as footer from "../src/footer-quota.ts";

const NOW = 1_000_000;
const win = (name: string, usedPercent: number, scope = "provider") => ({
	name,
	usedPercent,
	scope,
});
const reply = (snapshots: unknown[]) => ({
	success: true,
	data: { snapshots, blocks: [] },
});
const snap = (provider: string, windows: unknown[], extra: Record<string, unknown> = {}) => ({
	provider,
	status: "available",
	windows,
	expiresAt: NOW + 1,
	...extra,
});
// Keep the original legacy assertions (especially exact row text) readable while testing cell-backed state.
interface LegacyQuota {
	fiveHourReported?: boolean;
	fiveHour?: number;
	fiveHourResetAt?: number;
	weekly?: number;
	weeklyResetAt?: number;
	weeklyUnknown?: boolean;
	stale: boolean;
	expiresAt?: number;
}
type LegacyState = Record<string, LegacyQuota>;

const originals = new WeakMap<LegacyState, footer.QuotaState>();

function legacyInput(state: LegacyState): footer.QuotaState {
	const original = originals.get(state);
	if (original) return original;
	const snapshots = Object.entries(state).map(([provider, quota]) => {
		const anth = provider === "anthropic";
		const windows = [
			{
				name: anth ? "seven_day" : "7d",
				usedPercent: 100 - (quota.weekly ?? NaN),
				resetAt: quota.weeklyResetAt,
				scope: "provider",
				spanSource: quota.weeklyUnknown ? "assumed" : undefined,
			},
		];
		if (quota.fiveHourReported)
			windows.push({
				name: "five_hour",
				scope: "provider",
				usedPercent: 100 - (quota.fiveHour ?? NaN),
				resetAt: quota.fiveHourResetAt,
				spanSource: undefined,
			});
		return snap(provider, windows);
	});
	const parsed = present(footer.parseUsageReply(reply(snapshots), NOW));
	// Parsed state is frozen, so overlay the legacy staleness on copies.
	return Object.fromEntries(
		Object.entries(parsed).map(([id, quota]) => {
			const legacy = state[id];
			return [id, legacy ? { ...quota, stale: legacy.stale, expiresAt: legacy.expiresAt } : quota];
		}),
	);
}

function legacyOutput(state: footer.QuotaState): LegacyState {
	const projected = Object.fromEntries(
		Object.entries(state).map(([id, quota]) => {
			const out: LegacyQuota = { stale: quota.stale, expiresAt: quota.expiresAt };
			for (const cell of quota.cells) {
				if (cell.kind !== "percent" || cell.placeholder) continue;
				if (id === "anthropic" && cell.name === "five_hour") {
					out.fiveHourReported = true;
					out.fiveHour = cell.remaining;
					if (cell.resetAt !== undefined) out.fiveHourResetAt = cell.resetAt;
				} else {
					out.weekly = cell.remaining;
					if (cell.resetAt !== undefined) out.weeklyResetAt = cell.resetAt;
					if (cell.unidentified) out.weeklyUnknown = true;
				}
			}
			return [id, out];
		}),
	);
	originals.set(projected, state);
	return projected;
}

const q = {
	...footer,
	parseUsageReply(value: unknown, now: number, previous?: LegacyState): LegacyState | undefined {
		const state = footer.parseUsageReply(value, now, previous && legacyInput(previous));
		return state && legacyOutput(state);
	},
	markStale: (state: LegacyState) => legacyOutput(footer.markStale(legacyInput(state))),
	formatQuotaRow: (state: LegacyState, ...args: Tail<Parameters<typeof footer.formatQuotaRow>>) =>
		footer.formatQuotaRow(legacyInput(state), ...args),
	fitQuotaRows: (state: LegacyState, ...args: Tail<Parameters<typeof footer.fitQuotaRows>>) =>
		footer.fitQuotaRows(legacyInput(state), ...args),
	createQuotaPoller(deps: footer.PollerDeps) {
		const poller = footer.createQuotaPoller(deps);
		return {
			...poller,
			getState() {
				const state = poller.getState();
				return state && legacyOutput(state);
			},
		};
	},
};
type Tail<T> = T extends [unknown, ...infer Rest] ? Rest : never;

const plain = (_c: string, t: string): string => t;

// Share the router's golden data, not its implementation. The router suite checks the projected views.
const fixture = JSON.parse(
	readFileSync(new URL("../../subscription-router/tests/fixtures/views.json", import.meta.url), "utf8"),
) as {
	views: {
		name: string;
		now: number;
		timeZone: string;
		usage: { views: { snapshot?: unknown }[] };
		legacyRows?: { full: string; compact: string };
	}[];
};
const legacyFixtures = fixture.views.flatMap((row) => (row.legacyRows ? [{ ...row, legacyRows: row.legacyRows }] : []));

test.each(legacyFixtures)("preserves the legacy footer bytes for $name", ({ usage, now, timeZone, legacyRows }) => {
	const snapshots = usage.views.flatMap((view) => (view.snapshot ? [view.snapshot] : []));
	for (const data of [{ snapshots }, usage]) {
		const state = present(footer.parseUsageReply({ success: true, data }, now));
		for (const tier of ["full", "compact"] as const) {
			assert.equal(footer.formatQuotaRow(state, tier, plain, { now, timeZone }), legacyRows[tier]);
		}
	}
});

/** Assert a fixture result exists before using it. */
function present<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}

/** Bus lookup fails at the missing subscription, not at a later invocation. */
class Handlers extends Map<string, (data: unknown) => void> {
	require(channel: string): (data: unknown) => void {
		return present(this.get(channel));
	}
}

function fakeEnv() {
	const handlers = new Handlers();
	const emitted: { ch: string; data: { requestId: string; refresh: boolean } }[] = [];
	const timers: { ms: number; live: boolean; fn: () => void }[] = [];
	let intervals = 0;
	let changes = 0;
	const events = {
		on(ch: string, fn: (data: unknown) => void): () => void {
			handlers.set(ch, fn);
			return () => handlers.delete(ch);
		},
		emit(ch: string, data: unknown): void {
			assert.ok(data && typeof data === "object" && "requestId" in data && "refresh" in data);
			assert.ok(typeof data.requestId === "string");
			assert.ok(typeof data.refresh === "boolean");
			emitted.push({ ch, data: { requestId: data.requestId, refresh: data.refresh } });
		},
	};
	let n = 0;
	const clock = { now: NOW };
	const deps = {
		events,
		onChange: () => changes++,
		now: () => clock.now,
		newId: () => `id${++n}`,
		setTimeout: (fn: () => void, ms: number) => {
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
		clearTimeout: (h: unknown) => {
			assert.ok(typeof h === "number");
			present(timers[h]).live = false;
		},
		setInterval: (_fn: () => void, _ms: number) => ++intervals,
		clearInterval: () => {
			intervals--;
		},
	};
	const live = (ms: number) => timers.filter((t) => t.live && t.ms === ms);
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
	anthropic: { fiveHourReported: true, fiveHour: 76, weekly: 58, stale: false, expiresAt: NOW + 10 },
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
	assert.deepEqual(state?.anthropic, {
		fiveHourReported: true,
		fiveHour: 76,
		weekly: 58,
		stale: false,
		expiresAt: NOW + 5,
	});
	// OpenAI has no 5h quota: its "5h" window is never surfaced.
	assert.deepEqual(state?.["openai-codex"], {
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
		assert.equal(state?.anthropic?.stale, true, name);
	}
	const noWindows = { ...ok({ expiresAt: NOW + 5 }), windows: "nope" };
	assert.equal(q.parseUsageReply(reply([noWindows]), NOW)?.anthropic?.stale, true);
});

test("parse: provider error/unavailable/empty windows retain last-known values as stale", () => {
	for (const extra of [
		{ status: "error", windows: [] },
		{ status: "unavailable", windows: [] },
		{ windows: [] },
		{ windows: undefined },
	]) {
		const state = q.parseUsageReply(reply([snap("anthropic", [], { expiresAt: NOW + 5, ...extra })]), NOW, prior);
		assert.equal(state?.anthropic?.stale, true);
		assert.equal(state?.anthropic?.fiveHour, 76);
		assert.equal(state?.anthropic?.weekly, 58);
		// provider missing from reply entirely
		assert.equal(state?.["openai-codex"]?.stale, true);
		assert.equal(state?.["openai-codex"]?.weekly, 63);
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
	assert.equal(state?.anthropic?.fiveHour, 50);
	assert.equal(state?.anthropic?.weekly, 58);
	assert.equal(state?.anthropic?.stale, true);
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
	assert.deepEqual(state?.anthropic, {
		fiveHourReported: true,
		fiveHour: undefined,
		stale: false,
		expiresAt: NOW + 5,
	});
	assert.equal(state?.["openai-codex"]?.fiveHour, undefined);
	assert.equal(state?.["openai-codex"]?.stale, false);
});

test("format: full, compact, boundaries and colors", () => {
	const state = {
		anthropic: { fiveHourReported: true, fiveHour: 76, weekly: 58, stale: false },
		"openai-codex": { fiveHour: 82, weekly: 63, stale: false },
	};
	assert.equal(q.formatQuotaRow(state, "full", plain), "Quota left: Anthropic 5h 76% weekly 58% | OpenAI weekly 63%");
	assert.equal(q.formatQuotaRow(state, "compact", plain), "Left: Anth 5h 76% 7d 58% | OAI 7d 63%");
	const colorsFor = (value: number) => {
		const colors: string[] = [];
		q.formatQuotaRow({ anthropic: { fiveHourReported: true, fiveHour: value, stale: false } }, "compact", (c, t) => {
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
	const text = q.formatQuotaRow({ anthropic: { fiveHourReported: true, fiveHour: 3, stale: true } }, "compact", plain);
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
	assert.match(present(x), /^[0-9a-f-]{36}$/);
	assert.equal(present(env.emitted[0]).ch, "router:rpc:usage");
	assert.equal(present(env.emitted[0]).data.refresh, true);
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
	present(env.live(12_000)[0]).fn();
	assert.equal(poller.getState(), undefined);
	assert.equal(env.changes(), 0);
	assert.equal(env.handlers.size, 0);
	poller.dispose();
});

test("poller: timeout after data keeps figures, marks stale, notifies", () => {
	const env = fakeEnv();
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(both());
	assert.equal(poller.getState()?.anthropic?.stale, false);
	assert.equal(env.changes(), 1);
	tick();
	assert.equal(env.emitted.length, 2);
	tick(); // outstanding: no second request
	assert.equal(env.emitted.length, 2);
	const before = env.changes();
	present(env.live(12_000)[0]).fn();
	const state = poller.getState();
	assert.equal(state?.anthropic?.stale, true);
	assert.equal(state?.anthropic?.fiveHour, 76);
	assert.equal(state?.["openai-codex"]?.weekly, 63);
	assert.equal(env.changes(), before + 1);
	assert.equal(env.handlers.size, 0);
	poller.dispose();
});

test("poller: error reply and failed snapshot retain values", () => {
	const env = fakeEnv();
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(both());
	tick();
	env.handlers.require("router:rpc:usage:reply:id2")({
		success: false,
		error: "boom",
	});
	assert.equal(poller.getState()?.anthropic?.stale, true);
	assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
	tick();
	env.handlers.require("router:rpc:usage:reply:id3")(
		reply([snap("anthropic", [], { status: "error" }), snap("openai-codex", [], { status: "unavailable" })]),
	);
	assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
	assert.equal(poller.getState()?.["openai-codex"]?.weekly, 63);
	assert.equal(poller.getState()?.anthropic?.stale, true);
	poller.dispose();
});

test("poller: staleness progresses with the clock while a request is pending", () => {
	const env = fakeEnv();
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(
		reply([
			ok({ expiresAt: NOW + 5_000 }),
			snap("openai-codex", [win("5h", 18), win("7d", 37)], {
				expiresAt: NOW + 9_000,
			}),
		]),
	);
	tick(); // request pending from here on
	assert.equal(poller.getState()?.anthropic?.stale, false);
	const expiry = env.live(5_000);
	assert.equal(expiry.length, 1);

	env.clock.now = NOW + 5_000;
	const before = env.changes();
	present(expiry[0]).fn(); // timer fires: notify, schedule next
	assert.equal(env.changes(), before + 1);
	let state = poller.getState();
	assert.equal(state?.anthropic?.stale, true);
	assert.equal(state?.anthropic?.fiveHour, 76);
	assert.equal(state?.["openai-codex"]?.stale, false);
	assert.equal(env.live(4_000).length, 1);

	env.clock.now = NOW + 9_000;
	present(env.live(4_000)[0]).fn();
	state = poller.getState();
	assert.equal(state?.["openai-codex"]?.stale, true);
	assert.equal(state?.["openai-codex"]?.weekly, 63);
	poller.dispose();
	assert.equal(env.live(5_000).length + env.live(4_000).length, 0);
});

test("poller: an expiry onChange that disposes the poller leaves no timer armed", () => {
	const env = fakeEnv();
	let disposeOnChange = false;
	const poller = q.createQuotaPoller({
		...env.deps,
		onChange: () => {
			if (disposeOnChange) poller.dispose();
		},
	});
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(
		reply([
			ok({ expiresAt: NOW + 5_000 }),
			snap("openai-codex", [win("5h", 18), win("7d", 37)], { expiresAt: NOW + 9_000 }),
		]),
	);
	const expiry = env.live(5_000);
	assert.equal(expiry.length, 1);
	disposeOnChange = true;
	env.clock.now = NOW + 5_000;
	present(expiry[0]).fn();
	assert.equal(env.timers.filter((t) => t.live).length, 0); // without the guard, a 4s expiry re-arms
});

test("poller: late replies are ignored after dispose, timeout and supersession", () => {
	const env = fakeEnv();
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	const late1 = env.handlers.require("router:rpc:usage:reply:id1");
	present(env.live(12_000)[0]).fn(); // times out with nothing
	late1(both());
	assert.equal(poller.getState(), undefined);
	assert.equal(env.changes(), 0);

	tick(); // id2 outstanding
	const late2 = env.handlers.require("router:rpc:usage:reply:id2");
	assert.ok(late2);
	poller.dispose();
	late2(both());
	assert.equal(env.changes(), 0);
	assert.equal(poller.getState(), undefined);
	tick();
	assert.equal(env.emitted.length, 2);
	assert.equal(env.handlers.size, 0);
});

test("poller: default timers retry, expire readings and cancel pending work", () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const env = fakeEnv();
	const poller = q.createQuotaPoller({ events: env.deps.events, onChange: env.deps.onChange });
	try {
		poller.start();
		assert.equal(env.emitted.length, 1);
		const firstId = present(env.emitted[0]).data.requestId;
		assert.match(firstId, /^[\da-f-]{36}$/);
		env.handlers.require(`${q.USAGE_CHANNEL}:reply:${firstId}`)(reply([ok({ expiresAt: NOW + 5_000 })]));
		assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
		assert.equal(poller.getState()?.anthropic?.stale, false);
		vi.advanceTimersByTime(5_000);
		assert.equal(poller.getState()?.anthropic?.stale, true);
		assert.equal(env.changes(), 2);
		vi.advanceTimersByTime(55_000);
		assert.equal(env.emitted.length, 2);
		assert.notEqual(present(env.emitted[1]).data.requestId, firstId);
		assert.equal(env.handlers.size, 1);
		poller.dispose();
		assert.equal(env.handlers.size, 0);
		assert.equal(vi.getTimerCount(), 0);
		vi.advanceTimersByTime(120_000);
		assert.equal(env.emitted.length, 2);
		assert.equal(env.changes(), 2);
	} finally {
		poller.dispose();
		vi.useRealTimers();
	}
});

test("poller: synchronous emit failure cleans up and retries without losing figures", () => {
	const env = fakeEnv();
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require(`${q.USAGE_CHANNEL}:reply:id1`)(both());
	const emit = env.deps.events.emit;
	env.deps.events.emit = () => {
		throw new Error("router unavailable");
	};
	assert.doesNotThrow(() => tick());
	assert.equal(env.handlers.size, 0);
	assert.equal(env.live(q.REPLY_TIMEOUT_MS).length, 0);
	assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
	assert.equal(poller.getState()?.anthropic?.stale, true);
	assert.equal(env.changes(), 2);
	env.deps.events.emit = emit;
	tick();
	assert.equal(env.handlers.size, 1);
	env.handlers.require(`${q.USAGE_CHANNEL}:reply:id3`)(both());
	assert.equal(poller.getState()?.anthropic?.stale, false);
	assert.equal(env.changes(), 3);
	poller.dispose();
});

test("poller: a bus that replays during subscription settles once before its unsubscribe exists", () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const env = fakeEnv();
	let offCalls = 0;
	env.deps.events.on = (_channel, handler) => {
		handler(both());
		return () => offCalls++;
	};
	const poller = q.createQuotaPoller({ events: env.deps.events, onChange: env.deps.onChange });
	try {
		poller.start();
		assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
		assert.equal(env.changes(), 1);
		// The already-settled token's later deadline cannot overwrite a valid reply.
		vi.advanceTimersByTime(q.REPLY_TIMEOUT_MS);
		assert.equal(poller.getState()?.anthropic?.stale, false);
		assert.equal(env.changes(), 1);
		assert.equal(offCalls, 0);
	} finally {
		poller.dispose();
		vi.useRealTimers();
	}
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
	let tick: () => void = () => assert.fail("interval not registered");
	env.deps.setInterval = (fn) => {
		tick = fn;
		return 1;
	};
	const poller = q.createQuotaPoller(env.deps);
	poller.start();
	const late1 = env.handlers.require("router:rpc:usage:reply:id1");
	present(env.live(12_000)[0]).fn();
	tick();
	late1(both());
	assert.equal(poller.getState(), undefined);
	env.handlers.require("router:rpc:usage:reply:id2")(both());
	assert.equal(poller.getState()?.anthropic?.fiveHour, 76);
	poller.dispose();
});

// --- reset times ---------------------------------------------------------

const at = (iso: string) => Date.parse(iso);
const resetWin = (name: string, usedPercent: number, resetAt: unknown) => ({ ...win(name, usedPercent), resetAt });

test("parse: reset times come from router windows; OpenAI 5h is ignored even when reported", () => {
	const state = q.parseUsageReply(
		reply([
			snap("anthropic", [resetWin("five_hour", 24, 5_000), resetWin("seven_day", 42, 9_000)]),
			snap("openai-codex", [resetWin("5h", 18, 6_000), resetWin("7d", 37, 8_000)]),
		]),
		NOW,
	);
	assert.equal(state?.anthropic?.fiveHourResetAt, 5_000);
	assert.equal(state?.anthropic?.weeklyResetAt, 9_000);
	assert.equal(state?.["openai-codex"]?.weekly, 63);
	assert.equal(state?.["openai-codex"]?.weeklyResetAt, 8_000);
	assert.ok(!("fiveHour" in present(state?.["openai-codex"])));
	assert.ok(!("fiveHourResetAt" in present(state?.["openai-codex"])));
});

test("parse: unknown or invalid resetAt is omitted, never invented", () => {
	for (const bad of [undefined, null, 0, -1, Number.NaN, Infinity, "2026-01-01T00:00:00Z"]) {
		const state = q.parseUsageReply(
			reply([snap("anthropic", [resetWin("five_hour", 24, bad), resetWin("seven_day", 42, bad)])]),
			NOW,
		);
		assert.ok(!("fiveHourResetAt" in present(state?.anthropic)), String(bad));
		assert.ok(!("weeklyResetAt" in present(state?.anthropic)), String(bad));
		assert.equal(state?.anthropic?.weekly, 58);
	}
});

test("parse: stale merge keeps a retained percent with its reset; a new percent brings its own", () => {
	const prior = {
		anthropic: {
			fiveHourReported: true,
			fiveHour: 10,
			fiveHourResetAt: 111,
			weekly: 20,
			weeklyResetAt: 222,
			stale: false,
			expiresAt: NOW + 1,
		},
	};
	const failed = { provider: "anthropic", status: "error", windows: [], expiresAt: NOW + 1 };
	const kept = q.parseUsageReply(reply([failed]), NOW, prior);
	assert.equal(kept?.anthropic?.fiveHourResetAt, 111);
	assert.equal(kept?.anthropic?.weeklyResetAt, 222);
	const partial = q.parseUsageReply(reply([{ ...failed, windows: [resetWin("seven_day", 50, 333)] }]), NOW, prior);
	assert.deepEqual(
		[
			partial?.anthropic?.fiveHour,
			partial?.anthropic?.fiveHourResetAt,
			partial?.anthropic?.weekly,
			partial?.anthropic?.weeklyResetAt,
		],
		[10, 111, 50, 333],
	);
	// New weekly percent without a reset does not inherit the old reset.
	const noReset = q.parseUsageReply(reply([{ ...failed, windows: [win("seven_day", 60)] }]), NOW, prior);
	assert.equal(noReset?.anthropic?.weekly, 40);
	assert.ok(!("weeklyResetAt" in noReset.anthropic));
	// Fresh replacement drops everything it does not report.
	const fresh = q.parseUsageReply(reply([snap("anthropic", [win("five_hour", 1)])]), NOW, prior);
	assert.ok(!("weeklyResetAt" in present(fresh?.anthropic)));
	assert.ok(!("fiveHourResetAt" in present(fresh?.anthropic)));
	assert.equal(q.markStale(prior)?.anthropic?.fiveHourResetAt, 111);
});

const UTC = "UTC";
const CLOCK = at("2026-01-10T12:00:00Z");
const resetState = (extra = {}) => ({
	anthropic: {
		fiveHourReported: true,
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
		"Quota left: Anthropic (stale) weekly -- | OpenAI (stale) weekly --",
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
		{ anthropic: { fiveHourReported: true, fiveHour: 3, fiveHourResetAt: CLOCK + 60_000, stale: false } },
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
	const rows = (width: number, state = resetState()) => q.fitQuotaRows(state, width, plain, opts);
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
const span = (name: string, usedPercent: number, durationMs: number, spanSource: string, resetAt: number) => ({
	...win(name, usedPercent),
	durationMs,
	spanSource,
	resetAt,
});
const codexOf = (windows: unknown[]) =>
	present(q.parseUsageReply(reply([snap("openai-codex", windows, { expiresAt: NOW + 5 })]), NOW)?.["openai-codex"]);

test("identity: reported weekly primary (no 5h, no secondary) is weekly with its reset", () => {
	const state = present(codexOf([span("7d", 38, WEEK, "reported", 9_000)]));
	assert.deepEqual(state, { weekly: 62, weeklyResetAt: 9_000, stale: false, expiresAt: NOW + 5 });
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: weekly is chosen by reported duration, not by name", () => {
	const state = present(codexOf([span("weekly-ish", 10, WEEK, "reported", 7_000)]));
	assert.equal(state.weekly, 90);
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: reported 18000s window is hidden; with no weekly the provider shows `weekly --`", () => {
	const state = present(codexOf([span("5h", 10, 18_000_000, "reported", 7_000)]));
	assert.equal(state.weekly, undefined);
	assert.ok(!("fiveHour" in state));
	assert.ok(!("weeklyUnknown" in state));
	assert.equal(
		q.formatQuotaRow({ "openai-codex": state }, "full", plain, { now: CLOCK }).split("| ")[1],
		"OpenAI weekly --",
	);
});

test("identity: reported other spans (3600s) never become weekly or unknown", () => {
	const state = present(codexOf([span("3600s", 10, 3_600_000, "reported", 7_000)]));
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
	const state = present(
		codexOf([span("5h", 99, 18_000_000, "assumed", 1_000), span("7d", 38, WEEK, "reported", 9_000)]),
	);
	assert.deepEqual([state.weekly, state.weeklyResetAt], [62, 9_000]);
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: an assumed `7d` (positional secondary) is not proven weekly", () => {
	const state = present(codexOf([span("7d", 38, WEEK, "assumed", 9_000)]));
	assert.equal(state.weeklyUnknown, true);
});

test("identity: snapshots without spanSource keep the legacy `7d` behavior and ignore legacy 5h", () => {
	const state = present(codexOf([resetWin("5h", 99, 1_000), resetWin("7d", 38, 9_000)]));
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
	const kept = q.parseUsageReply(reply([failed]), NOW, unknownPrior)?.["openai-codex"];
	assert.ok(kept);
	assert.deepEqual([kept.weekly, kept.weeklyResetAt, kept.weeklyUnknown, kept.stale], [40, 5_000, true, true]);
	// Proven weekly arrives later: replaces the unidentified reading and clears the flag.
	const proven = q.parseUsageReply(
		reply([{ ...failed, windows: [span("7d", 10, WEEK, "reported", 6_000)] }]),
		NOW,
		unknownPrior,
	)?.["openai-codex"];
	assert.ok(proven);
	assert.deepEqual([proven.weekly, proven.weeklyResetAt], [90, 6_000]);
	assert.ok(!("weeklyUnknown" in proven));
	// An unidentified reading cannot displace a retained proven weekly.
	const provenPrior = { "openai-codex": { weekly: 70, weeklyResetAt: 4_000, stale: false, expiresAt: NOW + 1 } };
	const guarded = q.parseUsageReply(
		reply([{ ...failed, windows: [span("5h", 10, 18_000_000, "assumed", 6_000)] }]),
		NOW,
		provenPrior,
	)?.["openai-codex"];
	assert.ok(guarded);
	assert.deepEqual([guarded.weekly, guarded.weeklyResetAt], [70, 4_000]);
	assert.ok(!("weeklyUnknown" in guarded));
});

test("format: unidentified OpenAI quota says so, full and compact, with date and time", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	const state = {
		anthropic: {
			fiveHourReported: true,
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
	assert.ok(!/weekly|7d/.test(present(q.formatQuotaRow(bare, "full", plain, opts).split("| ")[1])));
	// A past reset omits only the text.
	const past = { "openai-codex": { weekly: 62, weeklyResetAt: CLOCK - 1, weeklyUnknown: true, stale: false } };
	assert.equal(q.formatQuotaRow(past, "full", plain, opts).split("| ")[1], "OpenAI quota 62% (window unknown)");
	// Narrowest layout keeps the `?` provenance.
	assert.equal(q.fitQuotaRows(state, 20, plain, opts).at(-1), "OAI quota? 62%");
});

test("format: a past reset never blanks a percent or changes its color", () => {
	const opts = { now: CLOCK, timeZone: UTC };
	const colored: string[] = [];
	const text = q.formatQuotaRow(
		{
			anthropic: {
				fiveHourReported: true,
				fiveHour: 3,
				fiveHourResetAt: CLOCK - 1,
				weekly: 4,
				weeklyResetAt: CLOCK,
				stale: false,
			},
		},
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
	)?.anthropic;
	assert.ok(anth);
	assert.deepEqual([anth.fiveHour, anth.weekly], [90, undefined]);
	const nanSecond = codexOf([span("5h", 30, 1, "assumed", 1_000), span("7d", Number.NaN, 2, "assumed", 2_000)]);
	assert.deepEqual([nanSecond.weekly, nanSecond.weeklyResetAt], [70, 1_000]);
	const nanFirst = codexOf([span("5h", Number.NaN, 1, "assumed", 1_000), span("7d", 30, 2, "assumed", 2_000)]);
	assert.deepEqual([nanFirst.weekly, nanFirst.weeklyResetAt], [70, 2_000]);
	const looser = codexOf([span("5h", 30, 1, "assumed", 1_000), span("7d", 10, 2, "assumed", 2_000)]);
	assert.equal(looser.weekly, 70);
});

test("identity: a reported span wins over the name (reported 18000s named `7d` is not weekly)", () => {
	const state = present(codexOf([span("7d", 10, 18_000_000, "reported", 9_000)]));
	assert.equal(state.weekly, undefined);
	assert.ok(!("weeklyUnknown" in state));
});

test("identity: reported 18000s primary plus assumed secondary shows only the unknown quota, never 5h/weekly", () => {
	const state = present(
		codexOf([span("5h", 10, 18_000_000, "reported", 1_000), span("7d", 40, WEEK, "assumed", 2_000)]),
	);
	assert.deepEqual([state.weekly, state.weeklyResetAt, state.weeklyUnknown], [60, 2_000, true]);
	const text = q.formatQuotaRow({ "openai-codex": state }, "full", plain, { now: CLOCK, timeZone: UTC });
	assert.equal(text, "Quota left: Anthropic (stale) weekly -- | OpenAI quota 60% (window unknown)");
	assert.ok(!/OpenAI (5h|weekly)/.test(text));
});

// --- Anthropic 5h only when reported (#311) ---------------------------------

const anthOf = (windows: unknown[], extra: Record<string, unknown> = {}, previous?: LegacyState) =>
	present(q.parseUsageReply(reply([snap("anthropic", windows, { expiresAt: NOW + 5, ...extra })]), NOW, previous));
const weeklyOnly = (extra: Record<string, unknown> = {}, previous?: LegacyState) =>
	anthOf([resetWin("seven_day", 40, at("2026-01-14T09:00:00Z"))], extra, previous);

test("5h: a fresh Anthropic snapshot with only seven_day has no 5h segment in any layout", () => {
	const state = weeklyOnly();
	assert.deepEqual(state?.anthropic, {
		weekly: 60,
		weeklyResetAt: at("2026-01-14T09:00:00Z"),
		stale: false,
		expiresAt: NOW + 5,
	});
	const opts = { now: CLOCK, timeZone: UTC };
	const rows = (width: number) => q.fitQuotaRows(state, width, plain, opts);
	const full = "Quota left: Anthropic weekly 60% (resets Jan 14 09:00) | OpenAI (stale) weekly --";
	const compact = "Left: Anth 7d 60% @Jan 14 09:00 | OAI (stale) 7d --";
	assert.equal(q.formatQuotaRow(state, "full", plain, opts), full);
	assert.equal(q.formatQuotaRow(state, "compact", plain, opts), compact);
	assert.deepEqual(rows(full.length), [full]);
	assert.deepEqual(rows(full.length - 1), [compact]);
	assert.deepEqual(rows(compact.length - 1), ["Left: Anth 7d 60% @Jan 14 09:00", "OAI (stale) 7d --"]);
	assert.deepEqual(rows(30), ["Left: Anth 7d 60%", "OAI (stale) 7d --"]);
	for (const width of [full.length, compact.length, compact.length - 1, 30, 5])
		for (const row of rows(width)) assert.ok(!row.includes("5h"), `${width}: ${row}`);
});

test("5h: a reported idle window (0% used, no reset) still renders as 5h 100%", () => {
	const state = anthOf([win("five_hour", 0), win("seven_day", 40)]);
	assert.equal(state?.anthropic?.fiveHourReported, true);
	assert.equal(
		q.formatQuotaRow(state, "compact", plain, { now: CLOCK }),
		"Left: Anth 5h 100% 7d 60% | OAI (stale) 7d --",
	);
	// Reported but invalid stays a `--` segment, distinct from not reported.
	const invalid = anthOf([win("five_hour", Number.NaN), win("seven_day", 40)]);
	assert.equal(q.formatQuotaRow(invalid, "compact", plain, { now: CLOCK }).split(" | ")[0], "Left: Anth 5h -- 7d 60%");
	// A model-scoped window of the same name is not the provider 5h quota.
	const model = anthOf([win("five_hour", 10, "model"), win("seven_day", 40)]);
	assert.ok(!("fiveHourReported" in present(model.anthropic)));
});

test("5h: a stale reply never brings back a 5h the last fresh reading left out", () => {
	const fresh = weeklyOnly();
	// The router's stale snapshot still carries the window cached before the plan change.
	const stale = anthOf([win("five_hour", 100), win("seven_day", 50)], { status: "stale" }, fresh);
	assert.deepEqual(stale?.anthropic, { weekly: 50, stale: true, expiresAt: NOW + 5 });
	const failed = anthOf([], { status: "error" }, stale);
	assert.deepEqual(failed?.anthropic, { weekly: 50, stale: true, expiresAt: NOW + 5 });
	assert.equal(q.formatQuotaRow(failed, "compact", plain, { now: CLOCK }).split(" | ")[0], "Left: Anth (stale) 7d 50%");
	assert.ok(!("fiveHourReported" in present(q.markStale(failed).anthropic)));
});

test("5h: a stale reply keeps a 5h the last fresh reading had, value merged per field", () => {
	const fresh = anthOf([win("five_hour", 24), win("seven_day", 42)]);
	const missing = q.parseUsageReply(reply([]), NOW, fresh);
	assert.deepEqual(missing?.anthropic, {
		fiveHourReported: true,
		fiveHour: 76,
		weekly: 58,
		stale: true,
		expiresAt: NOW + 5,
	});
	const newer = anthOf([win("five_hour", 50)], { status: "stale" }, missing);
	assert.deepEqual([newer?.anthropic?.fiveHourReported, newer?.anthropic?.fiveHour], [true, 50]);
});

test("5h: before any fresh reading, stale shows what the stale replies carry", () => {
	const first = anthOf([win("five_hour", 30), win("seven_day", 40)], { status: "stale" });
	assert.deepEqual(first?.anthropic, {
		fiveHourReported: true,
		fiveHour: 70,
		weekly: 60,
		stale: true,
		expiresAt: undefined,
	});
	// A later stale reply without the provider retains the reading, presence included.
	const retained = q.parseUsageReply(reply([]), NOW, first);
	assert.deepEqual([retained?.anthropic?.fiveHourReported, retained?.anthropic?.fiveHour], [true, 70]);
	const without = anthOf([win("seven_day", 40)], { status: "stale" });
	assert.deepEqual(without.anthropic, { weekly: 60, stale: true, expiresAt: undefined });
	assert.equal(
		q.formatQuotaRow(without, "full", plain, { now: CLOCK }),
		"Quota left: Anthropic (stale) weekly 60% | OpenAI (stale) weekly --",
	);
});

test("5h: each fresh snapshot adds or removes the segment (tier change mid-session)", () => {
	const with5h = anthOf([win("five_hour", 10), win("seven_day", 40)]);
	const dropped = weeklyOnly({}, with5h);
	assert.ok(!("fiveHourReported" in present(dropped.anthropic)));
	assert.ok(!("fiveHour" in present(dropped.anthropic)));
	const back = anthOf([win("five_hour", 20), win("seven_day", 40)], {}, dropped);
	assert.deepEqual([back?.anthropic?.fiveHourReported, back?.anthropic?.fiveHour], [true, 80]);
	// A stale reply after the re-add keeps it.
	assert.equal(q.parseUsageReply(reply([]), NOW, back)?.anthropic?.fiveHour, 80);
});

test("5h: the no-data placeholder shows only the weekly window", () => {
	assert.equal(
		q.formatQuotaRow({}, "full", plain, { now: CLOCK }),
		"Quota left: Anthropic (stale) weekly -- | OpenAI (stale) weekly --",
	);
	assert.equal(q.formatQuotaRow({}, "compact", plain, { now: CLOCK }), "Left: Anth (stale) 7d -- | OAI (stale) 7d --");
});
const v2 = (views: unknown[]) => ({ success: true, data: { version: 2, views, snapshots: [], blocks: [] } });
const view = (provider: string, extra: Record<string, unknown> = {}) => ({ provider, ...extra });
const projected = (views: unknown[], now = CLOCK, previous?: footer.QuotaState) =>
	present(footer.parseUsageReply(v2(views), now, previous));
const fixed = { now: CLOCK, timeZone: UTC };
const hour = 3_600_000;
const meter = (name: string, used: number, extra = {}) => ({
	name,
	scope: "provider",
	basis: "observed",
	quantity: { unit: "requests", used },
	...extra,
});
const mark = (until: number, evidence?: string, families?: string[]) => ({ until, evidence, families });
/** A fresh, empty snapshot: meters, pools and marks are current until it expires. */
const fresh = (provider: string, extra: Record<string, unknown> = {}) =>
	snap(provider, [], { expiresAt: CLOCK + hour, ...extra });

test("preset reads the shared metered and inferred-span v2 fixture", () => {
	const metered = present(fixture.views.find(({ name }) => name === "metered"));
	const state = present(footer.parseUsageReply({ success: true, data: metered.usage }, metered.now));
	const opts = { now: metered.now, timeZone: metered.timeZone };
	assert.equal(
		footer.formatQuotaRow(state, "compact", plain, opts),
		"Left: Goog 1d 37/250 req obs @Jan 16 08:00 $1.24/10m obs prepaid-credits 12 credits | faux-fast blocked->08:00 inf",
	);
	assert.deepEqual(footer.fitQuotaRows(state, 120, plain, opts).length, 1);
	const inferred = present(fixture.views.find(({ name }) => name === "inferred-span"));
	const gauge = present(footer.parseUsageReply({ success: true, data: inferred.usage }, inferred.now));
	// Deliberately changed from a bare `10m`: an inferred span must never read as a reported one.
	assert.match(
		footer.formatQuotaRow(gauge, "compact", plain, { now: inferred.now, timeZone: inferred.timeZone }),
		/faux-subscription 10m~ 0%/,
	);
	assert.match(
		footer.formatQuotaRow(gauge, "full", plain, { now: inferred.now, timeZone: inferred.timeZone }),
		/faux-subscription 10m 0% \(span inferred\)/,
	);
});

test("Google rows show counts without invented limits and marks in warning color", () => {
	const now = at("2026-11-21T14:05:00Z");
	const until = at("2026-11-22T00:00:00Z");
	const state = projected(
		[
			view("google", {
				display: { full: "Google", compact: "Goog" },
				snapshot: snap("google", [], { expiresAt: until + hour }),
				meters: [
					meter("rpd", 37, {
						kind: "calendar",
						resetRule: { every: "day" },
						scope: "model",
						families: ["gemini-4-carbon"],
					}),
					meter("cost", 1.24, { kind: "rolling", durationMs: 600_000, quantity: { unit: "usd", used: 1.24 } }),
					meter("other", 25, { scope: "model", families: ["gemini-4-sibling"] }),
				],
				marks: [mark(until, "inferred", ["gemini-4-carbon"])],
			}),
			view("google-vertex", { meters: [meter("calls", 0)] }),
		],
		now,
	);
	const opts = { now, timeZone: UTC };
	const compact = "Left: Goog 1d 37 req obs $1.24/10m obs | carbon blocked->00:00 inf";
	const full =
		"Quota left: Google day 37 requests observed; $1.24 last 10m observed; gemini-4-carbon blocked until Nov 22 00:00 (inferred)";
	const paint: string[] = [];
	assert.equal(footer.formatQuotaRow(state, "full", plain, opts), full);
	assert.equal(
		footer.formatQuotaRow(
			state,
			"compact",
			(color, text) => {
				paint.push(`${color}:${text}`);
				return text;
			},
			opts,
		),
		compact,
	);
	assert.deepEqual(
		paint.filter((text) => !text.startsWith("dim:")),
		["warning:carbon blocked->00:00 inf"],
	);
	assert.match(
		footer.formatQuotaRow(state, "compact", plain, { ...opts, model: { provider: "google", id: "gemini-4-sibling" } }),
		/other 25 req obs/,
	);
	assert.equal(footer.formatQuotaRow(state, "compact", plain, { ...opts, now: until }), "Left: Goog $1.24/10m obs");
	assert.equal(footer.formatQuotaRow(projected([]), "full", plain, fixed), "");
});

test("generic width ladder fits, drops meters, caps providers and clips by priority", () => {
	const window = (name: string, remaining: number, durationMs: number) => ({
		...win(name, 100 - remaining),
		durationMs,
		resetAt: CLOCK + hour,
	});
	const provider = (id: string) =>
		view(id, {
			display: { full: `${id}-long`, compact: id },
			snapshot: snap(id, [window("loose", 95, 2 * hour), window("tight", 3, hour)], { expiresAt: CLOCK + hour }),
			meters: [meter("count", 37)],
			marks: [mark(CLOCK + hour, "observed")],
		});
	const state = projected([provider("A"), provider("B")]);
	const full = footer.formatQuotaRow(state, "full", plain, fixed);
	const compact = footer.formatQuotaRow(state, "compact", plain, fixed);
	const fit = (width: number, input = state) => footer.fitQuotaRows(input, width, plain, fixed);
	assert.deepEqual(fit(full.length), [full]);
	assert.deepEqual(fit(compact.length), [compact]);
	const split = [
		"Left: A 2h 95% @13:00 1h 3% @13:00 count 37 req obs | provider blocked->13:00 obs",
		"B 2h 95% @13:00 1h 3% @13:00 count 37 req obs | provider blocked->13:00 obs",
	];
	assert.deepEqual(fit(present(split[0]).length), split);
	const terse = [
		"Left: A 2h 95% 1h 3% count 37 req obs | provider blocked obs",
		"B 2h 95% 1h 3% count 37 req obs | provider blocked obs",
	];
	assert.deepEqual(fit(present(terse[0]).length), terse);
	const essential = ["Left: A 2h 95% 1h 3% | provider blocked obs", "B 2h 95% 1h 3% | provider blocked obs"];
	assert.deepEqual(fit(present(essential[0]).length), essential);
	assert.deepEqual(fit(41), ["Left: A provider blocked obs 1h 3% 2h 95%", "B provider blocked obs 1h 3% 2h 95%"]);
	// Narrower, whole low-priority cells give way behind ` ...`, then the mark scope, never the evidence.
	assert.deepEqual(fit(38), ["Left: A provider blocked obs 1h 3% ...", "B provider blocked obs 1h 3% 2h 95%"]);
	assert.deepEqual(fit(20), ["Left: A blocked obs", "B blocked obs ..."]);
	assert.deepEqual(fit(70, projected(["A", "B", "C", "D", "E"].map(provider))), [
		"Left: A provider blocked obs 1h 3% 2h 95%",
		"B provider blocked obs 1h 3% 2h 95%",
		"C provider blocked obs 1h 3% 2h 95%",
		"D provider blocked obs 1h 3% 2h 95%",
		"+1 more (1 blocked): /router status",
	]);
});

test("custom selectors, scope, provenance and display-only quantities stay distinct", () => {
	const durationMs = 2 * hour;
	const windows = [
		{ ...win("named", 80), durationMs },
		{ ...win("hourly", 90), durationMs: hour },
		{ ...win("estimated", 99), durationMs: hour, basis: "observed" },
		{ ...win("named", 70, "model"), families: ["not-selected"] },
		{ scope: "provider", usedPercent: 80 },
		{ ...win("invalid", 80, "model"), families: [] },
	];
	const custom = view("custom", {
		display: {
			full: "Custom\nDisplay",
			compact: " ",
			footer: { show: [null, {}, { name: "named" }, { durationMs: hour }, { name: " " }], placeholder: true },
		},
		snapshot: snap("custom", windows, { expiresAt: CLOCK + hour }),
		meters: [
			{ ...meter("tok", 1), basis: "inferred", quantity: { unit: "tokens", remaining: 8 } },
			{ ...meter("cash", 2), basis: "reported", quantity: { unit: "usd", used: 2 } },
			{ ...meter("invalid", 1), quantity: { unit: "invalid", used: 1 } },
		],
		pools: [null, {}, { name: "wallet", unit: "usd", unlimited: true }, { name: "balance", unit: "credits" }],
		marks: [mark(undefined as unknown as number), mark(CLOCK + hour, undefined, [" "])],
	});
	const state = projected([null, view(""), {}, view(" "), custom]);
	assert.equal(
		footer.formatQuotaRow(state, "compact", plain, fixed),
		"Left: custom 2h 20% 1h 10% quota -- tok 8 tok left inf cash $2.00 rep wallet unlimited balance -- credits | model blocked->13:00 read",
	);
	const stale = projected([{ ...custom, snapshot: undefined }], CLOCK, state);
	assert.match(footer.formatQuotaRow(stale, "full", plain, fixed), /Custom\?Display \(stale\) 2h 20% 1h 10% quota --/);
	const metered = view("meter", { meters: [meter("very-long-meter", 10), meter("second", 3)] });
	assert.deepEqual(footer.fitQuotaRows(projected([metered]), 50, plain, fixed), [
		// No snapshot vouches for these meters, so they are stale.
		"Left: meter (stale) very-long-meter 10 req obs ...",
	]);
	assert.deepEqual(
		footer.fitQuotaRows(projected([metered, view("read", { marks: [mark(CLOCK + hour)] })]), 30, plain, fixed),
		// The label yields so the mark keeps its evidence.
		["Left: re provider blocked read"],
	);
	const narrow = projected([
		view("custom", {
			snapshot: snap("custom", [win("unknown", NaN), win("ok", 60)]),
			marks: [mark(CLOCK + hour, "read")],
		}),
	]);
	assert.deepEqual(footer.fitQuotaRows(narrow, 55, plain, fixed), [
		"Left: custom provider blocked read | (stale) ok 40% ...",
	]);
});

test.each([
	["opus", true],
	["Claude-OPUS-4", true],
	["claude.opus:1", true],
	["xopus-opus", true],
	["xopus", false],
	["opusx", false],
	["claude-opus4", false],
])("model %s matches family `opus` at token boundaries: %s", (id, matches) => {
	const state = projected([
		view("p", { snapshot: fresh("p"), meters: [meter("calls", 3, { scope: "model", families: ["opus"] })] }),
	]);
	const row = footer.formatQuotaRow(state, "compact", plain, { ...fixed, model: { provider: "p", id } });
	assert.equal(row, matches ? "Left: p calls 3 req obs" : "");
});

test("an oversized family never throws while matching the selected model", () => {
	// A regex built from this family is too large for V8; rendering must stay total.
	const family = "(".repeat(100_000);
	const state = projected([
		view("huge", { meters: [meter("calls", 3, { scope: "model", families: [family] })], snapshot: fresh("huge") }),
	]);
	const opts = { ...fixed, model: { provider: "huge", id: `x-${family}` } };
	assert.equal(footer.formatQuotaRow(state, "compact", plain, opts), "Left: huge calls 3 req obs");
	assert.equal(footer.formatQuotaRow(state, "compact", plain, { ...opts, model: { provider: "huge", id: "x" } }), "");
});

test("inferred and assumed spans are qualified on windows and meters, whatever the basis", () => {
	const ten = 600_000;
	const state = (footerData?: unknown) =>
		projected([
			view("faux", {
				display: { full: "Faux", compact: "F", footer: footerData },
				snapshot: snap("faux", [{ ...span("short", 100, ten, "inferred", CLOCK + hour), basis: "reported" }], {
					expiresAt: CLOCK + hour,
				}),
				meters: [
					meter("spend", 2, { durationMs: ten, spanSource: "inferred", quantity: { unit: "usd", used: 2 } }),
					meter("calls", 3, { durationMs: hour, spanSource: "inferred" }),
					meter("rpd", 4, { kind: "calendar", resetRule: { every: "day" }, spanSource: "assumed" }),
					meter("odd", 5, { durationMs: hour, spanSource: "guessed" }),
				],
			}),
		]);
	assert.equal(
		footer.formatQuotaRow(state(), "compact", plain, fixed),
		"Left: F 10m~ 0% @13:00 $2.00/10m~ obs 1h~ 3 req obs rpd? 4 req obs odd? 5 req obs",
	);
	assert.equal(
		footer.formatQuotaRow(state(), "full", plain, fixed),
		"Quota left: Faux 10m 0% (resets 13:00; span inferred) $2.00 last 10m observed (span inferred) 1h 3 requests observed (span inferred) rpd 4 requests observed (window unknown) odd 5 requests observed (window unknown)",
	);
	// An inferred span never satisfies a duration selector as if reported; it stays qualified.
	assert.match(
		footer.formatQuotaRow(state({ show: [{ durationMs: ten }] }), "compact", plain, fixed),
		/^Left: F 10m~ 0% @13:00 /,
	);
});

test("the provider cap never hides a blocked provider without saying so", () => {
	const healthy = (id: string, left: number) =>
		view(id, { snapshot: snap(id, [{ ...win("q", 100 - left), durationMs: hour }], { expiresAt: CLOCK + hour }) });
	const blocked = view("E", { marks: [mark(CLOCK + hour, "inferred")] });
	const fit = (views: unknown[], width = 28) => footer.fitQuotaRows(projected(views), width, plain, fixed);
	// Blocked first, then lowest remaining; the healthiest provider is the one hidden.
	assert.deepEqual(fit([healthy("A", 50), healthy("B", 10), healthy("C", 90), healthy("D", 30), blocked]), [
		"Left: E provider blocked inf",
		"B 1h 10%",
		"D 1h 30%",
		"A 1h 50%",
		"+1 more: /router status",
	]);
	// Too narrow for the pointer: the count still shows.
	assert.equal(
		fit([healthy("A", 50), healthy("B", 10), healthy("C", 90), healthy("D", 30), blocked], 20).at(-1),
		"+1 more",
	);
	const marked = (id: string) => view(id, { marks: [mark(CLOCK + hour, "observed")] });
	assert.deepEqual(fit(["A", "B", "C", "D", "E", "F"].map(marked), 40).at(-1), "+2 more (2 blocked): /router status");
});

test("freshness covers meters and pools, never marks, and error-only views keep a row", () => {
	const data = (extra: Record<string, unknown> = {}) =>
		view("m", {
			snapshot: fresh("m", extra),
			meters: [meter("calls", 3)],
			pools: [{ name: "wallet", unit: "credits", balance: 4 }],
		});
	const row = (input: unknown[], now = CLOCK) =>
		footer.formatQuotaRow(projected(input, now), "compact", plain, { ...fixed, now });
	// A fresh meter-only snapshot is current; once it expires the meters and pools say stale.
	assert.equal(row([data()]), "Left: m calls 3 req obs wallet 4 credits");
	assert.equal(row([data()], CLOCK + hour), "Left: m (stale) calls 3 req obs wallet 4 credits");
	// Rendering a parsed fresh reading after its expiry also says stale.
	assert.equal(
		footer.formatQuotaRow(projected([data()]), "compact", plain, { ...fixed, now: CLOCK + hour }),
		"Left: m (stale) calls 3 req obs wallet 4 credits",
	);
	assert.equal(row([data({ status: "error" })]), "Left: m (stale) calls 3 req obs wallet 4 credits");
	assert.equal(
		row([view("p", { pools: [{ name: "wallet", unit: "usd", balance: 1 }] })]),
		"Left: p (stale) wallet $1.00",
	);
	// The poller ages a fresh meter reading with the clock.
	const env = fakeEnv();
	const poller = footer.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(
		v2([view("m", { snapshot: snap("m", [], { expiresAt: NOW + 5 }), meters: [meter("calls", 3)] })]),
	);
	const polled = () => footer.formatQuotaRow(present(poller.getState()), "compact", plain, { now: env.clock.now });
	assert.equal(polled(), "Left: m calls 3 req obs");
	assert.equal(env.live(5).length, 1);
	env.clock.now += 5;
	assert.equal(polled(), "Left: m (stale) calls 3 req obs");
	poller.dispose();
	// Active marks are current whatever the snapshot: stale data is labelled apart from them.
	const marked = projected([{ ...data(), marks: [mark(CLOCK + 2 * hour, "observed")] }], CLOCK + hour);
	const at = { ...fixed, now: CLOCK + hour };
	assert.equal(
		footer.formatQuotaRow(marked, "compact", plain, at),
		"Left: m (stale) calls 3 req obs wallet 4 credits | provider blocked->14:00 obs",
	);
	assert.deepEqual(footer.fitQuotaRows(marked, 30, plain, at), ["Left: m provider blocked obs"]);
	const onlyMark = projected([view("m", { marks: [mark(CLOCK + hour, "observed")] })]);
	assert.equal(footer.formatQuotaRow(onlyMark, "compact", plain, fixed), "Left: m provider blocked->13:00 obs");
	// Error, unavailable and stale views with nothing to show still render a row.
	const status = (value: string) => view("e", { snapshot: snap("e", [], { status: value, expiresAt: CLOCK + hour }) });
	assert.equal(row([status("error")]), "Left: e quota error");
	assert.equal(
		footer.formatQuotaRow(projected([status("unavailable")]), "full", plain, fixed),
		"Quota left: e quota unavailable",
	);
	assert.deepEqual(footer.fitQuotaRows(projected([status("stale")]), 19, plain, fixed), ["Left: e quota stale"]);
	assert.equal(
		row([{ ...status("error"), marks: [mark(CLOCK + hour, "inferred")] }]),
		"Left: e quota error | provider blocked->13:00 inf",
	);
	// An available but empty snapshot, or no snapshot at all, still has no row.
	assert.equal(row([status("available"), view("none")]), "");
});

test("meters keep their resets and only an observed zero is dropped", () => {
	const state = projected([
		view("m", {
			snapshot: fresh("m"),
			meters: [
				meter("rpd", 37, {
					kind: "calendar",
					resetRule: { every: "day" },
					resetAt: CLOCK + hour,
					spanSource: "inferred",
				}),
				meter("past", 1, { resetAt: CLOCK - hour }),
				meter("idle", 0),
				meter("granted", 0, { basis: "reported" }),
				meter("guess", 0, { basis: "inferred" }),
			],
		}),
	]);
	assert.equal(
		footer.formatQuotaRow(state, "compact", plain, fixed),
		"Left: m 1d~ 37 req obs @13:00 past 1 req obs granted 0 req rep guess 0 req inf",
	);
	assert.equal(
		footer.formatQuotaRow(state, "full", plain, fixed),
		"Quota left: m day 37 requests observed (resets 13:00; span inferred); past 1 requests observed; granted 0 requests reported; guess 0 requests inferred",
	);
	// Layouts without reset times drop the meter reset too.
	assert.deepEqual(footer.fitQuotaRows(state, 71, plain, fixed), [
		"Left: m 1d~ 37 req obs past 1 req obs granted 0 req rep guess 0 req inf",
	]);
	// The Google rule: no calls and no mark, no row.
	assert.deepEqual(
		footer.fitQuotaRows(
			projected([view("g", { snapshot: fresh("g"), meters: [meter("calls", 0)] })]),
			80,
			plain,
			fixed,
		),
		[],
	);
});

test("unrecognized meter basis is skipped and unrecognized mark evidence reads unknown, never promoted", () => {
	const state = projected([
		view("odd", {
			snapshot: fresh("odd"),
			meters: [
				meter("bogus", 9, { basis: "guessed" }),
				meter("null", 1, { basis: null }),
				meter("absent", 2, { basis: undefined }),
			],
			marks: [mark(CLOCK + hour, "guessed"), mark(CLOCK + hour, undefined, ["m"])],
		}),
	]);
	assert.equal(
		footer.formatQuotaRow(state, "compact", plain, fixed),
		"Left: odd absent 2 req rep | provider blocked->13:00 unk m blocked->13:00 read",
	);
	assert.match(footer.formatQuotaRow(state, "full", plain, fixed), /provider blocked until Jan 10 13:00 \(unknown\)/);
});

test("legacy compatibility applies only to legacy footer selections, not to every view with a legacy id", () => {
	const windows = [
		span("five_hour", 25, 5 * hour, "reported", CLOCK + hour),
		span("seven_day", 40, WEEK, "reported", CLOCK + hour),
		{ ...span("seven_day_opus", 90, WEEK, "reported", CLOCK + hour), scope: "model", families: ["opus"] },
	];
	const anthropic = (footerData?: unknown) =>
		view("anthropic", {
			display: { full: "Anthropic", compact: "Anth", footer: footerData },
			snapshot: snap("anthropic", windows, { expiresAt: CLOCK + hour }),
		});
	const opus = { ...fixed, model: { provider: "anthropic", id: "claude-opus-4" } };
	const row = (footerData?: unknown) =>
		footer.formatQuotaRow(projected([anthropic(footerData)]), "compact", plain, { ...opus, now: CLOCK + 1 });
	// The built-in legacy selection keeps the legacy row, model buckets hidden.
	assert.equal(
		row({ show: [{ name: "five_hour" }, { name: "seven_day" }], placeholder: true }),
		"Left: Anth 5h 75% @13:00 7d 60% @Jan 10 13:00",
	);
	// A v2 selection that names the model bucket, or no selection at all, shows the selected model's bucket.
	assert.equal(
		row({ show: [{ name: "seven_day" }, { name: "seven_day_opus" }] }),
		"Left: Anth 7d 60% @Jan 10 13:00 7d 10% @Jan 10 13:00",
	);
	assert.equal(row(), "Left: Anth 5h 75% @13:00 7d 60% @Jan 10 13:00 7d 10% @Jan 10 13:00");
	// A Codex snapshot without span provenance is still weekly under a v2 duration selector.
	const codex = snap("openai-codex", [resetWin("7d", 20, CLOCK + hour)], { expiresAt: CLOCK + hour });
	const v1 = present(footer.parseUsageReply(reply([codex]), CLOCK));
	const wrapped = projected([
		view("openai-codex", {
			display: { full: "OpenAI", compact: "OAI", footer: { show: [{ durationMs: WEEK }] } },
			snapshot: codex,
		}),
	]);
	const codexRow = (state: footer.QuotaState) =>
		footer.formatQuotaRow(state, "compact", plain, fixed).split(" | ").at(-1);
	assert.equal(codexRow(v1), "OAI 7d 80% @Jan 10 13:00");
	assert.equal(codexRow(wrapped), "Left: OAI 7d 80% @Jan 10 13:00");
});

test("poller state is deeply immutable, so a reader cannot corrupt the next render", () => {
	const env = fakeEnv();
	const poller = footer.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(
		v2([
			view("custom", {
				display: { full: "Custom", compact: "C", footer: { show: [{ name: "named" }] } },
				snapshot: snap("custom", [{ ...win("named", 40, "model"), families: ["opus"] }]),
			}),
		]),
	);
	const state = present(poller.getState());
	const quota = present(state.custom);
	const cell = present(quota.cells[0]);
	assert.ok(cell.kind === "percent");
	for (const mutate of [
		() => (quota.cells as unknown[]).push(cell),
		() => (cell.families as string[]).push("sonnet"),
		() => ((quota.display.footer?.show ?? []) as unknown[]).pop(),
		() => Object.assign(quota.display, { compact: "X" }),
		() => Object.assign(state, { other: quota }),
	]) {
		assert.throws(mutate, TypeError);
	}
	assert.deepEqual(present(present(poller.getState()).custom).cells, quota.cells);
	assert.deepEqual(cell.families, ["opus"]);
	poller.dispose();
});

test("mark expiry repaints independently of the snapshot", () => {
	const env = fakeEnv();
	const poller = footer.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(v2([view("metered", { marks: [mark(NOW + 5, "inferred")] })]));
	const rows = () => footer.fitQuotaRows(present(poller.getState()), 80, plain, { now: env.clock.now, timeZone: UTC });
	assert.match(present(rows()[0]), /provider blocked/);
	env.clock.now += 5;
	present(env.live(5)[0]).fn();
	assert.equal(env.changes(), 2);
	assert.deepEqual(rows(), []);
	poller.dispose();
});

test("dispose before a mark expires disarms its timer and never repaints", () => {
	const env = fakeEnv();
	const poller = footer.createQuotaPoller(env.deps);
	poller.start();
	env.handlers.require("router:rpc:usage:reply:id1")(v2([view("metered", { marks: [mark(NOW + 5, "inferred")] })]));
	const expiry = present(env.live(5)[0]);
	const changes = env.changes();
	poller.dispose();
	assert.deepEqual(
		env.timers.filter((timer) => timer.live),
		[],
	);
	// Even a host that runs a cleared callback late must not repaint a disposed footer.
	env.clock.now += 5;
	expiry.fn();
	assert.equal(env.changes(), changes);
	assert.deepEqual(
		env.timers.filter((timer) => timer.live),
		[],
	);
});

const healthyView = (id: string, left: number, extra: Record<string, unknown> = {}) =>
	view(id, {
		snapshot: snap(id, [{ ...win("q", 100 - left), durationMs: hour }], { expiresAt: CLOCK + hour }),
		...extra,
	});

test("a reply with hundreds of thousands of windows renders the capped fallback without throwing", () => {
	const windows = Array.from({ length: 300_000 }, (_, i) => ({ ...win(`w${i}`, 50), durationMs: hour }));
	const huge = view("huge", { snapshot: snap("huge", windows, { expiresAt: CLOCK + hour }) });
	const state = projected([huge, ...["A", "B", "C", "D"].map((id) => healthyView(id, 90))]);
	const rows = footer.fitQuotaRows(state, 40, plain, fixed);
	assert.equal(rows.length, 5);
	assert.equal(rows.at(-1), "+1 more: /router status");
});

test("among blocked providers the cap keeps the lowest remaining quota", () => {
	const blocked = (id: string, left: number) => healthyView(id, left, { marks: [mark(CLOCK + hour, "inferred")] });
	const rows = footer.fitQuotaRows(
		projected([blocked("A", 90), blocked("B", 90), blocked("C", 90), blocked("D", 90), blocked("E", 1)]),
		40,
		plain,
		fixed,
	);
	assert.equal(rows[0], "Left: E provider blocked inf 1h 1%");
	assert.equal(rows.at(-1), "+1 more (1 blocked): /router status");
});

test("display labels are bounded at normalization while matching keeps the full id", () => {
	const long = "x".repeat(10_000);
	const family = `fam-${long}`;
	const state = projected([
		view("p", {
			display: { full: long, compact: long },
			snapshot: snap("p", [win(long, 40)], { expiresAt: CLOCK + hour }),
			meters: [meter(long, 3, { scope: "model", families: [family] })],
			pools: [{ name: long, unit: "credits", balance: 2 }],
			marks: [
				mark(
					CLOCK + hour,
					"inferred",
					Array.from({ length: 1_000 }, (_, i) => `${long}${i}`),
				),
			],
		}),
	]);
	const label = `${"x".repeat(footer.LABEL_MAX - 3)}...`;
	const row = footer.formatQuotaRow(state, "full", plain, { ...fixed, model: { provider: "p", id: family } });
	// The selected model matches its full family id; only the shown text is bounded.
	assert.match(row, new RegExp(`^Quota left: ${label} ${label} 60%`));
	assert.match(row, new RegExp(` ${label} 3 requests observed ${label} 2 credits; `));
	assert.match(
		row,
		new RegExp(`(${label},){${footer.FAMILIES_MAX - 1}}${label}\\+${1_000 - footer.FAMILIES_MAX} blocked`),
	);
	assert.ok(row.length < 1_000);
});

test("the capped fallback fits every width it is given and keeps the hidden blocked count", () => {
	const marked = (id: string) => view(id, { marks: [mark(CLOCK + hour, "observed")] });
	const blockedState = projected(["A", "B", "C", "D", "E", "F"].map(marked));
	const healthyState = projected(["A", "B", "C", "D", "E", "F"].map((id) => healthyView(id, 50)));
	const pointer = (state: footer.QuotaState, width: number) => footer.fitQuotaRows(state, width, plain, fixed).at(-1);
	// The ladder: full pointer, the count, `+K!` (K blocked hidden), `!`, then nothing at width 0.
	assert.equal(pointer(blockedState, 40), "+2 more (2 blocked): /router status");
	assert.equal(pointer(blockedState, 19), "+2 more (2 blocked)");
	assert.equal(pointer(blockedState, 18), "+2!");
	assert.equal(pointer(blockedState, 2), "!");
	assert.equal(pointer(blockedState, 0), "");
	assert.equal(pointer(healthyState, 7), "+2 more");
	assert.equal(pointer(healthyState, 6), "+2");
	assert.equal(pointer(healthyState, 1), "+");
	for (let width = 0; width <= 60; width++) {
		for (const state of [blockedState, healthyState]) {
			const rows = footer.fitQuotaRows(state, width, plain, fixed);
			for (const row of rows) assert.ok(row.length <= width, `width ${width}: ${JSON.stringify(row)}`);
		}
		if (width > 0) assert.match(present(pointer(blockedState, width)), /!|\(2 blocked\)/);
	}
	// Below the lead, the label-only row still fits rather than forcing a character past the width.
	assert.deepEqual(footer.fitQuotaRows(projected([marked("A")]), 4, plain, fixed), ["Left"]);
});

test("generic assumed and unrecognized percentage spans keep their own name", () => {
	const state = projected([
		view("g", {
			snapshot: snap(
				"g",
				[span("rpm", 40, hour, "assumed", CLOCK + hour), span("tpm", 30, hour, "guessed", CLOCK + hour)],
				{ expiresAt: CLOCK + hour },
			),
		}),
	]);
	assert.equal(
		footer.formatQuotaRow(state, "compact", plain, fixed),
		"Left: g rpm? 60% @Jan 10 13:00 tpm? 70% @Jan 10 13:00",
	);
	assert.equal(
		footer.formatQuotaRow(state, "full", plain, fixed),
		"Quota left: g rpm 60% (resets Jan 10 13:00; window unknown) tpm 70% (resets Jan 10 13:00; window unknown)",
	);
});

test("a duration selector never lends its duration to a qualified reading", () => {
	const row = (spanSource: string, tier: footer.Tier = "compact") =>
		footer.formatQuotaRow(
			projected([
				view("g", {
					display: { full: "G", compact: "G", footer: { show: [{ durationMs: WEEK }] } },
					snapshot: snap("g", [{ ...win("est", 10), spanSource }], { expiresAt: CLOCK + hour }),
				}),
			]),
			tier,
			plain,
			fixed,
		);
	assert.equal(row("inferred"), "Left: G est~ 90%");
	assert.equal(row("inferred", "full"), "Quota left: G est 90% (span inferred)");
	assert.equal(row("assumed"), "Left: G est? 90%");
});

test("a failed view says so unless a cached value is actually rendered", () => {
	const failed = (extra: Record<string, unknown>, status = "error") =>
		view("e", { snapshot: snap("e", [], { status, expiresAt: CLOCK + hour }), ...extra });
	const row = (input: unknown, opts: footer.FormatOptions = fixed) =>
		footer.formatQuotaRow(projected([input]), "compact", plain, opts);
	const placeholder = {
		display: { full: "e", compact: "e", footer: { show: [{ durationMs: hour }], placeholder: true } },
	};
	const unknownPool = { pools: [{ name: "wallet", unit: "credits" }] };
	const offModel = { meters: [meter("calls", 3, { scope: "model", families: ["opus"] })] };
	// Nothing cached is visible: a placeholder, an unknown-only pool or another model's meter.
	assert.equal(row(failed(placeholder)), "Left: e quota error");
	assert.equal(row(failed(unknownPool, "unavailable")), "Left: e quota unavailable");
	assert.equal(row(failed(offModel)), "Left: e quota error");
	assert.equal(
		row(failed({ ...offModel, marks: [mark(CLOCK + hour, "inferred")] })),
		"Left: e quota error | provider blocked->13:00 inf",
	);
	// The selected model's meter is a visible cached value, so it reads stale instead.
	assert.equal(
		row(failed(offModel), { ...fixed, model: { provider: "e", id: "claude-opus" } }),
		"Left: e (stale) calls 3 req obs",
	);
	// An available snapshot with only a placeholder has nothing to report as failed.
	assert.equal(row(failed(placeholder, "available")), "Left: e 1h --");
});

const LEGACY_ANTHROPIC = {
	full: "Anthropic",
	compact: "Anth",
	footer: { show: [{ name: "five_hour" }, { name: "seven_day" }], placeholder: true },
};

test("legacy-selection freshness follows the snapshot expiry for meters and pools", () => {
	const anthropic = (expiresAt: number) =>
		view("anthropic", {
			display: LEGACY_ANTHROPIC,
			snapshot: snap("anthropic", [], { expiresAt }),
			meters: [meter("calls", 3)],
			pools: [{ name: "wallet", unit: "credits", balance: 4 }],
		});
	const row = (expiresAt: number) => footer.formatQuotaRow(projected([anthropic(expiresAt)]), "compact", plain, fixed);
	assert.equal(row(CLOCK + hour), "Left: Anth 7d -- calls 3 req obs wallet 4 credits");
	assert.equal(row(CLOCK - 1), "Left: Anth (stale) 7d -- calls 3 req obs wallet 4 credits");
});

test("an all-legacy-selection reply still budgets its marks: whole with evidence or left out", () => {
	const state = projected([
		view("anthropic", {
			display: LEGACY_ANTHROPIC,
			snapshot: snap("anthropic", [resetWin("five_hour", 30, CLOCK + hour), resetWin("seven_day", 60, CLOCK + hour)], {
				expiresAt: CLOCK + hour,
			}),
			marks: [mark(CLOCK + hour, "inferred", ["claude-opus"])],
		}),
		view("openai-codex", {
			display: { full: "OpenAI", compact: "OAI", footer: { show: [{ durationMs: WEEK }], placeholder: true } },
			snapshot: snap("openai-codex", [resetWin("7d", 20, CLOCK + hour)], { expiresAt: CLOCK + hour }),
		}),
	]);
	const fit = (width: number) => footer.fitQuotaRows(state, width, plain, fixed);
	// The marked row is budgeted with its percentages in legacy order and bytes; the unmarked one stays pinned.
	assert.deepEqual(fit(48), ["Left: Anth claude-opus blocked inf 5h 70% 7d 40%", "OAI 7d 80%"]);
	assert.deepEqual(fit(45), ["Left: Anth claude-opus blocked inf 5h 70% ...", "OAI 7d 80%"]);
	for (let width = 0; width <= 80; width++) {
		const [marked] = fit(width);
		assert.ok(present(marked).length <= width, `width ${width}: ${marked}`);
		assert.ok(
			!present(marked).includes("blocked") || /blocked(->\S+)? inf/.test(present(marked)),
			`width ${width}: ${marked}`,
		);
	}
});
