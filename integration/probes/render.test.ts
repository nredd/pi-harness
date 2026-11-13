import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import harnessProbe, { collector } from "./render.ts";

test("a Node `--expose-gc` hook is used as is, and Bun is not consulted", () => {
	const calls: string[] = [];
	const collect = collector({
		gc: () => calls.push("node"),
		Bun: { gc: () => calls.push("bun") },
	});
	assert.ok(collect);
	collect();
	assert.deepEqual(calls, ["node"]);
});

test("Bun without an exposed `gc` falls back to collecting synchronously through `Bun.gc(true)`", () => {
	const args: boolean[] = [];
	const collect = collector({ Bun: { gc: (sync: boolean) => args.push(sync) } });
	assert.ok(collect);
	collect();
	assert.deepEqual(args, [true]);
});

test("a runtime with neither hook has no collector, so the reading is flagged `gc: false`", () => {
	assert.equal(collector({}), undefined);
});

type Handler = RegisteredCommand["handler"];

const previous = process.env.HARNESS_PROBE_OUT;
const roots: string[] = [];

afterEach(() => {
	if (previous === undefined) delete process.env.HARNESS_PROBE_OUT;
	else process.env.HARNESS_PROBE_OUT = previous;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A TUI double that counts invalidations and records each `renderNow(force)` argument. */
function fakeTui() {
	const renders: (boolean | undefined)[] = [];
	let invalidations = 0;
	const tui = {
		invalidate: () => {
			invalidations += 1;
		},
		renderNow: (force?: boolean) => renders.push(force),
		terminal: { columns: 132, rows: 41 },
	};
	return { tui, renders, invalidations: () => invalidations };
}

/** Register the probe and return its command handler plus a ctx whose widget factory hands over `tui`. */
function harness(tui: unknown) {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	harnessProbe({
		registerCommand: (name: string, options: { description?: string; handler: Handler }) => commands.set(name, options),
	} as unknown as ExtensionAPI);
	const widgets: string[] = [];
	const ctx = {
		ui: {
			setWidget: (key: string, content: unknown) => {
				widgets.push(`${key}:${typeof content}`);
				if (typeof content !== "function" || tui === undefined) return;
				const component = content(tui);
				assert.deepEqual(component.render(80), []);
				component.invalidate();
			},
		},
	};
	const command = commands.get("harness-probe");
	assert.ok(command);
	assert.equal(command.description, "Harness: time full frames and read the heap");
	return { run: (args: string) => command.handler(args, ctx as never), widgets };
}

/** Point `HARNESS_PROBE_OUT` at a fresh private file. */
function output(): string {
	const root = mkdtempSync(join(tmpdir(), "render-probe-"));
	roots.push(root);
	const out = join(root, "probe.jsonl");
	process.env.HARNESS_PROBE_OUT = out;
	return out;
}

test("times warmup plus requested forced and steady frames and appends one record", async () => {
	const out = output();
	const { tui, renders, invalidations } = fakeTui();
	const { run, widgets } = harness(tui);
	await run(" 3 ");
	assert.deepEqual(widgets, ["harness-probe:function", "harness-probe:undefined"]);
	assert.equal(invalidations(), 2 + 3);
	assert.deepEqual(renders, [...Array(2 + 3).fill(true), ...Array(2 + 3).fill(undefined)]);
	const lines = readFileSync(out, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	const record = JSON.parse(lines[0] ?? "");
	assert.equal(record.frames_ms.length, 3);
	assert.equal(record.steady_frames_ms.length, 3);
	for (const ms of [...record.frames_ms, ...record.steady_frames_ms]) assert.ok(ms >= 0);
	assert.ok(record.heap_used > 0);
	const host = globalThis as { gc?: unknown; Bun?: { gc?: unknown } };
	assert.equal(record.gc, typeof host.gc === "function" || typeof host.Bun?.gc === "function");
	assert.equal(record.width, 132);
	assert.equal(record.height, 41);
});

test("empty or non-numeric arguments fall back to the default frame count", async () => {
	const out = output();
	const { tui, renders } = fakeTui();
	const { run } = harness(tui);
	await run("");
	await run("many");
	assert.equal(renders.length, 2 * (2 * (2 + 10)));
	for (const line of readFileSync(out, "utf8").trim().split("\n")) {
		assert.equal(JSON.parse(line).frames_ms.length, 10);
	}
});

test("refuses to run without an output path", async () => {
	delete process.env.HARNESS_PROBE_OUT;
	const { run, widgets } = harness(fakeTui().tui);
	await assert.rejects(run("1"), /HARNESS_PROBE_OUT is not set/);
	assert.deepEqual(widgets, []);
});

test("refuses to time anything when the widget factory never runs", async () => {
	const out = output();
	const { run } = harness(undefined);
	await assert.rejects(run("1"), /The widget factory never ran; no TUI to probe/);
	assert.throws(() => readFileSync(out), { code: "ENOENT" });
});
