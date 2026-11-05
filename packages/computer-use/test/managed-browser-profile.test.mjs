import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { shutdownComputerUseSession, testing } from "../src/bridge.ts";

// Fake `chrome`: refuses to start unless it can write its profile, like the real browser, then serves the
// smallest CDP surface `launch_browser` reads (`/json/version`, one `/json/list` page, `{}` for every
// WebSocket command). It records its argv so the test can find the profile dir and port.
const FAKE_BROWSER = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const arg = (name) => process.argv.find((value) => value.startsWith("--" + name + "="))?.slice(name.length + 3);
const port = Number(arg("remote-debugging-port"));
const profile = arg("user-data-dir");
fs.writeFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({ port, profile }));
try {
	fs.writeFileSync(path.join(profile, "Local State"), "{}");
} catch (error) {
	process.stderr.write(String(error));
	process.exit(1);
}

const frame = (payload) => Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
const server = http.createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url === "/json/version") return response.end("{}");
	if (request.url === "/json/list") {
		return response.end(JSON.stringify([{ id: "fake", type: "page", title: "Fake", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/fake" }]));
	}
	response.statusCode = 404;
	response.end();
});
server.on("upgrade", (request, socket) => {
	const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
	socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
	let buffer = Buffer.alloc(0);
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 6) {
			let length = buffer[1] & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			}
			if (buffer.length < offset + 4 + length) return;
			const opcode = buffer[0] & 0x0f;
			const mask = buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
			buffer = buffer.subarray(offset + 4 + length);
			for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
			if (opcode === 8) return socket.end();
			if (opcode === 1) socket.write(frame(Buffer.from(JSON.stringify({ id: JSON.parse(payload.toString()).id, result: {} }))));
		}
	});
});
server.listen(port, "127.0.0.1");
`;

/**
 * Read the host's ephemeral port range, which is where `freeTcpPort()` gets the CDP port.
 * @returns {[number, number]} Inclusive first and last ephemeral port.
 * @throws {Error} If the range cannot be read on this platform.
 */
function ephemeralPortRange() {
	if (process.platform === "darwin") {
		const [first, last] = execFileSync("sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
		return [first, last];
	}
	const [first, last] = fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
	return [first, last];
}

/**
 * Wait until a path no longer exists.
 * @param {string} target Path expected to disappear.
 * @param {number} timeoutMs Failure backstop.
 * @returns {Promise<void>} Resolves once `target` is gone.
 * @throws {import('node:assert').AssertionError} If `target` still exists at the deadline.
 */
async function waitForRemoval(target, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (fs.existsSync(target) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert(!fs.existsSync(target), `managed browser profile ${target} outlived the browser`);
}

describe.skipIf(process.platform === "win32")("managed browser profile", () => {
	const saved = {};
	let scratch;
	let tmp;
	let log;

	beforeAll(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-computer-use-cdp-profile-"));
		tmp = path.join(scratch, "tmp");
		fs.mkdirSync(tmp);
		log = path.join(scratch, "argv.json");
		const executable = path.join(scratch, "fake-chrome.mjs");
		fs.writeFileSync(executable, FAKE_BROWSER, { mode: 0o755 });
		for (const name of ["TMPDIR", "FAKE_BROWSER_LOG", "PI_COMPUTER_USE_CHROME_EXECUTABLE", "PI_COMPUTER_USE_CDP_PORT"]) saved[name] = process.env[name];
		process.env.TMPDIR = tmp;
		process.env.FAKE_BROWSER_LOG = log;
		process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = executable;
		delete process.env.PI_COMPUTER_USE_CDP_PORT;

		// Squat the retired fixed name `pi-chrome-cdp-<port>` for every port `freeTcpPort()` can hand out,
		// as another account sharing `/tmp` would. A launch that still uses it cannot write its profile.
		const [first, last] = ephemeralPortRange();
		for (let port = first; port <= last; port += 1) fs.mkdirSync(path.join(tmp, `pi-chrome-cdp-${port}`), { mode: 0o555 });
	});

	afterAll(async () => {
		await shutdownComputerUseSession();
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		if (scratch) {
			for (const entry of fs.readdirSync(tmp)) fs.chmodSync(path.join(tmp, entry), 0o755);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("launch uses a private profile dir that ignores a squatted fixed name and is removed on exit", async () => {
		const result = await testing.performLaunchBrowser({});
		assert.match(result.content[0].text, /Fake|about:blank/, "launch_browser did not observe the managed page");

		const { port, profile } = JSON.parse(fs.readFileSync(log, "utf8"));
		const legacy = path.join(tmp, `pi-chrome-cdp-${port}`);
		assert.throws(() => fs.accessSync(legacy, fs.constants.W_OK), "squatted legacy profile dir is writable, so this run proves nothing (root?)");
		assert.equal(path.dirname(profile), tmp, "profile dir is not under os.tmpdir()");
		assert.match(path.basename(profile), /^pi-chrome-cdp-[^/]+$/);
		assert.notEqual(profile, legacy, "launch_browser reused the fixed shared-temp profile name");
		assert.equal(fs.statSync(profile).mode & 0o777, 0o700, "profile dir is readable by other accounts");
		assert.equal(fs.statSync(profile).uid, process.getuid(), "profile dir is not owned by this account");

		await shutdownComputerUseSession();
		await waitForRemoval(profile, 5_000);
	});
});
