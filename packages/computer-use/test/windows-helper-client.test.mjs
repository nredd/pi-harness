// Drives `WindowsHelperClient` against `support/fake-helper.mjs` stdio children: no Windows helper runs.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, describe, test, vi } from "vitest";
import { createFakeChild, createFakeSpawn, createHelperEngine, drop, effect, fail, ok, silent, withProtocol } from "./support/fake-helper.mjs";

const clients = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	vi.useRealTimers();
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

async function clientFor(handlers) {
	const engine = createHelperEngine({ profile: "envelope", protocolVersion: 4, handlers, platform: "Windows" });
	const children = [];
	const spawn = createFakeSpawn({ "*": () => {
		const child = createFakeChild({ engine });
		children.push(child);
		return child;
	} });
	vi.resetModules();
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const { WindowsHelperClient } = await import("../src/platform/windows/helper.ts");
	const client = new WindowsHelperClient();
	clients.push(client);
	vi.spyOn(client, "ensureInstalled").mockResolvedValue(undefined);
	return { client, spawn, children, engine };
}

describe("Windows helper post-write cancellation (#750)", () => {
	for (const completion of ["success", "error", "protocol", "timeout", "close", "dispose", "write-callback", "write-throw", "non-error-throw", "serialize"]) {
		test(`${completion} removes the command abort listener and timer`, async () => {
			const { client, children, engine } = await clientFor({ warm: ok(), request: silent() });
			await client.command("warm");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const controller = new AbortController();
			const expected = new Error(completion);
			if (completion === "success") engine.script("request", ok("done"));
			if (completion === "error") engine.script("request", fail("denied", "permission_denied"));
			if (completion === "protocol") engine.script("request", withProtocol(3));
			if (completion === "write-callback") vi.spyOn(children[0].stdin, "write").mockImplementation((_line, callback) => { callback(expected); return false; });
			if (completion === "write-throw" || completion === "non-error-throw") vi.spyOn(children[0].stdin, "write").mockImplementation(() => { throw completion === "write-throw" ? expected : "write failed"; });
			const args = completion === "serialize" ? { toJSON() { throw expected; } } : {};
			const outcome = client.command("request", args, { signal: controller.signal, timeoutMs: 30_000 }).then((value) => ({ value }), (error) => ({ error }));
			if (["timeout", "close", "dispose"].includes(completion)) {
				await vi.waitFor(() => assert.equal(engine.requests.length, 2));
				assert.equal(getEventListeners(controller.signal, "abort").length, 1);
				if (completion === "timeout") await vi.advanceTimersByTimeAsync(30_000);
				if (completion === "close") children[0].emit("close", 1, null);
				if (completion === "dispose") client.dispose();
			}
			const result = await outcome;
			if (completion === "success") assert.equal(result.value, "done");
			else {
				assert.ok(result.error instanceof Error);
				if (["write-callback", "write-throw", "serialize"].includes(completion)) assert.equal(result.error, expected);
				if (completion === "non-error-throw") assert.equal(result.error.message, "write failed");
				if (completion === "error") assert.equal(result.error.code, "permission_denied");
				if (completion === "protocol") assert.match(result.error.message, /protocol mismatch/);
				if (completion === "timeout") assert.match(result.error.message, /timed out after 30000ms/);
				if (completion === "close") assert.equal(result.error.code, "helper_disconnected");
				if (completion === "dispose") assert.match(result.error.message, /session ended/);
			}
			assert.equal(client.pending.size, 0);
			assert.equal(vi.getTimerCount(), 0);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			controller.abort();
			assert.equal(await outcome, result, "a later abort cannot replace the settled outcome");
		});
	}

	test("aborting one request leaves a concurrent request and its listener alive", async () => {
		const { client, children, engine } = await clientFor({ a: silent(), b: silent() });
		const controller = new AbortController();
		const other = new AbortController();
		const aborted = client.command("a", {}, { signal: controller.signal }).catch((error) => error);
		const pending = client.command("b", {}, { signal: other.signal });
		await vi.waitFor(() => assert.equal(engine.requests.length, 2));
		controller.abort();
		assert.equal((await aborted).message, "Operation aborted.");
		assert.equal(client.pending.size, 1);
		assert.equal(getEventListeners(other.signal, "abort").length, 1);
		children[0].stdout.write(`${JSON.stringify({ protocolVersion: 4, id: engine.requests[1].id, ok: true, result: "B" })}\n`);
		assert.equal(await pending, "B");
		assert.equal(getEventListeners(other.signal, "abort").length, 0);
	});

	test("post-write abort clears pending, timer and listener immediately and drops a late reply", async () => {
		const { client, children, engine } = await clientFor({ hang: silent(), next: ok("next") });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const outcome = client.command("hang", {}, { signal: controller.signal, timeoutMs: 30_000 }).catch((error) => error);
		await vi.waitFor(() => assert.equal(engine.requests.length, 1));
		assert.equal(vi.getTimerCount(), 1);
		controller.abort();
		assert.equal(client.pending.size, 0, "post-write abort must remove the pending request immediately");
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal((await outcome).message, "Operation aborted.");
		const next = client.command("next", {}, { signal: new AbortController().signal });
		children[0].stdout.write(`${JSON.stringify({ protocolVersion: 4, id: engine.requests[0].id, ok: true, result: "late" })}\n`);
		assert.equal(await next, "next");
		assert.equal(client.pending.size, 0);
		assert.equal(vi.getTimerCount(), 0);
		assert.equal(children[0].killed, false, "abort cancels the local wait, not the helper process or native work");
	});
});

describe("Windows helper client disconnects (#725)", () => {
	test("a helper that exits mid-command rejects at once with helper_disconnected", async () => {
		const { client } = await clientFor({ crash: drop() });
		const timeoutMs = 30_000;
		const started = Date.now();
		await assert.rejects(client.command("crash", {}, { timeoutMs }), (error) => {
			assert.equal(error.code, "helper_disconnected");
			assert.doesNotMatch(error.message, /timed out/);
			return true;
		});
		assert.ok(Date.now() - started < timeoutMs / 2, "the exit must not wait out the command timeout");
		assert.equal(client.pending.size, 0);
	});

	test("replies still resolve, and a later exit leaves nothing pending", async () => {
		const { client, spawn } = await clientFor({ look: ok({ roots: [] }), hang: silent() });
		assert.deepEqual(await client.command("look"), { roots: [] });
		const pending = client.command("hang", {}, { timeoutMs: 30_000 });
		await vi.waitFor(() => assert.equal(client.pending.size, 1));
		client.child.emit("close", 1, null);
		await assert.rejects(pending, (error) => error.code === "helper_disconnected");
		assert.equal(spawn.calls.length, 1);
	});

	test("a dead child's partial line is not glued onto its successor's first reply", async () => {
		const { client, children, engine } = await clientFor({});
		engine.script("first", effect(() => {
			children.at(-1).stdout.write('{"id":"x"');
			children.at(-1).emit("exit", 1, null);
		}, silent()));
		engine.script("second", ok({ fine: true }));
		const first = client.command("first", {}, { timeoutMs: 30_000 });
		await vi.waitFor(() => assert.ok(children.length === 1 && client.child === undefined));
		assert.deepEqual(await client.command("second"), { fine: true });
		assert.equal(children.length, 2);
		children[0].emit("close", 1, null);
		await assert.rejects(first, (error) => error.code === "helper_disconnected");
		assert.deepEqual(await client.command("second"), { fine: true });
	});

	test("a complete reply still in stdout when the helper exits resolves the command", async () => {
		const { client, children, engine } = await clientFor({});
		engine.script("last", effect(() => {
			const child = children.at(-1);
			child.emit("exit", 0, null);
			setTimeout(() => child.emit("close", 0, null), 20);
		}, ok({ done: true })));
		assert.deepEqual(await client.command("last", {}, { timeoutMs: 30_000 }), { done: true });
		assert.equal(client.child, undefined, "exit forgets the child so the next command respawns");
	});
});
