import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const q = await import(join(repo, "lib/footer-quota.ts"));

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
	assert.deepEqual(state["openai-codex"], {
		fiveHour: 82,
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
	assert.equal(
		q.formatQuotaRow(state, "full", plain),
		"Quota left: Anthropic 5h 76% weekly 58% | OpenAI 5h 82% weekly 63%",
	);
	assert.equal(q.formatQuotaRow(state, "compact", plain), "Left: Anth 5h 76% 7d 58% | OAI 5h 82% 7d 63%");
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
	assert.equal(text, "Left: Anth (stale) 5h 3% 7d -- | OAI (stale) 5h -- 7d --");
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
