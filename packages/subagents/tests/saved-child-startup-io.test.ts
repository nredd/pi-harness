/** Filesystem work restart recovery does per saved row and per journal write (#1115). */
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { outcomes, toolCalls } from "@nredd/pi-test-lib/faux";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { checkSavedChild, RECENT_CHILD_WRITE_SECONDS } from "../src/saved-child-session.ts";
import { answer, ScenarioSession, spawn } from "./fixtures/scenario-session.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const realpathSync = Object.assign(
		vi.fn((path: fs.PathLike, options?: unknown) => actual.realpathSync(path, options as undefined)),
		{ native: actual.realpathSync.native },
	);
	const readSync = vi.fn(actual.readSync);
	return { ...actual, default: { ...actual, realpathSync, readSync }, realpathSync, readSync };
});

let fixture: ScenarioSession | undefined;

afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
	Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
	vi.mocked(fs.realpathSync).mockClear();
	vi.mocked(fs.readSync).mockClear();
});

/** Every `realpathSync` argument since the last clear, as strings. */
function resolved(): string[] {
	return vi.mocked(fs.realpathSync).mock.calls.map(([path]) => String(path));
}

/** The `length` of every `readSync` call since the last clear. */
function readLengths(): number[] {
	// `readSync(fd, buffer, offset, length, position)`: the overload typings only name the options form.
	return vi.mocked(fs.readSync).mock.calls.map((call) => (call as unknown[])[3] as number);
}

function agentId(receipt: string | undefined): string {
	const id = receipt?.match(/Agent ID: (\S+)/)?.[1];
	if (!id) throw new Error(`No Agent ID in ${receipt}`);
	return id;
}

it("bounds startup work per saved row with existing transcripts", { timeout: 30_000 }, async () => {
	const scenario = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	fixture = scenario;
	scenario.physical("kid", "child", [answer("DONE")]);
	const parent = SessionManager.create(scenario.cwd, join(scenario.root, "parents"));
	const h = await scenario.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("template child")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const record = scenario.record(agentId(outcomes(h, "Agent")[0]?.text));
	await record.promise;
	await h.session.waitForIdle();
	const parentFile = parent.getSessionFile();
	const template = record.sessionFile;
	if (!parentFile || !template) throw new Error("Missing session path");
	const transcript = fs.readFileSync(template);
	const directory = dirname(template);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const stale = new Date(scenario.clock.now() - (RECENT_CHILD_WRITE_SECONDS + 1) * 1000);
	/** Every saved child's own existing transcript so far: each restart adds rows. */
	const files: string[] = [];
	/** Restart after saving `rows` more children. */
	const restart = async (rows: number) => {
		const manager = SessionManager.open(parentFile);
		for (let i = 0; i < rows; i++) {
			const file = join(directory, `copy-${rows}-${i}.jsonl`);
			fs.writeFileSync(file, transcript);
			fs.utimesSync(file, stale, stale);
			files.push(file);
			manager.appendCustomEntry("subagents:record", {
				id: `copy-${rows}-${i}`,
				type: "general-purpose",
				description: "Saved child",
				status: "completed",
				sessionFile: file,
				sessionCwd: scenario.cwd,
				sessionDir: directory,
			});
		}
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		vi.mocked(fs.realpathSync).mockClear();
		vi.mocked(fs.readSync).mockClear();
		const host = await scenario.start({ harness: { sessionManager: manager } });
		host.cleanup();
		const calls = resolved();
		const perRow = files.map((file) => calls.filter((path) => path === file).length);
		const shared = calls.filter(
			(path) => !files.includes(path) && (path.startsWith(directory) || path === parentFile),
		).length;
		return { perRow, shared, reads: readLengths() };
	};
	const few = await restart(5);
	const many = await restart(195);
	// One resolution per row's own file; the directories and parent resolve once per startup.
	expect(few.perRow.every((count) => count === 1)).toBe(true);
	expect(many.perRow).toHaveLength(200);
	expect(many.perRow.every((count) => count === 1)).toBe(true);
	expect(many.shared).toBe(few.shared);
	expect(many.shared).toBeLessThanOrEqual(3);
	// Each header is one small read, never the 64 KiB cap: 200 copies plus the template child.
	expect(many.reads).toEqual(Array.from({ length: 201 }, () => 4 * 1024));
});

it("resolves a journaled transcript once per record across its journal writes", { timeout: 30_000 }, async () => {
	const scenario = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	fixture = scenario;
	scenario.physical("kid", "child", [answer("DONE"), answer("RESUMED")]);
	const parent = SessionManager.create(scenario.cwd, join(scenario.root, "parents"));
	const h = await scenario.start({ harness: { sessionManager: parent } });
	vi.mocked(fs.realpathSync).mockClear();
	h.setResponses([toolCalls(spawn("journaled child", { run_in_background: false })), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const row = parent.getBranch().find((entry) => entry.type === "custom" && entry.customType === "subagents:record");
	if (row?.type !== "custom") throw new Error("Missing child record");
	const { id, sessionFile } = row.data as { id: string; sessionFile: string };
	h.setResponses([toolCalls(spawn("resume", { resume: id, run_in_background: false })), answer("RESUMED")]);
	await h.session.prompt("resume");
	const rows = parent.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "subagents:record");
	// Spawn, settle, the resume's start and its settle: four rows, one resolution
	// (two calls). Each run's writer claim (#1247) resolves it once more, not per
	// row: the spawn's twice, its transcript not on disk yet, then the resume's.
	expect(rows.length).toBeGreaterThanOrEqual(4);
	expect(rows.every((entry) => (entry as { data: { id: string } }).data.id === id)).toBe(true);
	const transcript = resolved().filter((path) => path === sessionFile || path === dirname(sessionFile));
	expect(transcript.length).toBeLessThanOrEqual(2 + 3);
	h.cleanup();
});

it("reads only a bounded header of a file a tampered journaled directory admits", () => {
	const root = makeTestTempDir("saved-child-io-", onTestFinished);
	const configured = join(root, "sessions");
	const tampered = join(root, "elsewhere");
	const parentFile = join(root, "parent.jsonl");
	fs.mkdirSync(configured);
	fs.mkdirSync(tampered);
	fs.writeFileSync(parentFile, "");
	const header = (fields: Record<string, unknown>) => `${JSON.stringify({ type: "session", ...fields })}\n`;
	const check = (file: string, overrides: { savedCwd?: string } = {}) =>
		checkSavedChild({
			file,
			// A tampered row can name any directory as its creation directory.
			journaledDirectory: tampered,
			directories: [configured],
			parentFile,
			status: "completed",
			now: Number.MAX_SAFE_INTEGER,
			savedCwd: "/work",
			...overrides,
		});
	const huge = join(tampered, "huge.jsonl");
	fs.writeFileSync(huge, "x".repeat(1024 * 1024));
	vi.mocked(fs.readSync).mockClear();
	expect(check(huge)).toEqual({ refusal: `child session has no readable header: ${huge}` });
	expect(readLengths().reduce((sum, length) => sum + length, 0)).toBe(64 * 1024);
	const foreign = join(tampered, "foreign.jsonl");
	fs.writeFileSync(foreign, `${header({ parentSession: join(root, "other.jsonl"), cwd: "/work" })}${"y".repeat(9000)}`);
	fs.writeFileSync(join(root, "other.jsonl"), "");
	vi.mocked(fs.readSync).mockClear();
	expect(check(foreign)).toEqual({ refusal: `child session does not belong to this parent: ${foreign}` });
	expect(readLengths()).toEqual([4 * 1024]);
	const moved = join(tampered, "moved.jsonl");
	fs.writeFileSync(moved, header({ parentSession: parentFile, cwd: "/elsewhere" }));
	expect(check(moved)).toEqual({ refusal: `child session does not match its saved working directory: ${moved}` });
	// Without a valid saved cwd to check the header against, the journaled directory widens nothing.
	const owned = join(tampered, "owned.jsonl");
	fs.writeFileSync(owned, header({ parentSession: parentFile, cwd: "/work" }));
	expect(check(owned)).toEqual({ file: fs.realpathSync(owned) });
	const outside = { refusal: `child session is outside its configured directory: ${owned}` };
	expect(check(owned, { savedCwd: undefined })).toEqual(outside);
	expect(check(owned, { savedCwd: "work" })).toEqual(outside);
	// A legacy row (no journaled directory, no cwd) still falls back to the configured one.
	const legacy = join(configured, "legacy.jsonl");
	fs.writeFileSync(legacy, header({ parentSession: parentFile, cwd: "/work" }));
	expect(check(legacy, { savedCwd: undefined })).toEqual({ file: fs.realpathSync(legacy) });
});
