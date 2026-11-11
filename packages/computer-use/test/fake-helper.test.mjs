// Self-test of `support/fake-helper.mjs` beyond the macOS flat profile: the envelope profile and stdio
// transport are driven by the real `WindowsHelperClient`, the wire format #713 (Windows and Linux) reuses.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	body,
	createFakeChild,
	createFakeSpawn,
	createHelperEngine,
	fail,
	ok,
	shortSocketPath,
	slow,
	startFakeHelper,
	withProtocol,
} from "./support/fake-helper.mjs";

let tmp;
let exe;

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "fht-"));
	exe = path.join(tmp, "windows-bridge.exe");
	writeFileSync(exe, "#!/bin/sh\n");
	chmodSync(exe, 0o755);
});

afterEach(() => {
	vi.doUnmock("node:child_process");
	vi.unstubAllEnvs();
	vi.resetModules();
	rmSync(tmp, { recursive: true, force: true });
});

async function windowsClient(engine) {
	vi.resetModules();
	vi.stubEnv("PI_COMPUTER_USE_WINDOWS_HELPER_PATH", exe);
	const spawn = createFakeSpawn({
		[path.basename(process.execPath)]: { exitCode: 0 },
		"windows-bridge.exe": () => createFakeChild({ engine }),
	});
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const { WindowsHelperClient } = await import("../src/platform/windows/helper.ts");
	return { client: new WindowsHelperClient(), spawn };
}

describe("envelope profile over a fake child's stdio", () => {
	test("serves requests, scripted errors with codes, and unknown commands", async () => {
		const engine = createHelperEngine({
			profile: "envelope",
			protocolVersion: 4,
			handlers: { look: ok({ roots: [] }), click: fail("denied", "permission_denied") },
		});
		const { client } = await windowsClient(engine);
		assert.deepEqual(await client.command("look", { app: "x" }), { roots: [] });
		assert.deepEqual(engine.requests[0].args, { app: "x" });
		assert.equal(engine.requests[0].raw.protocolVersion, 4);
		await assert.rejects(client.command("click"), (error) => error.code === "permission_denied" && error.message === "denied");
		await assert.rejects(client.command("nope"), (error) => error.code === "unsupported_command" && error.message === "Unknown command 'nope'");
		assert.equal((await client.command("diagnostics")).protocolVersion, 4);
		client.dispose();
	});

	test("withProtocol makes the client reject a protocol mismatch; body() sends arbitrary replies", async () => {
		const engine = createHelperEngine({
			profile: "envelope",
			protocolVersion: 4,
			handlers: { old: withProtocol(3), weird: body({ ok: false }) },
		});
		const { client } = await windowsClient(engine);
		await assert.rejects(client.command("old"), /protocol mismatch: expected 4, got 3/);
		await assert.rejects(client.command("weird"), /Windows helper command failed\./);
		client.dispose();
	});

	test("a child that exits mid-request ends the stream", async () => {
		const engine = createHelperEngine({ profile: "envelope", protocolVersion: 4, handlers: { crash: { kind: "drop" } } });
		const child = createFakeChild({ engine });
		const closed = new Promise((resolve) => child.once("close", resolve));
		child.stdin.write(`${JSON.stringify({ protocolVersion: 4, id: "1", cmd: "crash", args: {} })}\n`);
		assert.deepEqual(await closed, 1);
		assert.equal(child.exitCode, 1);
	});
});

describe("wire fidelity", () => {
	/** Feed `lines` to an engine and collect parsed replies. */
	async function exchange(options, lines) {
		const engine = createHelperEngine(options);
		const replies = [];
		const io = { write: (text) => replies.push(JSON.parse(text)), end: () => undefined, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
		for (const line of lines) await engine.handleLine(line, io);
		return { engine, replies };
	}
	const err = (id, code, message) => ({ id, ok: false, error: { message, code } });
	const envelope = { profile: "envelope", protocolVersion: 4, platform: "Linux" };

	test("flat profile: invalid JSON and non-objects get id `invalid` and invalid_request; blank lines are ignored", async () => {
		const { replies } = await exchange({ profile: "flat" }, ["{nope", "null", "[1]", "   ", JSON.stringify({ id: "a", cmd: "zzz" })]);
		assert.deepEqual(replies[0], err("invalid", "invalid_request", "Input was not valid JSON"));
		assert.deepEqual(replies[1], err("invalid", "invalid_request", "Request must be a JSON object"));
		assert.deepEqual(replies[2], err("invalid", "invalid_request", "Request must be a JSON object"));
		assert.deepEqual(replies[3], err("a", "unknown_command", "Unknown command 'zzz'"));
		assert.equal(replies.length, 4);
	});

	test("flat profile handles one connection's lines serially", async () => {
		const engine = createHelperEngine({ profile: "flat", handlers: { slow: slow(80, ok({ n: 1 })), fast: ok({ n: 2 }) } });
		const order = [];
		const input = new PassThrough();
		serveForTest(engine, input, order);
		input.write('{"id":"1","cmd":"slow"}\n{"id":"2","cmd":"fast"}\n');
		await vi.waitFor(() => assert.deepEqual(order, ["1", "2"]));
	});

	test("envelope profile runs requests concurrently", async () => {
		const engine = createHelperEngine({ ...envelope, handlers: { slow: slow(80, ok({})), fast: ok({}) } });
		const order = [];
		const input = new PassThrough();
		serveForTest(engine, input, order);
		const line = (id, cmd) => `${JSON.stringify({ protocolVersion: 4, id, cmd, args: {} })}\n`;
		input.write(line("1", "slow") + line("2", "fast"));
		await vi.waitFor(() => assert.deepEqual(order, ["2", "1"]));
	});

	test("envelope profile rejects malformed requests like the Rust helpers", async () => {
		const { replies, engine } = await exchange(envelope, [
			"{nope",
			"null",
			JSON.stringify({ protocolVersion: 4, id: "m", cmd: "look" }),
			JSON.stringify({ id: "p", cmd: "look", args: {} }),
			JSON.stringify({ protocolVersion: "4", id: "t", cmd: "look", args: {} }),
			JSON.stringify({ protocolVersion: 3, id: "v", cmd: "look", args: {} }),
		]);
		const codes = replies.map((reply) => [reply.id, reply.error.code, reply.protocolVersion]);
		assert.deepEqual(codes, [
			["unknown", "invalid_request", 4],
			["unknown", "invalid_request", 4],
			["m", "invalid_request", 4],
			["p", "invalid_request", 4],
			["t", "invalid_request", 4],
			["v", "invalid_request", 4],
		]);
		assert.match(replies[2].error.message, /missing field `args`/);
		assert.equal(replies[5].error.message, "Unsupported Linux helper protocol 3; expected 4. Restart Pi to use the installed helper.");
		assert.equal(engine.requests.length, 0, "invalid requests are not recorded");
	});

	test("default shutdown replies {shuttingDown:true} and exits about 200 ms later", async () => {
		const engine = createHelperEngine({ profile: "flat" });
		let exitedAt;
		engine.onExit = () => {
			exitedAt = Date.now();
		};
		const started = Date.now();
		const replies = [];
		await engine.handleLine('{"id":"s","cmd":"shutdown"}', { write: (t) => replies.push(JSON.parse(t)), end() {}, sleep: () => undefined });
		assert.deepEqual(replies, [{ id: "s", ok: true, result: { shuttingDown: true } }]);
		assert.equal(exitedAt, undefined);
		await vi.waitFor(() => assert.ok(exitedAt - started >= 190));
	});

	test("a shut-down socket helper stops listening and can be relaunched explicitly", async () => {
		const { socketPath, dispose } = shortSocketPath();
		const fake = await startFakeHelper({ socketPath });
		try {
			const ask = (cmd) =>
				new Promise((resolve, reject) => {
					const socket = net.createConnection(socketPath);
					socket.setEncoding("utf8");
					socket.once("error", reject);
					socket.once("data", (data) => {
						socket.destroy();
						resolve(JSON.parse(data));
					});
					socket.write(`${JSON.stringify({ id: "1", cmd })}\n`);
				});
			assert.deepEqual((await ask("shutdown")).result, { shuttingDown: true });
			await new Promise((resolve) => setTimeout(resolve, 400));
			await assert.rejects(ask("diagnostics"), /ECONNREFUSED|ENOENT/);
			await fake.start();
			assert.equal((await ask("diagnostics")).ok, true);
			fake.relaunchAfterExit({ delayMs: 10, diagnostics: { protocolVersion: 8 } });
			await ask("shutdown");
			await vi.waitFor(async () => assert.equal((await ask("diagnostics")).result.protocolVersion, 8), { timeout: 2_000 });
		} finally {
			await fake.stop();
			dispose();
		}
	});
});

function serveForTest(engine, input, order) {
	let buffer = "";
	let tail = Promise.resolve();
	input.setEncoding("utf8");
	input.on("data", (chunk) => {
		buffer += chunk;
		for (let n = buffer.indexOf("\n"); n >= 0; n = buffer.indexOf("\n")) {
			const line = buffer.slice(0, n);
			buffer = buffer.slice(n + 1);
			const run = () => engine.handleLine(line, { write: (t) => order.push(JSON.parse(t).id), end() {}, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
			if (engine.profile === "flat") tail = tail.then(run);
			else void run();
		}
	});
}

describe("socket server", () => {
	test("disconnectAll drops live clients but keeps listening, and the envelope reply is framed per profile", async () => {
		const { socketPath, dispose } = shortSocketPath();
		const fake = await startFakeHelper({ socketPath, profile: "envelope", protocolVersion: 4, handlers: { look: ok({}) } });
		try {
			const lines = [];
			const socket = net.createConnection(socketPath);
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => lines.push(chunk));
			socket.write(`${JSON.stringify({ protocolVersion: 4, id: "a", cmd: "look", args: {} })}\n`);
			await vi.waitFor(() => assert.equal(lines.join(""), '{"protocolVersion":4,"id":"a","ok":true,"result":{}}\n'));
			const closed = new Promise((resolve) => socket.once("close", resolve));
			fake.disconnectAll();
			await closed;
			await new Promise((resolve, reject) => {
				const again = net.createConnection(socketPath);
				again.once("connect", () => {
					again.destroy();
					resolve();
				});
				again.once("error", reject);
			});
			assert.equal(fake.connections, 2);
		} finally {
			await fake.stop();
			dispose();
		}
	});
});
