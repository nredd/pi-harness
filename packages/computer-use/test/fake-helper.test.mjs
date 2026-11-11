// Self-test of `support/fake-helper.mjs` beyond the macOS flat profile: the envelope profile and stdio
// transport are driven by the real `WindowsHelperClient`, the wire format #713 (Windows and Linux) reuses.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	body,
	createFakeChild,
	createFakeSpawn,
	createHelperEngine,
	fail,
	ok,
	shortSocketPath,
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
		await assert.rejects(client.command("nope"), (error) => error.code === "unknown_command");
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
