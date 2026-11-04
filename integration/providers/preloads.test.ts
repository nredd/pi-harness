import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionStartupError } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, test, vi } from "vitest";
import guardAuthTransport from "./auth_guard.mjs";
import { verifyTransport } from "./auth_transport.mjs";

// One forked worker per file (`vitest.config.ts`): the redirect preload replaces `fetch` and the
// `child_process` exports for the whole process, exactly as `node --import` does, and installs once.
// The tests below share that process and run in order.

interface Recorded {
	method: string;
	url: string;
	authorization: string | undefined;
	body: string;
}

type Spawn = (command: unknown, ...rest: unknown[]) => unknown;

const NONCE = "nonce-1";
const realFetch = globalThis.fetch;
const requests: Recorded[] = [];
const bunCalls: unknown[] = [];
// A stand-in for Bun's native spawn API and `Bun.fetch`, installed only around the code that reads it.
const fakeBun: { fetch: typeof fetch; spawn: Spawn; spawnSync: Spawn } = {
	fetch: realFetch,
	spawn: (command) => bunCalls.push(["spawn", command]),
	spawnSync: (command) => bunCalls.push(["spawnSync", command]),
};
// The real exports, read before the preload replaces them, to prove the wrappers are in place.
const originalSpawnSync = spawnSync;
const originalExecFileSync = execFileSync;
const bunRecorders = { spawn: fakeBun.spawn, spawnSync: fakeBun.spawnSync };
let server: Server;
let mock = "";
let root = "";
let blockedLog = "";
let redirectDescriptor: PropertyDescriptor | undefined;

function setBun(present: boolean): void {
	if (present) Reflect.set(globalThis, "Bun", fakeBun);
	else Reflect.deleteProperty(globalThis, "Bun");
}

/** Import a module fresh, so a top-level script or a failed import runs again. */
async function importFresh(path: string): Promise<unknown> {
	vi.resetModules();
	return import(path);
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "provider-preloads-"));
	blockedLog = join(root, "blocked.log");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			if (url.pathname === "/__harness_ready__") {
				response.end(JSON.stringify({ nonce: url.searchParams.get("nonce") }));
				return;
			}
			requests.push({
				method: request.method ?? "",
				url: request.url ?? "",
				authorization: request.headers.authorization,
				body,
			});
			if (url.pathname === "/bounce") response.writeHead(302, { location: "https://example.com/" });
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	mock = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	setBun(false);
	await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
});

test("without the redirect preload the transport check and the startup guard fail closed", async () => {
	vi.stubEnv("HARNESS_ANTHROPIC_MOCK", mock);
	vi.stubEnv("HARNESS_AUTH_NONCE", NONCE);
	await assert.rejects(verifyTransport(), /Auth transport NOT RUN: redirect preload is missing in this runtime/);
	const failure = await guardAuthTransport().then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.ok(failure instanceof ExtensionStartupError);
	assert.match(failure.message, /^Auth transport guard failed: Error: Auth transport NOT RUN/);
	vi.unstubAllEnvs();
});

test("the redirect preload refuses to install without a mock and nonce, or with a non-loopback mock", async () => {
	vi.stubEnv("HARNESS_ANTHROPIC_MOCK", "");
	vi.stubEnv("HARNESS_AUTH_NONCE", NONCE);
	await assert.rejects(
		importFresh("./redirect_anthropic.mjs"),
		/redirect_anthropic\.mjs needs HARNESS_ANTHROPIC_MOCK and HARNESS_AUTH_NONCE/,
	);
	for (const endpoint of ["http://localhost:9", `${mock}/`, "https://127.0.0.1:9"]) {
		vi.stubEnv("HARNESS_ANTHROPIC_MOCK", endpoint);
		await assert.rejects(
			importFresh("./redirect_anthropic.mjs"),
			/Auth transport requires an exact http:\/\/127\.0\.0\.1 loopback origin/,
		);
	}
	assert.equal(globalThis.fetch, realFetch);
	assert.equal(Reflect.get(globalThis, Symbol.for("pi-harness.auth-redirect")), undefined);
	vi.unstubAllEnvs();
});

test("the installed preload sends Anthropic hosts to the mock, passes loopback and refuses other hosts", async () => {
	process.env.HARNESS_ANTHROPIC_MOCK = mock;
	process.env.HARNESS_AUTH_NONCE = NONCE;
	process.env.HARNESS_BLOCKED_LOG = blockedLog;
	setBun(true);
	try {
		await importFresh("./redirect_anthropic.mjs");
	} finally {
		setBun(false);
	}
	redirectDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	assert.deepEqual(Reflect.get(globalThis, Symbol.for("pi-harness.auth-redirect")), { mock, nonce: NONCE });
	for (const host of ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"]) {
		const response = await fetch(`https://${host}/v1/messages?beta=true`, {
			method: "POST",
			headers: { authorization: `Bearer ${host}` },
			body: "{}",
		});
		assert.equal(response.status, 200);
	}
	const request = new Request("https://claude.ai/oauth/token?grant=refresh", { method: "POST", body: "grant" });
	assert.equal((await fetch(request)).status, 200);
	assert.equal((await fetch(`${mock}/loopback?direct=1`)).status, 200);
	assert.deepEqual(requests.splice(0), [
		...["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"].map((host) => ({
			method: "POST",
			url: "/v1/messages?beta=true",
			authorization: `Bearer ${host}`,
			body: "{}",
		})),
		{ method: "POST", url: "/oauth/token?grant=refresh", authorization: undefined, body: "grant" },
		{ method: "GET", url: "/loopback?direct=1", authorization: undefined, body: "" },
	]);
	for (const url of ["https://example.com/v1", "http://10.0.0.1:8080/", "https://anthropic.com/"]) {
		assert.throws(() => fetch(url), {
			message: `harness refused non-loopback fetch: ${new URL(url).origin}`,
		});
	}
	// No redirects are followed, so a loopback 30x cannot bounce a request off the machine.
	await assert.rejects(fetch(`http://localhost:${new URL(mock).port}/bounce`), TypeError);
	assert.deepEqual(
		requests.splice(0).map(({ url }) => url),
		["/bounce"],
	);
});

test("a later fetch assignment replaces the inner fetch, never the redirect in front of it", async () => {
	const seen: string[] = [];
	globalThis.fetch = async (input) => {
		seen.push(input instanceof Request ? input.url : String(input));
		return Response.json({ replaced: true });
	};
	try {
		const response = await fetch("https://api.anthropic.com/v1/models");
		assert.deepEqual(await response.json(), { replaced: true });
		assert.throws(() => fetch("https://example.com/"), /harness refused non-loopback fetch/);
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.deepEqual(seen, [`${mock}/v1/models`]);
	assert.deepEqual(requests, []);
});

test("claude and security are blocked and recorded through child_process and Bun; others run", () => {
	// Fail safe: if a wrapper ever regressed, these calls reach only recording stubs the test owns,
	// on an isolated PATH or by an absolute path inside it, never a real `claude` or `security`.
	const stubs = join(root, "stub-bin");
	const stubLog = join(root, "stub-calls.log");
	mkdirSync(stubs);
	for (const name of ["claude", "security"]) {
		writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> '${stubLog}'\n`);
		chmodSync(join(stubs, name), 0o755);
	}
	const sentinel = join(stubs, "security");
	assert.notEqual(spawnSync, originalSpawnSync, "redirect preload did not wrap child_process.spawnSync");
	assert.notEqual(execFileSync, originalExecFileSync, "redirect preload did not wrap child_process.execFileSync");
	assert.notEqual(fakeBun.spawn, bunRecorders.spawn, "redirect preload did not wrap Bun.spawn");
	assert.notEqual(fakeBun.spawnSync, bunRecorders.spawnSync, "redirect preload did not wrap Bun.spawnSync");
	const path = process.env.PATH;
	process.env.PATH = stubs;
	try {
		const commands = [
			() => spawnSync(sentinel, ["find-generic-password"]),
			() => execFileSync("claude", ["--version"]),
			() => fakeBun.spawn([join(stubs, "claude"), "-p"]),
			() => fakeBun.spawnSync({ cmd: ["security", "dump-keychain"] }),
		];
		for (const command of commands) assert.throws(command, /harness blocked `(claude|security)` via /);
	} finally {
		process.env.PATH = path;
	}
	assert.equal(existsSync(stubLog), false, "a blocked command reached its stub");
	assert.deepEqual(readFileSync(blockedLog, "utf8").trim().split("\n"), [
		`security ${sentinel} (spawnSync)`,
		"claude claude (execFileSync)",
		`claude ${join(stubs, "claude")} (Bun.spawn)`,
		"security security (Bun.spawnSync)",
	]);
	// Only those two binaries: the same APIs still launch everything else.
	assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write('ran')"], { encoding: "utf8" }), "ran");
	fakeBun.spawn(["claude-helper"]);
	fakeBun.spawnSync({ cmd: ["git", "status"] });
	fakeBun.spawn({});
	assert.deepEqual(bunCalls, [
		["spawn", ["claude-helper"]],
		["spawnSync", { cmd: ["git", "status"] }],
		["spawn", {}],
	]);
});

test("the transport check passes only with the matching preload, refused egress and the echoed nonce", async () => {
	await verifyTransport();
	await guardAuthTransport();
	process.env.HARNESS_AUTH_NONCE = "other-nonce";
	await assert.rejects(verifyTransport(), /Auth transport NOT RUN/);
	process.env.HARNESS_AUTH_NONCE = NONCE;
	process.env.HARNESS_ANTHROPIC_MOCK = "http://127.0.0.1:1";
	await assert.rejects(verifyTransport(), /Auth transport NOT RUN/);
	process.env.HARNESS_ANTHROPIC_MOCK = mock;
	Object.defineProperty(globalThis, "fetch", { value: async () => Response.json({}), configurable: true });
	try {
		await assert.rejects(verifyTransport(), /Auth transport guard did not refuse non-loopback fetch/);
	} finally {
		assert.ok(redirectDescriptor);
		Object.defineProperty(globalThis, "fetch", redirectDescriptor);
	}
	globalThis.fetch = async () => Response.json({ nonce: "wrong" });
	try {
		await assert.rejects(verifyTransport(), /Auth transport loopback readiness nonce did not match/);
	} finally {
		globalThis.fetch = realFetch;
	}
	globalThis.fetch = async () => new Response(JSON.stringify({ nonce: NONCE }), { status: 503 });
	try {
		await assert.rejects(verifyTransport(), /Auth transport loopback readiness nonce did not match/);
	} finally {
		globalThis.fetch = realFetch;
	}
	await verifyTransport();
});

test("the compiled-host fixture passes under the preload and fails closed on each negative control", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	const run = async (flag?: string, bun = false) => {
		if (flag) process.argv.push(flag);
		setBun(bun);
		try {
			await importFresh("./auth_runtime_fixture.mjs");
		} finally {
			setBun(false);
			if (flag) process.argv.pop();
		}
	};
	try {
		for (const bun of [false, true]) {
			await run(undefined, bun);
			assert.deepEqual(requests.splice(0), [
				{
					method: "POST",
					url: "/v1/messages?fixture=1",
					authorization: "Bearer fixture-only",
					body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "hi" }] }),
				},
			]);
		}
		assert.deepEqual(log.mock.calls, [["AUTH_RUNTIME_FIXTURE_OK"], ["AUTH_RUNTIME_FIXTURE_OK"]]);
		await assert.rejects(run("--stale-nonce"), /Auth transport NOT RUN/);
		assert.equal(process.env.HARNESS_AUTH_NONCE, "wrong-nonce");
		process.env.HARNESS_AUTH_NONCE = NONCE;
		await assert.rejects(run("--lost-egress"), /Auth transport guard did not refuse non-loopback fetch/);
		assert.ok(redirectDescriptor);
		Object.defineProperty(globalThis, "fetch", redirectDescriptor);
		await assert.rejects(run("--wrong-echo"), /Auth transport loopback readiness nonce did not match/);
		globalThis.fetch = realFetch;
		assert.equal(log.mock.calls.length, 2);
		assert.deepEqual(requests, []);
	} finally {
		log.mockRestore();
	}
});
