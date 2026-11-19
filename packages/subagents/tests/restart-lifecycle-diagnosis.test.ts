/** Synthetic #330 diagnosis: distinguish activation reload, terminal stop and process-state loss. */
import { existsSync, readFileSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { outcomes, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import { answer, ScenarioSession, spawn } from "./fixtures/scenario-session.ts";

let fixture: ScenarioSession;

function agentId(receipt: string | undefined): string {
	const id = receipt?.match(/Agent ID: (\S+)/)?.[1];
	if (!id) throw new Error(`No Agent ID in ${receipt}`);
	return id;
}
afterEach(async () => {
	await fixture?.dispose();
	Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
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

it.each(["Agent", "steer_subagent", "deleted", "chain"] as const)(
	"recovers a saved running child after a crash: %s",
	{ timeout: 30_000 },
	async (mode) => {
		fixture = new ScenarioSession({ rememberAgents: true, agentModels: { "general-purpose": "kid/child" } });
		const hold = fixture.heldTool();
		const progress = fauxAssistantMessage([{ type: "text", text: "PROGRESS BEFORE CRASH" }, fauxToolCall("hold", {})], {
			stopReason: "toolUse",
		});
		const request = deferred<string>();
		const child = fixture.physical("kid", "child", [
			...(mode === "chain" ? [answer("FIRST RUN DONE")] : []),
			progress,
			(context) => {
				request.resolve(JSON.stringify(context.messages));
				return mode === "chain" ? progress : answer("RECOVERED CHILD DONE");
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
		await call(h, spawn("crash probe", { name: "crash-probe" }));
		const first = agentId(outcomes(h, "Agent")[0]?.text);
		let id = first;
		if (mode === "chain") {
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
			if (mode === "chain") {
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
			const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
			expect(child.state.callCount).toBe(mode === "chain" ? 2 : 1);
			await call(reopened, get(first));
			const diagnostic = outcomes(reopened, "get_subagent_result").at(-1);
			expect(diagnostic?.isError).toBe(false);
			expect(diagnostic?.text).toContain(`Agent "${id}"`);
			expect(diagnostic?.text).toContain("interrupted by a process restart");
			expect(diagnostic?.text).toContain(`transcript: ${childFile}`);
			expect(child.state.callCount).toBe(mode === "chain" ? 2 : 1);

			if (mode === "deleted") {
				await call(reopened, resume(id), steer(id));
				for (const tool of ["Agent", "steer_subagent"]) {
					const failure = outcomes(reopened, tool).at(-1);
					expect(failure?.isError).toBe(true);
					expect(failure?.text).toContain("only historical metadata is available");
					expect(failure?.text.split("\n")[0]).toContain(childFile);
				}
				expect(child.state.callCount).toBe(1);
				return;
			}

			const tool = mode === "steer_subagent" ? steer(first) : resume(first);
			await call(reopened, tool);
			const receipt = outcomes(reopened, tool.name).at(-1);
			expect(receipt?.isError).toBe(false);
			expect(receipt?.text).toContain(`Agent resumed in background, reopening evicted agent ${id}`);
			const next = agentId(receipt?.text);
			expect(next).not.toBe(id);
			const continued = fixture.record(next);
			expect(await request.promise).toContain("PROGRESS BEFORE CRASH");
			expect(await request.promise).toContain("CONTINUE AFTER CRASH");
			if (mode === "chain") {
				await call(reopened, get("unrelated"));
				expect(outcomes(reopened, "get_subagent_result").at(-1)?.text).toContain('Agent "unrelated"');
				await call(reopened, resume(id));
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
			expect(continued.alias).toBe("crash-probe");
		} finally {
			lost.abortController?.abort();
			hold.release();
			await lost.promise;
			h.cleanup();
		}
	},
);

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
