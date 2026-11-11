// Drives `MacosHelperClient` and the activity-glow connection against `support/fake-helper.mjs`: real
// unix socket and NDJSON framing, faked `spawn` (ps, open, setup script). No Swift helper runs.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";
import {
	createFakeChild,
	createFakeSpawn,
	drop,
	fail,
	malformed,
	ok,
	raw,
	shortSocketPath,
	silent,
	slow,
	split,
	startFakeHelper,
	effect,
} from "./support/fake-helper.mjs";

// Cases that wait out the client's own fixed timers (30 x 100 ms probe loop, 400 ms restart pause, 2 s glow
// timeout). Longest alone: ~5.9 s; budget is ~7x that, see docs/test-worker-budgets.md.
const SLOW_MS = 45_000;

const cleanups = [];
let tmp;
let appPath;
let executable;

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "mhc-"));
	appPath = path.join(tmp, "pi-computer-use.app");
	executable = path.join(appPath, "Contents", "MacOS", "bridge");
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:net");
	vi.resetModules();
	while (cleanups.length) await cleanups.pop()();
});

function installExecutable() {
	mkdirSync(path.dirname(executable), { recursive: true });
	writeFileSync(executable, "#!/bin/sh\n");
	chmodSync(executable, 0o755);
}

/**
 * Import a fresh `helper.ts` (its socket path, app path and external-socket flag are module constants).
 * `external: true` sets `PI_CU_SOCKET_PATH`; otherwise the default socket path is in effect and `node:net`
 * redirects every connection to the fake's short path. `spawn` replaces `node:child_process.spawn`.
 */
async function load({ external, fake, spawn }) {
	vi.resetModules();
	vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", appPath);
	if (external) vi.stubEnv("PI_CU_SOCKET_PATH", fake.socketPath);
	else delete process.env.PI_CU_SOCKET_PATH;
	if (spawn) {
		vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	}
	if (!external) {
		vi.doMock("node:net", async (original) => {
			const actual = await original();
			const patched = { ...actual, createConnection: (_target, ...rest) => actual.createConnection(fake.socketPath, ...rest) };
			return { ...patched, default: patched };
		});
	}
	return await import("../src/platform/macos/helper.ts");
}

async function fakeOn({ protocol = 7, ...options } = {}) {
	const { socketPath, dispose } = shortSocketPath();
	const fake = await startFakeHelper({ socketPath, protocolVersion: protocol, ...options });
	cleanups.push(async () => {
		await fake.stop();
		dispose();
	});
	return fake;
}

describe("daemon commands over the socket", () => {
	test("round trips flat requests with sequential ids and joins split frames", async () => {
		const fake = await fakeOn({ handlers: { look: split(ok({ roots: [1, 2] }), 3) } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		assert.deepEqual(await client.command("look", { app: "Finder" }), { roots: [1, 2] });
		const [first, ...rest] = fake.requests.filter((request) => request.cmd === "look");
		assert.deepEqual(first.raw, { id: "req_2", cmd: "look", app: "Finder" });
		assert.equal(rest.length, 0);
		assert.equal(fake.requests[0].cmd, "diagnostics", "command() probes the daemon first");
	});

	test("error replies become HelperCommandError with the helper's code and message", async () => {
		const fake = await fakeOn({
			handlers: {
				click: fail("Accessibility permission is required.", "permission_denied"),
				bare: { kind: "reply", body: { ok: false } },
				odd: raw('{"id":"x","ok":"yes"}\n'),
			},
		});
		const { MacosHelperClient, HelperCommandError } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(client.command("click"), (error) => {
			assert.ok(error instanceof HelperCommandError);
			assert.equal(error.name, "HelperCommandError");
			assert.equal(error.code, "permission_denied");
			assert.equal(error.message, "Accessibility permission is required.");
			return true;
		});
		await assert.rejects(client.command("bare"), (error) => {
			assert.equal(error.message, "Daemon command 'bare' failed.");
			assert.equal(error.code, undefined);
			return true;
		});
		await assert.rejects(client.command("odd"), /Daemon command 'odd' failed\./, "ok must be exactly true");
		await assert.doesNotReject(client.command("diagnostics"), "the daemon stays usable after command errors");
	});

	test("a malformed reply rejects with the parse error and marks the daemon unavailable", async () => {
		const fake = await fakeOn({ handlers: { look: malformed(), nul: raw("null\n") } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(client.command("look"), SyntaxError);
		await assert.rejects(client.command("nul"), TypeError);
		assert.equal(client.daemonAvailable, false);
	});

	test("times out on a silent or disconnected helper with a transport error", async () => {
		const fake = await fakeOn({ handlers: { hang: silent(), crash: drop(), late: slow(400, ok({})) } });
		const { MacosHelperClient, HelperTransportError } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		for (const cmd of ["hang", "crash", "late"]) {
			await assert.rejects(client.command(cmd, {}, { timeoutMs: 60 }), (error) => {
				assert.ok(error instanceof HelperTransportError, cmd);
				assert.equal(error.name, "HelperTransportError");
				assert.match(error.message, new RegExp(`Daemon command '${cmd}' timed out after 60ms\\.`));
				return true;
			});
			assert.equal(client.daemonAvailable, false, `${cmd} forces a re-probe`);
		}
	});

	test("an abort signal cancels an in-flight command", async () => {
		const fake = await fakeOn({ handlers: { hang: silent() } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		const controller = new AbortController();
		const pending = client.command("hang", {}, { signal: controller.signal, timeoutMs: 5_000 });
		await vi.waitFor(() => assert.ok(fake.requests.some((request) => request.cmd === "hang")));
		controller.abort();
		await assert.rejects(pending, /Operation aborted\./);
	});

	test("a socket connection error is a transport error, and a non-Error rejection is wrapped", async () => {
		const fake = await fakeOn();
		const { MacosHelperClient, HelperTransportError } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await fake.stop();
		await assert.rejects(client.daemonCommand("diagnostics", {}, 500), HelperTransportError);
		vi.spyOn(client, "ensureDaemon").mockResolvedValue(true);
		vi.spyOn(client, "daemonCommand").mockRejectedValue("boom");
		await assert.rejects(client.command("x"), (error) => error instanceof Error && error.message === "boom");
	});
});

describe("daemon availability", () => {
	test("ensureDaemon is a no-op once the daemon answered, and retries until a late daemon appears", async () => {
		const fake = await fakeOn();
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		assert.equal(await client.ensureDaemon(), true);
		const probes = fake.requests.length;
		assert.equal(await client.ensureDaemon(), true);
		assert.equal(fake.requests.length, probes);

		await fake.stop();
		const late = new MacosHelperClient();
		setTimeout(() => void fake.start(), 250);
		assert.equal(await late.ensureDaemon(), true);
	});

	test("ensureDaemon gives up after 30 probes, command() reports the unavailable daemon, abort interrupts the wait", async () => {
		const fake = await fakeOn();
		await fake.stop();
		const { MacosHelperClient, HelperTransportError, HELPER_APP_PATH } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(client.command("look"), (error) => {
			assert.ok(error instanceof HelperTransportError);
			assert.equal(error.message, `pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`);
			return true;
		});
		const controller = new AbortController();
		const waiting = client.ensureDaemon(controller.signal);
		setTimeout(() => controller.abort(), 150);
		await assert.rejects(waiting, /aborted/);
		await assert.rejects(client.ensureDaemon(AbortSignal.abort()), /aborted/);
	}, SLOW_MS);

	test("restart shuts the daemon down, waits and reconnects; failure to come back throws", async () => {
		const fake = await fakeOn();
		const { MacosHelperClient, HELPER_APP_PATH } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await client.restart();
		assert.deepEqual(
			fake.requests.map((request) => request.cmd),
			["diagnostics", "shutdown", "diagnostics"],
		);
		assert.equal(fake.requests[1].raw.id.startsWith("req_"), true);

		fake.script("shutdown", effect(() => fake.stop(), ok()));
		await assert.rejects(client.restart(), (error) => {
			assert.equal(error.message, `pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`);
			return true;
		});
	}, SLOW_MS);

	test("an external socket is never installed or launched", async () => {
		const fake = await fakeOn();
		const spawn = createFakeSpawn({});
		const { MacosHelperClient, HelperTransportError, HELPER_SOCKET_PATH } = await load({ external: true, fake, spawn });
		const client = new MacosHelperClient();
		await client.ensureInstalled();
		await assert.rejects(client.launchDaemon(), (error) => {
			assert.ok(error instanceof HelperTransportError);
			assert.equal(error.message, `External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`);
			return true;
		});
		assert.equal(spawn.calls.length, 0);
	});
});

describe("diagnostics", () => {
	test("normalises the helper's diagnostics and caches them", async () => {
		const fake = await fakeOn({
			diagnostics: {
				protocolVersion: 7.9,
				architectureVersion: "3",
				invariants: ["a", 1, "b"],
				pid: 42.5,
				parentPid: 9,
				parentAppName: "Ghostty",
				parentBundleId: "com.mitchellh.ghostty",
				parentPath: "/Applications/Ghostty.app",
				executablePath: "/x/bridge",
				macOS: "15.1",
				arch: "arm64",
				accessibility: true,
				screenRecording: false,
			},
		});
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		assert.equal(client.diagnostics, undefined);
		const diagnostics = await client.diagnosticsCommand();
		assert.deepEqual(diagnostics, {
			protocolVersion: 7,
			architectureVersion: 3,
			invariants: ["a", "b"],
			pid: 42,
			parentPid: 9,
			parentAppName: "Ghostty",
			parentBundleId: "com.mitchellh.ghostty",
			parentPath: "/Applications/Ghostty.app",
			executablePath: "/x/bridge",
			os: "15.1",
			arch: "arm64",
			accessibility: true,
			screenRecording: false,
		});
		assert.equal(client.diagnostics, diagnostics);
	});

	test("tolerates an empty result with zero and false defaults", async () => {
		const fake = await fakeOn({ handlers: { diagnostics: { kind: "reply", body: { ok: true } } } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const diagnostics = await new MacosHelperClient().diagnosticsCommand();
		assert.equal(diagnostics.protocolVersion, 0);
		assert.deepEqual(diagnostics.invariants, []);
		assert.equal(diagnostics.parentPid, undefined);
		assert.equal(diagnostics.accessibility, false);
	});
});

describe("ensureProtocol", () => {
	const psFor = (etime) => ({ ps: { stdout: `${etime}\n`, exitCode: 0 } });

	async function protocolRig({ diagnostics = {}, etime = "00:00", ps, afterRestart, install = true } = {}) {
		if (install) installExecutable();
		const fake = await fakeOn({ diagnostics: { executablePath: executable, ...diagnostics } });
		const spawn = createFakeSpawn(ps ?? psFor(etime));
		const mod = await load({ external: true, fake, spawn });
		if (afterRestart) fake.script("shutdown", effect(() => Object.assign(fake.diagnostics, afterRestart), ok({})));
		return { fake, spawn, ...mod, client: new mod.MacosHelperClient() };
	}

	test("accepts a current daemon without restarting", async () => {
		const { client, fake, spawn } = await protocolRig({ diagnostics: { pid: 77 } });
		assert.equal((await client.ensureProtocol()).protocolVersion, 7);
		assert.equal(fake.requests.some((request) => request.cmd === "shutdown"), false);
		assert.deepEqual(spawn.calls[0].args, ["-o", "etime=", "-p", "77"]);
	});

	test("accepts a daemon with no reported executable path", async () => {
		const { client } = await protocolRig({ diagnostics: { executablePath: undefined } });
		await assert.doesNotReject(client.ensureProtocol());
	});

	test("accepts a daemon whose executable is a symlink to the installed one", async () => {
		installExecutable();
		const link = path.join(tmp, "link-bridge");
		symlinkSync(executable, link);
		const { client } = await protocolRig({ diagnostics: { executablePath: link } });
		await assert.doesNotReject(client.ensureProtocol());
	});

	test("restarts a stale-protocol daemon and accepts the relaunched one", async () => {
		const { client, fake } = await protocolRig({ diagnostics: { protocolVersion: 6 }, afterRestart: { protocolVersion: 7 } });
		assert.equal((await client.ensureProtocol()).protocolVersion, 7);
		assert.equal(fake.requests.filter((request) => request.cmd === "shutdown").length, 1);
	}, SLOW_MS);

	test("restarts a daemon launched from another executable (unresolvable paths compare resolved)", async () => {
		const { client, fake } = await protocolRig({
			install: false,
			diagnostics: { executablePath: path.join(tmp, "elsewhere", "bridge") },
			afterRestart: { executablePath: executable },
		});
		await client.ensureProtocol();
		assert.equal(fake.requests.filter((request) => request.cmd === "shutdown").length, 1);
	}, SLOW_MS);

	test("restarts when the daemon process predates the installed binary", async () => {
		const { client, fake } = await protocolRig({ etime: "00:01" });
		// 100 s before the binary's ctime: started + 1 s < ctime.
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now - 100_000);
		await client.ensureProtocol();
		assert.equal(fake.requests.filter((request) => request.cmd === "shutdown").length, 1);
	}, SLOW_MS);

	test("throws and drops the daemon when the relaunched helper still mismatches", async () => {
		const { client, HELPER_APP_EXECUTABLE_PATH, HELPER_APP_PATH } = await protocolRig({ diagnostics: { protocolVersion: 5, executablePath: undefined } });
		await assert.rejects(client.ensureProtocol(), (error) => {
			assert.equal(
				error.message,
				`pi-computer-use helper mismatch after relaunch: expected protocol 7 and executable ${HELPER_APP_EXECUTABLE_PATH}; got protocol 5 and executable unknown. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`,
			);
			return true;
		});
		assert.equal(client.daemonAvailable, false);
	}, SLOW_MS);

	test("throws when the relaunched helper reports the wrong executable", async () => {
		const { client } = await protocolRig({
			diagnostics: { protocolVersion: 5 },
			afterRestart: { protocolVersion: 7, executablePath: path.join(tmp, "other") },
		});
		await assert.rejects(client.ensureProtocol(), /got protocol 7 and executable .*other/);
	}, SLOW_MS);

	test.each([
		["no pid", { pid: 0 }, undefined],
		["negative pid", { pid: -3 }, undefined],
		["non-numeric elapsed time", { pid: 5 }, "garbage"],
	])("does not call a daemon stale for %s", async (_name, diagnostics, etime) => {
		const { client, fake } = await protocolRig({ diagnostics, etime: etime ?? "00:00" });
		await client.ensureProtocol();
		assert.equal(fake.requests.some((request) => request.cmd === "shutdown"), false);
	});

	test.each([
		["ps fails to spawn", { ps: { spawnError: new Error("ENOENT") } }],
		["the helper binary is missing", { install: false, diagnostics: { executablePath: undefined } }],
	])("does not call a daemon stale when %s", async (_name, options) => {
		const { client, fake } = await protocolRig(options);
		await client.ensureProtocol();
		assert.equal(fake.requests.some((request) => request.cmd === "shutdown"), false);
	});

	test("reads day-prefixed elapsed times: a daemon running for days predates the binary", async () => {
		const { client, fake, spawn } = await protocolRig({ etime: "2-00:00:01" });
		await client.ensureProtocol();
		assert.equal(spawn.calls.length >= 1, true);
		assert.equal(fake.requests.filter((request) => request.cmd === "shutdown").length, 1);
	}, SLOW_MS);

	test("helperPredatesBinary allows a 1 s grace and rejects non-finite times", async () => {
		const { helperPredatesBinary } = await load({ external: true, fake: await fakeOn() });
		assert.equal(helperPredatesBinary(0, 1_001), true);
		assert.equal(helperPredatesBinary(0, 1_000), false);
		assert.equal(helperPredatesBinary(Number.NaN, 5_000), false);
		assert.equal(helperPredatesBinary(0, Number.POSITIVE_INFINITY), false);
	});
});

describe("install, launch and runProcess", () => {
	test("skips setup when the helper is already installed", async () => {
		installExecutable();
		const fake = await fakeOn();
		const spawn = createFakeSpawn({});
		const { MacosHelperClient } = await load({ external: false, fake, spawn });
		await new MacosHelperClient().ensureInstalled();
		assert.equal(spawn.calls.length, 0);
	});

	test("runs the setup script in runtime mode when missing, then verifies the install", async () => {
		const fake = await fakeOn();
		const spawn = createFakeSpawn({
			[path.basename(process.execPath)]: () => {
				installExecutable();
				return { exitCode: 0 };
			},
		});
		const { MacosHelperClient } = await load({ external: false, fake, spawn });
		await new MacosHelperClient().ensureInstalled();
		const [call] = spawn.calls;
		assert.equal(call.command, process.execPath);
		assert.deepEqual(call.args.slice(1), ["--runtime"]);
		assert.match(call.args[0], /scripts[\\/]setup-helper\.mjs$/);
		assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(call.options.env.BUN_BE_BUN, "1");
	});

	test("fails when setup succeeds but installs nothing, or exits non-zero", async () => {
		const fake = await fakeOn();
		let route = { exitCode: 0 };
		const spawn = createFakeSpawn({ [path.basename(process.execPath)]: () => route });
		const { MacosHelperClient, HELPER_APP_PATH } = await load({ external: false, fake, spawn });
		const client = new MacosHelperClient();
		await assert.rejects(client.ensureInstalled(), new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`));
		route = { exitCode: 2, stderr: "swiftc missing\n", stdout: "partial\n" };
		await assert.rejects(client.ensureInstalled(), /Command failed \(2\): .*setup-helper\.mjs --runtime\nswiftc missing\npartial$/);
	});

	test("launchDaemon opens the app bundle on the daemon socket and ensureDaemon then connects", async () => {
		installExecutable();
		const fake = await fakeOn();
		await fake.stop();
		const spawn = createFakeSpawn({
			open: () => {
				void fake.start();
				return { exitCode: 0 };
			},
		});
		const { MacosHelperClient, HELPER_APP_PATH, HELPER_SOCKET_PATH } = await load({ external: false, fake, spawn });
		assert.equal(await new MacosHelperClient().ensureDaemon(), true);
		const open = spawn.calls.find((call) => call.command === "open");
		assert.deepEqual(open.args, ["-n", "-g", HELPER_APP_PATH, "--args", "serve", "--socket", HELPER_SOCKET_PATH]);
	});

	test("a failing launch is tolerated and the unavailable daemon is reported", async () => {
		const fake = await fakeOn();
		await fake.stop();
		const spawn = createFakeSpawn({ open: { spawnError: new Error("open: not found") } });
		const { MacosHelperClient } = await load({ external: false, fake, spawn });
		assert.equal(await new MacosHelperClient().ensureDaemon(), false);
		assert.equal(spawn.calls.filter((call) => call.command === "open").length, 1);
	}, SLOW_MS);

	describe("runProcess", () => {
		async function runner(routes) {
			const spawn = createFakeSpawn({ tool: routes });
			const { runProcess } = await load({ external: true, fake: await fakeOn(), spawn });
			return { runProcess, spawn };
		}

		test("resolves on exit 0 and forwards env", async () => {
			const { runProcess, spawn } = await runner({ exitCode: 0, stdout: "fine" });
			await runProcess("tool", ["a"], 1_000, undefined, { X: "1" });
			assert.deepEqual(spawn.calls[0].options.env, { X: "1" });
		});

		test("rejects with trimmed output on a non-zero exit, and without output when silent", async () => {
			const noisy = await runner({ exitCode: 3, stderr: " bad \n", stdout: " out \n" });
			await assert.rejects(noisy.runProcess("tool", ["a", "b"], 1_000), new Error("Command failed (3): tool a b\nbad\nout"));
			const quiet = await runner({ exitCode: 1 });
			await assert.rejects(quiet.runProcess("tool", [], 1_000), new Error("Command failed (1): tool"));
		});

		test("kills and rejects on timeout", async () => {
			let child;
			const { runProcess } = await runner(() => (child = createFakeChild({ hang: true })));
			await assert.rejects(runProcess("tool", ["x"], 20), new Error("Command timed out after 20ms: tool x"));
			assert.deepEqual(child.signals, ["SIGTERM"]);
		});

		test("kills and rejects on abort, and refuses an already aborted signal", async () => {
			let child;
			const { runProcess, spawn } = await runner(() => (child = createFakeChild({ hang: true })));
			const controller = new AbortController();
			const running = runProcess("tool", [], 5_000, controller.signal);
			controller.abort();
			await assert.rejects(running, /Operation aborted\./);
			assert.deepEqual(child.signals, ["SIGTERM"]);
			await assert.rejects(runProcess("tool", [], 5_000, AbortSignal.abort()), /Operation aborted\./);
			assert.equal(spawn.calls.length, 1);
		});

		test("rejects with the spawn error", async () => {
			const { runProcess } = await runner({ spawnError: new Error("spawn tool ENOENT") });
			await assert.rejects(runProcess("tool", [], 1_000), /spawn tool ENOENT/);
		});
	});
});

describe("activity glow connection", () => {
	async function glowRig(options = {}) {
		const fake = await fakeOn(options);
		const mod = await load({ external: true, fake });
		cleanups.push(() => mod.macosActivityGlow.close());
		return { fake, ...mod };
	}

	test("serialises setActive calls over one persistent connection", async () => {
		const { fake, macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: ok({}) } });
		await Promise.all([macosActivityGlow.setActive(true), macosActivityGlow.setActive(false), macosActivityGlow.setActive(true)]);
		const glow = fake.requests.filter((request) => request.cmd === "setActivityGlow");
		assert.deepEqual(glow.map((request) => request.args.active), [true, false, true]);
		assert.deepEqual(glow.map((request) => request.id), ["activity_1", "activity_2", "activity_3"]);
		// one probe connection from ensureDaemon, one persistent glow connection
		assert.equal(fake.connections, 2);
	});

	test("joins a reply split across frames", async () => {
		const { macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: split(ok({}), 4) } });
		await assert.doesNotReject(macosActivityGlow.setActive(true));
	});

	test("an error reply or a mismatched id rejects with HelperCommandError", async () => {
		const { macosActivityGlow, HelperCommandError } = await glowRig({
			handlers: { setActivityGlow: [fail("no overlay", "overlay_unavailable"), raw('{"id":"other","ok":true}\n'), { kind: "reply", body: { ok: false } }] },
		});
		await assert.rejects(macosActivityGlow.setActive(true), (error) => {
			assert.ok(error instanceof HelperCommandError);
			assert.equal(error.code, "overlay_unavailable");
			assert.equal(error.message, "no overlay");
			return true;
		});
		await assert.rejects(macosActivityGlow.setActive(true), new HelperCommandError("Activity glow command failed."));
		await assert.rejects(macosActivityGlow.setActive(true), (error) => error.message === "Activity glow command failed." && error.code === undefined);
	});

	test("a malformed reply rejects with the parse error", async () => {
		const { macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: malformed() } });
		await assert.rejects(macosActivityGlow.setActive(true), SyntaxError);
	});

	test("times out on a silent helper and reconnects afterwards", async () => {
		const { fake, macosActivityGlow, HelperTransportError } = await glowRig({ handlers: { setActivityGlow: [silent(), ok({})] } });
		await assert.rejects(macosActivityGlow.setActive(true), new HelperTransportError("Activity glow command timed out."));
		await macosActivityGlow.setActive(true);
		assert.equal(fake.connections, 3, "the timed-out socket was destroyed and replaced");
	}, SLOW_MS);

	test("a disconnect mid-request rejects, then the next call reconnects", async () => {
		const { fake, macosActivityGlow, HelperTransportError } = await glowRig({ handlers: { setActivityGlow: [drop(), ok({})] } });
		await assert.rejects(macosActivityGlow.setActive(true), new HelperTransportError("Activity glow connection closed."));
		await macosActivityGlow.setActive(true);
		assert.equal(fake.connections, 3);
	});

	test("a connect failure is a transport error and an unavailable daemon is reported", async () => {
		const { fake, macosActivityGlow, macosHelper, HelperTransportError, HELPER_APP_PATH } = await glowRig();
		await macosHelper.ensureDaemon();
		await fake.stop();
		await assert.rejects(macosActivityGlow.setActive(true), HelperTransportError);
		vi.spyOn(macosHelper, "ensureDaemon").mockResolvedValue(false);
		await assert.rejects(macosActivityGlow.setActive(true), new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`));
	});

	test("a socket error after connect destroys the socket, and concurrent connects share one attempt", async () => {
		const { fake, macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: ok({}) } });
		await macosActivityGlow.setActive(true);
		const socket = macosActivityGlow.socket;
		socket.emit("error", new Error("EPIPE"));
		assert.equal(socket.destroyed, true);
		await vi.waitFor(() => assert.equal(macosActivityGlow.socket, undefined));
		const before = fake.connections;
		const [a, b] = await Promise.all([macosActivityGlow.ensureConnection(), macosActivityGlow.ensureConnection()]);
		assert.equal(a, b);
		assert.equal(fake.connections, before + 1);
	});

	test("close() ends a writable socket, destroys a non-writable one, and is idempotent", async () => {
		const { macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: ok({}) } });
		await macosActivityGlow.close();
		await macosActivityGlow.setActive(true);
		const writable = macosActivityGlow.socket;
		assert.equal(writable.writable, true);
		const end = vi.spyOn(writable, "end");
		await macosActivityGlow.close();
		assert.equal(end.mock.calls.length, 1);
		assert.equal(macosActivityGlow.socket, undefined);

		await macosActivityGlow.setActive(true);
		const ended = macosActivityGlow.socket;
		ended.end();
		assert.equal(ended.writable, false);
		const destroy = vi.spyOn(ended, "destroy");
		await macosActivityGlow.close();
		assert.equal(destroy.mock.calls.length, 1);
	});
});

describe("helper app path resolution", () => {
	test("defaults every probe to the host (env, home, system install, existsSync)", () => {
		const resolved = resolveMacosHelperAppPath({ env: {} });
		assert.ok([path.join("/Applications", "pi-computer-use.app"), path.join(os.homedir(), "Applications", "pi-computer-use.app")].includes(resolved));
		vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", "  ");
		assert.equal(path.basename(resolveMacosHelperAppPath()), "pi-computer-use.app");
	});

	test("uses the real filesystem for the system install when no probes are injected", () => {
		const homeDir = path.join(tmp, "home");
		const writableDir = path.join(tmp, "Applications");
		mkdirSync(writableDir);
		const system = path.join(writableDir, "pi-computer-use.app");
		assert.equal(resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath: system, fileExists: () => true }), system);
		const missingParent = path.join(tmp, "nope", "pi-computer-use.app");
		assert.equal(
			resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath: missingParent, fileExists: () => true }),
			path.join(homeDir, "Applications", "pi-computer-use.app"),
		);
	});
});
