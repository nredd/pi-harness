/** Restart-safe child recovery (#1086, #1115) and the synthetic #330 activation/stop/restart diagnosis. */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { outcomes, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it, vi } from "vitest";
import * as agentRunner from "../src/agent-runner.ts";
import { RECENT_CHILD_WRITE_SECONDS } from "../src/saved-child-session.ts";
import { answer, ScenarioSession, spawn } from "./fixtures/scenario-session.ts";

let fixture: ScenarioSession;

function agentId(receipt: string | undefined): string {
	const id = receipt?.match(/Agent ID: (\S+)/)?.[1];
	if (!id) throw new Error(`No Agent ID in ${receipt}`);
	return id;
}
/** Date a finished child's transcript past the recent-write window of the fixture clock. */
function settle(file: string | undefined) {
	if (!file) throw new Error("Missing child transcript");
	const stale = new Date(fixture.clock.now() - (RECENT_CHILD_WRITE_SECONDS + 1) * 1000);
	utimesSync(file, stale, stale);
}
afterEach(async () => {
	await fixture?.dispose();
	Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

it("reopens the newest id after two restarts through a symlinked child directory", { timeout: 30_000 }, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const sessionDir = join(fixture.agentDir, "sessions");
	const target = join(fixture.root, "child-sessions");
	mkdirSync(target);
	symlinkSync(target, sessionDir, "dir");
	fixture.physical("kid", "child", [answer("ORIGINAL"), answer("FIRST RESUME"), answer("SECOND RESUME")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const parentPath = parent.getSessionFile()!;
	let host = await fixture.start({ harness: { sessionManager: parent } });
	const run = async (resume?: string) => {
		host.setResponses([toolCalls(spawn("continue child", { resume })), answer("CHECKED")]);
		await host.session.prompt("run child");
		const receipt = outcomes(host, "Agent").at(-1);
		expect(receipt?.isError, receipt?.text).toBe(false);
		const record = fixture.record(agentId(receipt?.text));
		await record.promise;
		await host.session.waitForIdle();
		settle(record.sessionFile);
		return record;
	};
	const restart = async () => {
		host.cleanup();
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		host = await fixture.start({ harness: { sessionManager: SessionManager.open(parentPath) } });
	};
	const first = await run();
	expect(first.sessionFile).toContain(`${sessionDir}/`);
	await restart();
	const second = await run(first.id);
	expect(second.sessionFile).toContain(`${realpathSync(target)}/`);
	await restart();
	const third = await run(second.id);
	expect(third.result).toBe("SECOND RESUME");
	host.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: first.id } }), answer("CHECKED")]);
	await host.session.prompt("look up the original id");
	expect(outcomes(host, "get_subagent_result").at(-1)?.text).toContain(`Agent: ${third.id}`);
});

it("links a successor journaled through a symlinked directory after its transcript is deleted", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const sessionDir = join(fixture.agentDir, "sessions");
	const target = join(fixture.root, "child-sessions");
	mkdirSync(target);
	symlinkSync(target, sessionDir, "dir");
	fixture.physical("kid", "child", [answer("ORIGINAL"), answer("FIRST RESUME")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const parentPath = parent.getSessionFile()!;
	let host = await fixture.start({ harness: { sessionManager: parent } });
	const run = async (resume?: string) => {
		host.setResponses([toolCalls(spawn("continue child", { resume })), answer("CHECKED")]);
		await host.session.prompt("run child");
		const record = fixture.record(agentId(outcomes(host, "Agent").at(-1)?.text));
		await record.promise;
		await host.session.waitForIdle();
		settle(record.sessionFile);
		return record;
	};
	const restart = async () => {
		host.cleanup();
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		host = await fixture.start({ harness: { sessionManager: SessionManager.open(parentPath) } });
	};
	const first = await run();
	await restart();
	const second = await run(first.id);
	expect(second.sessionFile).toBe(realpathSync(first.sessionFile!));
	// The first row names the symlinked spelling; with the file gone, only the
	// canonical form journaled at write time can still link the two rows.
	unlinkSync(second.sessionFile!);
	await restart();
	host.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: first.id } }), answer("CHECKED")]);
	await host.session.prompt("look up the original id");
	expect(outcomes(host, "get_subagent_result").at(-1)?.text).toContain(`Agent "${second.id}"`);
	host.cleanup();
});

it("validates a reopened row against the creation directory its predecessor journaled", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	fixture.physical("kid", "child", [answer("ORIGINAL"), answer("REOPENED")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("first run")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const record = fixture.record(agentId(outcomes(h, "Agent")[0]?.text));
	await record.promise;
	await h.session.waitForIdle();
	const parentFile = parent.getSessionFile();
	const file = record.sessionFile;
	if (!parentFile || !file) throw new Error("Missing session path");
	settle(file);
	const journaled = parent
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
		.at(-1);
	expect(journaled).toMatchObject({ data: { sessionDir: dirname(file), canonicalSessionFile: realpathSync(file) } });
	// A reopen from another cwd journals no directory of its own (its manager's
	// differs from the file's), and the project's settings move on afterwards.
	const {
		sessionDir: _dir,
		canonicalSessionFile: _canonical,
		...row
	} = (journaled as { data: object }).data as Record<string, unknown>;
	parent.appendCustomEntry("subagents:record", { ...row, id: "successor", previousId: record.id, status: "running" });
	parent.appendCustomEntry("subagents:record", { ...row, id: "successor", previousId: record.id });
	mkdirSync(join(fixture.cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(fixture.cwd, ".pi", "settings.json"),
		JSON.stringify({ sessionDir: join(fixture.root, "moved-sessions") }),
	);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const next = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
	next.setResponses([toolCalls(spawn("resume after settings moved", { resume: record.id })), answer("CHECKED")]);
	await next.session.prompt("resume");
	const receipt = outcomes(next, "Agent").at(-1);
	expect(receipt?.isError, receipt?.text).toBe(false);
	expect(receipt?.text).toContain("reopening evicted agent successor");
	const continued = fixture.record(agentId(receipt?.text));
	await continued.promise;
	expect(continued.result).toBe("REOPENED");
	next.cleanup();
});

it("ignores a tampered journaled directory on a row that saved no working directory", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const child = fixture.physical("kid", "child", [answer("ORIGINAL"), answer("NEVER REOPEN")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("first run")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const record = fixture.record(agentId(outcomes(h, "Agent")[0]?.text));
	await record.promise;
	await h.session.waitForIdle();
	const parentFile = parent.getSessionFile();
	const file = record.sessionFile;
	if (!parentFile || !file) throw new Error("Missing session path");
	settle(file);
	const journaled = parent
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
		.at(-1);
	// The row keeps its directory but drops the cwd the header would be checked against.
	const { sessionCwd: _cwd, ...row } = (journaled as { data: object }).data as Record<string, unknown>;
	parent.appendCustomEntry("subagents:record", row);
	const moved = join(fixture.root, "moved-sessions");
	mkdirSync(moved);
	mkdirSync(join(fixture.cwd, ".pi"), { recursive: true });
	writeFileSync(join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: moved }));
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const next = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
	next.setResponses([toolCalls(spawn("resume without a cwd", { resume: record.id })), answer("CHECKED")]);
	await next.session.prompt("resume");
	expect(outcomes(next, "Agent").at(-1)).toMatchObject({
		isError: true,
		text: expect.stringContaining(`child session is outside its configured directory: ${file}`),
	});
	expect(child.state.callCount).toBe(1);
	next.cleanup();
});

it("never lends a journaled creation directory to an update naming another transcript", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const child = fixture.physical("kid", "child", [answer("ORIGINAL"), answer("NEVER REOPEN")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("first run")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const record = fixture.record(agentId(outcomes(h, "Agent")[0]?.text));
	await record.promise;
	await h.session.waitForIdle();
	const parentFile = parent.getSessionFile();
	const file = record.sessionFile;
	if (!parentFile || !file) throw new Error("Missing session path");
	// A valid same-parent copy beside the journaled transcript, named by a
	// same-id update that journals no directory of its own.
	const copy = join(dirname(file), "copy.jsonl");
	writeFileSync(copy, readFileSync(file));
	settle(copy);
	const journaled = parent
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
		.at(-1);
	const {
		sessionDir: _dir,
		canonicalSessionFile: _canonical,
		...row
	} = (journaled as { data: object }).data as Record<string, unknown>;
	parent.appendCustomEntry("subagents:record", { ...row, sessionFile: copy });
	const moved = join(fixture.root, "moved-sessions");
	mkdirSync(moved);
	mkdirSync(join(fixture.cwd, ".pi"), { recursive: true });
	writeFileSync(join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: moved }));
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const next = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
	next.setResponses([toolCalls(spawn("resume the copy", { resume: record.id })), answer("CHECKED")]);
	await next.session.prompt("resume");
	expect(outcomes(next, "Agent").at(-1)).toMatchObject({
		isError: true,
		text: expect.stringContaining(`child session is outside its configured directory: ${copy}`),
	});
	expect(child.state.callCount).toBe(1);
	next.cleanup();
});

it("loads host settings once when restoring 200 saved rows across different child directories", async () => {
	fixture = new ScenarioSession();
	const start = async (rows: number) => {
		const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
		for (let i = 0; i < rows; i++) {
			parent.appendCustomEntry("subagents:record", {
				id: `child-${i}`,
				type: i % 2 === 0 ? "general-purpose" : "explore",
				description: "Saved child",
				status: "completed",
				sessionCwd: join(fixture.cwd, `dir-${i % 3}`),
				sessionFile: join(fixture.root, `missing-${i}.jsonl`),
			});
		}
		const settings = vi.spyOn(SettingsManager, "create");
		const directory = vi.spyOn(agentRunner, "childSessionDir");
		try {
			const host = await fixture.start({ harness: { sessionManager: parent } });
			host.cleanup();
			return { settings: settings.mock.calls.length, directories: directory.mock.calls.length };
		} finally {
			settings.mockRestore();
			directory.mockRestore();
			Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		}
	};
	const baseline = await start(0);
	expect(await start(200)).toEqual({ settings: baseline.settings + 1, directories: 6 });
});

it("reports unknown ids as errors to the model and to a nested tools caller", async () => {
	fixture = new ScenarioSession();
	const id = "nope-0000-000";
	const resume = spawn("resume missing", { resume: id });
	const missing = `Agent not found: "${id}". It may have been cleaned up.`;
	const h = await fixture.start({
		factories: [
			(pi) =>
				pi.registerTool({
					name: "settled_probe",
					label: "Settled probe",
					description: "Check a codemode-style nested call",
					parameters: { type: "object", properties: {} },
					execute: async (_id, _params, _signal, _update, ctx) => {
						const settled = await Promise.allSettled([
							ctx.executeTool(resume.name, resume.args).then((result) => {
								if (result.isError) throw new Error("Agent failed");
							}),
						]);
						return { content: [{ type: "text", text: settled[0].status }], details: undefined };
					},
				}),
		],
	});
	h.setResponses([
		toolCalls(
			resume,
			{ name: "steer_subagent", args: { agent_id: id, message: "continue" } },
			{ name: "get_subagent_result", args: { agent_id: id } },
			{ name: "settled_probe", args: {} },
		),
		answer("CHECKED"),
	]);
	await h.session.prompt("unknown calls");
	for (const tool of ["Agent", "steer_subagent", "get_subagent_result"]) {
		expect(outcomes(h, tool)[0]).toMatchObject({ text: missing, isError: true });
	}
	expect(outcomes(h, "settled_probe")[0]?.text).toBe("rejected");
});

it.each([
	"Agent",
	"steer_subagent",
	"deleted",
	"recent",
	"chain-A",
	"chain-B",
	"cwd",
	"relative-dir",
	"worktree",
	"worktree-parent-settings",
	"worktree-child-settings",
	"future",
	"parent-alias",
] as const)("recovers a saved running child after a crash: %s", { timeout: 30_000 }, async (mode) => {
	const chain = mode === "chain-A" || mode === "chain-B";
	fixture = new ScenarioSession({
		rememberAgents: true,
		agentModels: { "general-purpose": "kid/child", "crash-relative": "kid/child" },
	});
	const hold = fixture.heldTool();
	const subdir = join(fixture.cwd, "subdir");
	if (mode === "cwd" || mode === "relative-dir") mkdirSync(subdir);
	if (mode === "relative-dir") {
		const agents = join(fixture.agentDir, "agents");
		mkdirSync(agents);
		writeFileSync(
			join(agents, "crash-relative.md"),
			"---\ndescription: Crash probe\nsession_dir: child-sessions\n---\nCrash probe.\n",
		);
	}
	const worktree = mode.startsWith("worktree");
	const settingsFile = join(fixture.cwd, ".pi", "settings.json");
	if (mode === "worktree-child-settings")
		writeFileSync(settingsFile, JSON.stringify({ sessionDir: join(fixture.root, "committed-sessions") }));
	if (worktree) {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.cwd, stdio: "pipe" });
		git("init");
		git("add", ".pi/extensions/hold.ts", ...(mode === "worktree-child-settings" ? [".pi/settings.json"] : []));
		git(
			"-c",
			"user.email=fixture@example.com",
			"-c",
			"user.name=Fixture",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"Initialize fixture",
		);
		// The worktree child is created with the worktree's settings, which differ
		// from the parent's uncommitted ones in either direction.
		if (mode === "worktree-child-settings") unlinkSync(settingsFile);
		if (mode === "worktree-parent-settings")
			writeFileSync(settingsFile, JSON.stringify({ sessionDir: join(fixture.root, "uncommitted-sessions") }));
	}
	const progress = fauxAssistantMessage([{ type: "text", text: "PROGRESS BEFORE CRASH" }, fauxToolCall("hold", {})], {
		stopReason: "toolUse",
	});
	const request = deferred<string>();
	const child = fixture.physical("kid", "child", [
		...(chain ? [answer("FIRST RUN DONE")] : []),
		progress,
		(context) => {
			request.resolve(JSON.stringify(context.messages));
			return chain ? progress : answer("RECOVERED CHILD DONE");
		},
		answer("AFTER HOLD"),
	]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	const call = async (host: typeof h, ...calls: Parameters<typeof toolCalls>) => {
		host.setResponses([toolCalls(...calls), answer("CHECKED")]);
		await host.session.prompt("check child");
	};
	const resume = (id: string, prompt = "CONTINUE AFTER CRASH") => spawn("resume", { resume: id, prompt });
	const get = (id: string) => ({ name: "get_subagent_result", args: { agent_id: id } });
	const steer = (id: string) => ({ name: "steer_subagent", args: { agent_id: id, message: "CONTINUE AFTER CRASH" } });
	await call(
		h,
		spawn("crash probe", {
			name: "crash-probe",
			...(mode === "cwd" || mode === "relative-dir" ? { cwd: subdir } : {}),
			...(mode === "relative-dir" ? { subagent_type: "crash-relative" } : {}),
			...(worktree ? { isolation: "worktree" } : {}),
		}),
	);
	const first = agentId(outcomes(h, "Agent")[0]?.text);
	let id = first;
	if (chain) {
		const a = fixture.record(first);
		await a.promise;
		await h.session.waitForIdle();
		fixture.clock.advance(61 * 60_000);
		await h.session.waitForIdle();
		await call(h, resume(first, "SECOND RUN BEFORE CRASH"));
		id = agentId(outcomes(h, "Agent").at(-1)?.text);
		expect(id).not.toBe(first);
		await hold.entered;
		expect(fixture.record(id).sessionFile).toBe(a.sessionFile);
	}
	await hold.entered;
	const lost = fixture.record(id);
	try {
		const childFile = lost.sessionFile;
		const parentFile = parent.getSessionFile();
		if (!parentFile || !childFile) throw new Error("Missing session path");
		expect(lost.status).toBe("running");
		expect(existsSync(childFile)).toBe(true);
		if (mode === "deleted") unlinkSync(childFile);
		else {
			// A future timestamp (clock skew, a synced volume) cannot rule out a live writer.
			const age = mode === "recent" ? 23_000 : mode === "future" ? -3_600_000 : 121_000;
			const written = new Date(fixture.clock.now() - age);
			utimesSync(childFile, written, written);
		}
		if (mode === "cwd") expect(lost.session?.sessionManager.getHeader()?.cwd).toBe(subdir);
		if (mode === "relative-dir") expect(dirname(childFile)).toBe(join(subdir, "child-sessions"));
		if (worktree) expect(lost.worktree?.path).toBe(lost.session?.sessionManager.getHeader()?.cwd);
		if (mode === "worktree-child-settings") expect(dirname(childFile)).toBe(join(fixture.root, "committed-sessions"));
		if (mode === "worktree-parent-settings")
			expect(dirname(childFile)).not.toBe(join(fixture.root, "uncommitted-sessions"));
		if (chain) {
			const row = { id, type: lost.type, description: lost.description, status: "running", sessionFile: childFile };
			// An update is not another edge, and a different conversation cannot
			// claim this one as a predecessor, even with a syntactically valid id.
			parent.appendCustomEntry("subagents:record", { ...row, id: "unrelated" });
			parent.appendCustomEntry("subagents:record", {
				...row,
				previousId: "unrelated",
				handle: lost.handle,
				alias: lost.alias,
			});
			parent.appendCustomEntry("subagents:record", {
				...row,
				id: "other",
				previousId: id,
				sessionFile: `${childFile}.missing`,
			});
			parent.appendCustomEntry("subagents:record", {
				...row,
				id: "legacy",
				previousId: id,
				sessionFile: undefined,
				status: "completed",
			});
		}

		// Drop the registry without emitting session_shutdown. The held child
		// cannot advance until cleanup, simulating a process that died mid-run.
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		const alias = join(fixture.root, "parents-alias");
		if (mode === "parent-alias") symlinkSync(dirname(parentFile), alias);
		const parentPath = mode === "parent-alias" ? join(alias, basename(parentFile)) : parentFile;
		const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentPath) } });
		expect(child.state.callCount).toBe(chain ? 2 : 1);
		await call(reopened, get(first));
		const diagnostic = outcomes(reopened, "get_subagent_result").at(-1);
		expect(diagnostic?.isError).toBe(true);
		expect(diagnostic?.text).toContain(`Agent "${id}"`);
		expect(diagnostic?.text).toContain(
			mode === "recent" || mode === "future"
				? "may still be running in another process"
				: "interrupted by a process restart",
		);
		expect(diagnostic?.text).toContain(`transcript: ${childFile}`);
		expect(child.state.callCount).toBe(chain ? 2 : 1);

		if (mode === "deleted" || mode === "recent" || mode === "future") {
			if (mode !== "deleted") expect(diagnostic?.text).not.toContain("interrupted");
			await call(reopened, resume(id), steer(id));
			for (const tool of ["Agent", "steer_subagent"]) {
				const failure = outcomes(reopened, tool).at(-1);
				expect(failure?.isError).toBe(true);
				expect(failure?.text.split("\n")[0]).toContain(childFile);
				expect(failure?.text).toContain(
					mode === "recent"
						? "may still be running in another process (last write 23s ago; retry in 97 s)"
						: mode === "future"
							? "may still be running in another process (last write 3600s in the future, possibly clock skew; retry in 3720 s)"
							: "only historical metadata is available",
				);
			}
			expect(child.state.callCount).toBe(1);
			if (mode === "recent") {
				child.setResponses([answer("SECOND CHILD"), answer("SECOND CHILD RESUMED"), answer("FIRST CHILD RESUMED")]);
				await call(reopened, spawn("second child", { name: "crash-probe" }));
				const second = fixture.record(agentId(outcomes(reopened, "Agent").at(-1)?.text));
				await second.promise;
				settle(second.sessionFile);
				expect(second.handle).toBe("general-purpose-2");
				expect(second.alias).toBe("crash-probe-2");
				await reopened.session.waitForIdle();
				Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
				try {
					const again = await fixture.start({ harness: { sessionManager: SessionManager.open(parentPath) } });
					await call(again, resume(second.id));
					const newer = fixture.record(agentId(outcomes(again, "Agent").at(-1)?.text));
					await newer.promise;
					expect(newer.result).toBe("SECOND CHILD RESUMED");
					fixture.clock.advance(97_000);
					await again.session.waitForIdle();
					await call(again, resume(first));
					const older = fixture.record(agentId(outcomes(again, "Agent").at(-1)?.text));
					await older.promise;
					expect(older.result).toBe("FIRST CHILD RESUMED");
				} finally {
					reopened.cleanup();
				}
			}
			return;
		}

		const tool = mode === "chain-B" ? steer(id) : mode === "steer_subagent" ? steer(first) : resume(first);
		await call(reopened, tool);
		const receipt = outcomes(reopened, tool.name).at(-1);
		expect(receipt?.isError, receipt?.text).toBe(false);
		expect(receipt?.text).toContain(`Agent resumed in background, reopening evicted agent ${id}`);
		const next = agentId(receipt?.text);
		expect(next).not.toBe(id);
		const continued = fixture.record(next);
		expect(await request.promise).toContain("PROGRESS BEFORE CRASH");
		expect(await request.promise).toContain("CONTINUE AFTER CRASH");
		if (chain) {
			await call(reopened, get("unrelated"));
			expect(outcomes(reopened, "get_subagent_result").at(-1)?.text).toContain('Agent "unrelated"');
			await call(reopened, resume(mode === "chain-B" ? first : id));
			const duplicate = outcomes(reopened, "Agent").at(-1);
			expect(duplicate?.isError).toBe(true);
			expect(duplicate?.text).toContain(`Agent "${next}" is still running`);
			expect(child.state.callCount).toBe(3);
		} else {
			await continued.promise;
			expect(continued.result).toBe("RECOVERED CHILD DONE");
		}
		await call(reopened, get(first));
		expect(outcomes(reopened, "get_subagent_result").at(-1)?.text).toContain(`Agent: ${next}`);
		expect(continued.sessionFile).toBe(childFile);
		expect(continued.handle).toBe(mode === "relative-dir" ? "crash-relative" : "general-purpose");
		expect(continued.alias).toBe("crash-probe");
	} finally {
		lost.abortController?.abort();
		hold.release();
		await lost.promise;
		h.cleanup();
	}
});

it.each([false, true])("checks fork ownership with a live survivor: %s", { timeout: 30_000 }, async (live) => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const hold = fixture.heldTool();
	const child = fixture.physical("kid", "child", [
		live ? toolCalls({ name: "hold", args: {} }) : answer("DONE"),
		answer("NEVER REOPEN"),
	]);
	const dir = join(fixture.root, "parents");
	const parent = SessionManager.create(fixture.cwd, dir);
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("fork probe")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const id = agentId(outcomes(h, "Agent")[0]?.text);
	const record = fixture.record(id);
	if (live) await hold.entered;
	else await record.promise;
	const original = parent.getSessionFile();
	const file = record.sessionFile;
	if (!original || !file) throw new Error("Missing transcript");
	const old = readFileSync(file, "utf8");
	const stale = new Date(fixture.clock.now() - 121_000);
	utimesSync(file, stale, stale);
	const fork = SessionManager.forkFrom(original, fixture.cwd, dir);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "fork" });
	h.cleanup();
	const next = await fixture.start({ harness: { sessionManager: fork } });
	const resume = spawn("resume fork child", { resume: id });
	next.setResponses([toolCalls(resume, { name: "get_subagent_result", args: { agent_id: id } }), answer("CHECKED")]);
	try {
		await next.session.prompt("fork lookup");
		const lookup = outcomes(next, "get_subagent_result")[0];
		const refused = outcomes(next, "Agent")[0];
		expect(refused?.isError).toBe(true);
		expect(refused?.text).toContain(live ? "is still running" : "does not belong to this parent");
		expect(lookup?.isError).toBe(!live);
		expect(lookup?.text).toContain(live ? "Status: running" : "last recorded status: completed");
		expect(lookup?.text).not.toContain("interrupted");
		expect(refused?.text).not.toContain("now belongs to another agent");
		expect(readFileSync(file, "utf8")).toBe(old);
		expect(child.state.callCount).toBe(1);
	} finally {
		hold.release();
		await record.promise;
	}
	if (live) {
		next.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id } }), answer("CHECKED AGAIN")]);
		await next.session.prompt("look up after the original parent's survivor exits");
		expect(outcomes(next, "get_subagent_result").at(-1)).toMatchObject({
			isError: true,
			text: expect.stringContaining("Agent not found"),
		});
	}
});

it("never opens forged child paths from saved history", { timeout: 30_000 }, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const child = fixture.physical("kid", "child", [answer("DONE"), answer("NEVER REOPEN")]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("create child directory")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	const record = fixture.record(agentId(outcomes(h, "Agent")[0]?.text));
	await record.promise;
	const parentFile = parent.getSessionFile();
	const file = record.sessionFile;
	if (!parentFile || !file) throw new Error("Missing transcript");
	settle(file);
	const original = readFileSync(file, "utf8");
	const outside = join(fixture.root, "empty.jsonl");
	const link = join(dirname(file), "foreign.jsonl");
	const directory = join(dirname(file), "directory");
	const empty = join(dirname(file), "empty.jsonl");
	const invalid = join(dirname(file), "bad-header.jsonl");
	const unowned = join(dirname(file), "unowned.jsonl");
	mkdirSync(directory);
	writeFileSync(outside, "");
	writeFileSync(empty, "");
	writeFileSync(invalid, "not json\n");
	writeFileSync(unowned, '{"type":"session"}\n');
	symlinkSync(outside, link);
	// A valid same-parent copy, reached by a link that a row's write-time canonical form does not name.
	const copy = join(dirname(file), "copy.jsonl");
	const retargeted = join(dirname(file), "retargeted.jsonl");
	writeFileSync(copy, original);
	settle(copy);
	symlinkSync(copy, retargeted);
	const entries = [
		["missing", join(dirname(file), "missing.jsonl"), "missing or unreadable"],
		["forged", outside, "outside its configured directory"],
		["symlink", link, "outside its configured directory"],
		["dotdot", `${dirname(file)}/../${basename(dirname(file))}/${basename(file)}`, "invalid child session path"],
		["relative", "relative.jsonl", "invalid child session path"],
		["directory", directory, "not a regular file"],
		["empty", empty, "no readable header"],
		["malformed", invalid, "missing or unreadable"],
		["unowned", unowned, "does not belong to this parent"],
		["forged-cwd", file, "does not match its saved working directory"],
		["retargeted", retargeted, "no longer resolves to its recorded transcript"],
	] as const;
	for (const [id, sessionFile] of entries)
		parent.appendCustomEntry("subagents:record", {
			id,
			sessionFile,
			// The default directory is unchanged by a duplicate separator, but the
			// journal must not override the working directory in a real child header.
			...(id === "forged-cwd" ? { sessionCwd: `${fixture.cwd}/.` } : {}),
			...(id === "retargeted" ? { canonicalSessionFile: realpathSync(file) } : {}),
			type: record.type,
			description: id,
			status: "completed",
		});
	// The completed child's newest row is legacy (no write-time canonical form),
	// so only the transcript startup bound can catch a swap at dispatch.
	const written = parent
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
		.findLast((entry) => (entry as { data: { id: string } }).data.id === record.id);
	const { canonicalSessionFile: _canonical, ...legacy } = (written as { data: object }).data as Record<string, unknown>;
	parent.appendCustomEntry("subagents:record", legacy);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	const next = await fixture.start({
		harness: { sessionManager: SessionManager.open(parentFile) },
		factories: [
			(pi) =>
				pi.registerTool({
					name: "settled_probe",
					label: "Settled probe",
					description: "Check codemode-style result settlement",
					parameters: { type: "object", properties: {} },
					execute: async (_id, _params, _signal, _update, ctx) => {
						const ids = [record.id, ...entries.map(([id]) => id)];
						const settled = await Promise.allSettled(
							ids.map(async (id) => {
								const result = await ctx.executeTool("get_subagent_result", { agent_id: id });
								if (result.isError) throw new Error(`Lookup failed for ${id}`);
							}),
						);
						return {
							content: [{ type: "text", text: JSON.stringify(settled.map(({ status }) => status)) }],
							details: undefined,
						};
					},
				}),
		],
	});
	next.session.setActiveToolsByName([...next.session.getActiveToolNames(), "settled_probe"]);
	next.setResponses([
		toolCalls(
			{ name: "get_subagent_result", args: { agent_id: record.id } },
			...entries.map(([id]) => ({ name: "get_subagent_result", args: { agent_id: id } })),
			{ name: "settled_probe", args: {} },
		),
		answer("CHECKED LOOKUPS"),
	]);
	await next.session.prompt("look up completed and unavailable children");
	const lookups = outcomes(next, "get_subagent_result");
	expect(lookups[0]).toMatchObject({
		isError: false,
		text: expect.stringContaining("last recorded status: completed, recovered from saved parent session"),
	});
	expect(lookups[0]?.text).toContain("\n\nDONE");
	for (const [id, path] of entries) {
		const lookup = lookups.find((result) => result.text.startsWith(`Agent "${id}"`));
		expect(lookup).toMatchObject({ isError: true, text: expect.stringContaining(`transcript: ${path}`) });
	}
	expect(outcomes(next, "settled_probe")[0]?.text).toBe(
		JSON.stringify(["fulfilled", ...entries.map(() => "rejected")]),
	);
	next.setResponses([toolCalls(...entries.map(([resume]) => spawn("forged resume", { resume }))), answer("CHECKED")]);
	await next.session.prompt("refuse forged paths");
	for (const [id, path, reason] of entries) {
		const refusal = outcomes(next, "Agent").find((result) => result.text.startsWith(`Cannot resume agent "${id}"`));
		expect(refusal).toMatchObject({ isError: true, text: expect.stringContaining(`${reason}: ${path}`) });
	}
	// A validated file replaced after startup still must not be reopened.
	unlinkSync(file);
	symlinkSync(outside, file);
	next.setResponses([toolCalls(spawn("resume swapped file", { resume: record.id })), answer("CHECKED")]);
	await next.session.prompt("refuse changed transcript");
	expect(outcomes(next, "Agent").at(-1)).toMatchObject({
		isError: true,
		text: expect.stringContaining(`child session is outside its configured directory: ${file}`),
	});
	// Nor one swapped for a valid copy in the same directory: the dispatch
	// target must be the transcript startup bound.
	unlinkSync(file);
	symlinkSync(copy, file);
	next.setResponses([toolCalls(spawn("resume copied file", { resume: record.id })), answer("CHECKED")]);
	await next.session.prompt("refuse copied transcript");
	expect(outcomes(next, "Agent").at(-1)).toMatchObject({
		isError: true,
		text: expect.stringContaining(`child session no longer resolves to its recorded transcript: ${file}`),
	});
	expect(readFileSync(outside, "utf8")).toBe("");
	expect(readFileSync(copy, "utf8")).toBe(original);
	expect(child.state.callCount).toBe(1);
});

it("journals both ends of a foreground resume, including an interrupted second run", { timeout: 30_000 }, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const hold = fixture.heldTool();
	fixture.physical("kid", "child", [
		answer("FIRST DONE"),
		answer("INLINE DONE"),
		toolCalls({ name: "hold", args: {} }),
		answer("DONE AFTER HOLD"),
	]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("foreground probe", { run_in_background: false })), answer("SPAWNED")]);
	await h.session.prompt("spawn foreground");
	const row = parent.getBranch().find((entry) => entry.type === "custom" && entry.customType === "subagents:record");
	if (row?.type !== "custom") throw new Error("Missing child record");
	const { id, sessionFile } = row.data as { id: string; sessionFile: string };
	const resume = spawn("resume foreground", { resume: id, run_in_background: false });
	h.setResponses([toolCalls(resume), answer("INLINE SETTLED")]);
	await h.session.prompt("resume to completion");
	const latest = parent
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
		.at(-1);
	expect(latest).toMatchObject({ data: { id, status: "completed", result: "INLINE DONE" } });
	h.setResponses([toolCalls(resume), answer("INLINE INTERRUPTED")]);
	const old = h.session.prompt("resume into tool barrier");
	await hold.entered;
	try {
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Missing parent transcript");
		const stale = new Date(fixture.clock.now() - 121_000);
		utimesSync(sessionFile, stale, stale);
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		const next = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
		next.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id } }), answer("CHECKED")]);
		await next.session.prompt("lookup interrupted resume");
		expect(outcomes(next, "get_subagent_result")[0]?.text).toContain("interrupted by a process restart");
	} finally {
		hold.release();
		await old;
		h.cleanup();
	}
});

it("refuses a fresh transcript whose resume start was never journaled, from another manager", {
	timeout: 30_000,
}, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const hold = fixture.heldTool();
	const child = fixture.physical("kid", "child", [
		answer("FIRST DONE"),
		toolCalls({ name: "hold", args: {} }),
		answer("DONE AFTER HOLD"),
	]);
	const parent = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: parent } });
	h.setResponses([toolCalls(spawn("foreground probe", { run_in_background: false })), answer("SPAWNED")]);
	await h.session.prompt("spawn foreground");
	const row = parent.getBranch().find((entry) => entry.type === "custom" && entry.customType === "subagents:record");
	if (row?.type !== "custom") throw new Error("Missing child record");
	const { id, sessionFile } = row.data as { id: string; sessionFile: string };
	// The resume's `running` row is lost: the journal still ends on `completed`.
	const append = parent.appendCustomEntry.bind(parent);
	const lost = vi.spyOn(parent, "appendCustomEntry").mockImplementation((customType, data) => {
		if (customType === "subagents:record" && (data as { status?: string }).status === "running")
			throw new Error("journal truncated");
		return append(customType, data);
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	h.setResponses([toolCalls(spawn("resume foreground", { resume: id, run_in_background: false })), answer("DONE")]);
	const old = h.session.prompt("resume into tool barrier");
	await hold.entered;
	try {
		expect(errors.mock.calls.flat().join(" ")).toContain("journal truncated");
		const journaled = parent
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
			.at(-1);
		expect(journaled).toMatchObject({ data: { id, status: "completed" } });
		const fresh = new Date(fixture.clock.now() - 5_000);
		utimesSync(sessionFile, fresh, fresh);
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Missing parent transcript");
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
		const next = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
		next.setResponses([
			toolCalls(
				{ name: "get_subagent_result", args: { agent_id: id } },
				spawn("resume from another manager", { resume: id }),
			),
			answer("CHECKED"),
		]);
		await next.session.prompt("recover the resumed child");
		const refusal = "may still be running in another process (last recorded status completed, last write 5s ago";
		expect(outcomes(next, "get_subagent_result")[0]).toMatchObject({
			isError: true,
			text: expect.stringContaining(refusal),
		});
		expect(outcomes(next, "Agent")[0]).toMatchObject({ isError: true, text: expect.stringContaining(refusal) });
		expect(child.state.callCount).toBe(2);
		next.cleanup();
	} finally {
		lost.mockRestore();
		errors.mockRestore();
		hold.release();
		await old;
		h.cleanup();
	}
});

it("#330: a fresh stopped child retains its output across a fresh parent activation", { timeout: 30_000 }, async () => {
	fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
	const hold = fixture.heldTool();
	const child = fixture.physical("kid", "child", [
		fauxAssistantMessage([{ type: "text", text: "SYNTHETIC PROGRESS 330" }, fauxToolCall("hold", {})], {
			stopReason: "toolUse",
		}),
		answer("CONTINUED AFTER RESTART"),
	]);
	const manager = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
	const h = await fixture.start({ harness: { sessionManager: manager } });
	h.setResponses([toolCalls(spawn("restart probe")), answer("SPAWNED")]);
	await h.session.prompt("spawn");
	await hold.entered;
	const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
	if (!id) throw new Error("No actual Agent receipt");
	const record = fixture.record(id);
	const output = record.outputFile;
	if (!output) throw new Error("No actual output path");
	expect(record.status).toBe("running");
	expect(existsSync(output)).toBe(true);

	// The real stop tool aborts the run, then the outstanding tool is allowed to settle.
	h.setResponses([toolCalls({ name: "stop_subagent", args: { agent_id: id } }), answer("STOP REQUESTED")]);
	await h.session.prompt("stop");
	hold.release();
	await record.promise;
	expect(record.status).toBe("stopped");
	expect(record.result).toContain("SYNTHETIC PROGRESS 330");
	const persisted = readFileSync(output, "utf8");
	expect(persisted).toContain("SYNTHETIC PROGRESS 330");
	expect(persisted).not.toContain("CONTINUED AFTER RESTART");
	expect(child.state.callCount).toBe(1);

	// Malformed custom history must not turn session startup into a failure.
	manager.appendCustomEntry("subagents:record", null);
	// A saved run that left no result text still answers with its metadata alone.
	manager.appendCustomEntry("subagents:record", {
		id: "synthetic-empty",
		type: "general-purpose",
		description: "no result",
		status: "completed",
	});
	const parentFile = manager.getSessionFile();
	if (!parentFile) throw new Error("Parent was not persisted");
	expect(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "subagents:record")).toBe(
		true,
	);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	h.cleanup();
	expect(Reflect.has(globalThis, Symbol.for("pi-subagents:manager"))).toBe(false);
	expect(readFileSync(output, "utf8")).toBe(persisted);

	// Fresh extension + manager, same saved parent: no old registry or detached survivor is retained.
	// #900: the saved note still points at this transcript, so reopening keeps it past retention.
	const tasksDir = dirname(output);
	const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	for (const path of [output, tasksDir, dirname(tasksDir)]) utimesSync(path, stale, stale);
	// A journaled terminal status is not proof the writer is gone: a recent write still blocks a reopen.
	if (!record.sessionFile) throw new Error("Missing child transcript");
	const recent = new Date(fixture.clock.now());
	utimesSync(record.sessionFile, recent, recent);
	const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	expect(existsSync(output)).toBe(true);
	expect(Date.now() - statSync(dirname(tasksDir)).mtimeMs).toBeLessThan(60 * 1000);
	reopened.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id } }), answer("LOOKED UP")]);
	await reopened.session.prompt("lookup");
	const recovered = outcomes(reopened, "get_subagent_result")[0]?.text ?? "";
	expect(recovered).not.toContain("Agent not found");
	expect(recovered).toContain("last recorded status: stopped, recovered from saved parent session");
	expect(recovered).toContain(`transcript: ${output}`);
	expect(recovered).toContain("SYNTHETIC PROGRESS 330"); // the saved result text comes back with the branch (#372)
	expect(recovered).toContain(
		"may still be running in another process (last recorded status stopped, last write 0s ago; retry in 120 s)",
	);
	reopened.setResponses([
		toolCalls({ name: "get_subagent_result", args: { agent_id: "synthetic-empty" } }),
		answer("LOOKED UP EMPTY"),
	]);
	await reopened.session.prompt("lookup empty");
	expect(outcomes(reopened, "get_subagent_result").at(-1)?.text).toMatch(
		/^Agent "synthetic-empty" \(no result\) last recorded status: completed, recovered from saved parent session[^\n]*$/,
	);
	expect(readFileSync(output, "utf8")).toBe(persisted);
	expect(child.state.callCount).toBe(1);
	// The dispatch rechecks the write age, so the wait clears without a restart.
	fixture.clock.advance(RECENT_CHILD_WRITE_SECONDS * 1000);
	reopened.setResponses([
		toolCalls({ name: "stop_subagent", args: { agent_id: id } }),
		toolCalls({ name: "steer_subagent", args: { agent_id: "synthetic-empty", message: "no transcript to open" } }),
		toolCalls({
			name: "Agent",
			args: {
				resume: id,
				subagent_type: "general-purpose",
				description: "manual recovery",
				prompt: "continue",
				run_in_background: true,
			},
		}),
		answer("CHECKED HISTORICAL CONTROLS"),
	]);
	await reopened.session.prompt("historical controls");
	const stop = outcomes(reopened, "stop_subagent")[0];
	expect(stop?.isError).toBe(true);
	expect(stop?.text).toContain("last recorded status: stopped");
	expect(stop?.text).toContain("this historical entry cannot stop work");
	expect(stop?.text).not.toContain("is not running (status:");
	expect(outcomes(reopened, "steer_subagent")[0]).toMatchObject({
		isError: true,
		text: expect.stringContaining("only historical metadata is available; reopen the recorded session manually."),
	});
	const resume = outcomes(reopened, "Agent")[0];
	expect(resume?.isError).toBe(false);
	expect(resume?.text).toContain(`Agent resumed in background, reopening evicted agent ${id}`);
	const next = agentId(resume?.text);
	expect(next).not.toBe(id);
	await fixture.record(next).promise;
	expect(fixture.record(next).result).toBe("CONTINUED AFTER RESTART");
	expect(child.state.callCount).toBe(2);
});
