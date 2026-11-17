import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import usageFixture from "./usage_fixture.ts";

type Handler = (event: unknown, ctx: unknown) => void;

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "usage-fixture-"));
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Register the fixture against a recording API and an in-memory event bus. */
function harness(state: unknown, log = true) {
	const statePath = join(root, "state.json");
	const logPath = join(root, "requests.jsonl");
	writeFileSync(statePath, JSON.stringify(state));
	vi.stubEnv("HARNESS_USAGE_STATE", statePath);
	vi.stubEnv("HARNESS_USAGE_LOG", log ? logPath : "");
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, (data: unknown) => void>();
	const emitted: [string, unknown][] = [];
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: {
			on: (channel: string, listener: (data: unknown) => void) => listeners.set(channel, listener),
			emit: (channel: string, data: unknown) => emitted.push([channel, data]),
		},
	} as unknown as ExtensionAPI;
	usageFixture(api);
	const request = (raw: unknown) => listeners.get("router:rpc:usage")?.(raw);
	const requests = () =>
		existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	const statuses: [string, string][] = [];
	const start = (mode: string) =>
		handlers.get("session_start")?.(
			{},
			{ mode, ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) } },
		);
	const shutdown = () => handlers.get("session_shutdown")?.({}, {});
	return { statePath, request, requests, emitted, statuses, start, shutdown };
}

test("replies with the state file's snapshots and blocks, re-read on every request", () => {
	const fixture = harness({ mode: "ok", snapshots: [{ provider: "anthropic" }], blocks: [{ id: "b" }] });
	fixture.request({ requestId: "r1", refresh: false });
	writeFileSync(fixture.statePath, JSON.stringify({}));
	fixture.request({ requestId: "r2", refresh: true });
	assert.deepEqual(fixture.emitted, [
		[
			"router:rpc:usage:reply:r1",
			{ success: true, data: { snapshots: [{ provider: "anthropic" }], blocks: [{ id: "b" }] } },
		],
		["router:rpc:usage:reply:r2", { success: true, data: { snapshots: [], blocks: [] } }],
	]);
});

test("error mode replies with a failure and hang mode never replies", () => {
	const fixture = harness({ mode: "error" });
	fixture.request({ requestId: "r1" });
	writeFileSync(fixture.statePath, JSON.stringify({ mode: "hang" }));
	fixture.request({ requestId: "r2" });
	assert.deepEqual(fixture.emitted, [["router:rpc:usage:reply:r1", { success: false, error: "harness usage error" }]]);
});

test("logs every request, and drops one without a string requestId without reading state", () => {
	const fixture = harness({ mode: "ok" });
	rmSync(fixture.statePath);
	fixture.request(undefined);
	fixture.request("not an object");
	fixture.request({ requestId: 7, refresh: true });
	assert.deepEqual(fixture.emitted, []);
	// `refresh` is whatever the request carried: JSON drops it when absent.
	assert.deepEqual(
		fixture.requests().map(({ t: _t, ...rest }) => rest),
		[{ ready: false }, { ready: false }, { refresh: true, ready: false }],
	);
	assert.ok(fixture.requests().every(({ t }) => t === Date.now()));
});

test("without a log path requests are answered but not logged", () => {
	const fixture = harness({ mode: "ok" }, false);
	fixture.request({ requestId: "r1" });
	assert.equal(fixture.emitted.length, 1);
	assert.deepEqual(fixture.requests(), []);
});

test("a request without HARNESS_USAGE_STATE fails loudly", () => {
	const fixture = harness({ mode: "ok" });
	vi.stubEnv("HARNESS_USAGE_STATE", "");
	assert.throws(() => fixture.request({ requestId: "r1" }), /usage_fixture\.ts needs HARNESS_USAGE_STATE/);
});

test("becomes ready only after the startup dispatch, and again after every new session", () => {
	const fixture = harness({ mode: "ok" });
	const readiness = () => fixture.requests().map(({ ready }) => ready);
	fixture.start("tui");
	fixture.request({});
	vi.runAllTimers();
	fixture.request({});
	fixture.start("print");
	fixture.request({});
	vi.runAllTimers();
	fixture.request({});
	assert.deepEqual(readiness(), [false, true, false, true]);
	// Only the TUI sets the status line.
	assert.deepEqual(fixture.statuses, [["harness-usage", "STATUS-LINE-OK"]]);
});

test("shutdown before the startup dispatch cancels readiness", () => {
	const fixture = harness({ mode: "ok" });
	fixture.start("rpc");
	assert.equal(vi.getTimerCount(), 1);
	fixture.shutdown();
	assert.equal(vi.getTimerCount(), 0);
	fixture.request({});
	assert.deepEqual(
		fixture.requests().map(({ ready }) => ready),
		[false],
	);
});
