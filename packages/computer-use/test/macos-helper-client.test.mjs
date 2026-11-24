// Drives `MacosHelperClient` and the activity-glow connection against `support/fake-helper.mjs`: real
// unix socket and NDJSON framing, faked `spawn` (ps, open, setup script). No Swift helper runs.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { macosHelperBuild } from "../src/platform/macos/helper-build.mjs";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";
import {
	createFakeChild,
	createFakeSpawn,
	drop,
	effect,
	fail,
	malformed,
	ok,
	raw,
	shortSocketPath,
	silent,
	slow,
	split,
	startFakeHelper,
} from "./support/fake-helper.mjs";

// Cases that wait out the client's own fixed timers (30 x 100 ms probe loop, 400 ms restart pause, 2 s glow
// timeout). Longest alone: ~5.9 s; budget is ~7x that (#312).
const SLOW_MS = 45_000;
const matchingBuild = macosHelperBuild(fileURLToPath(new URL("../", import.meta.url)));

const cleanups = [];
let tmp;
let appPath;
let executable;

beforeEach(({ onTestFinished }) => {
	tmp = makeTestTempDir("mhc-", onTestFinished);
	appPath = path.join(tmp, "pi-computer-use.app");
	executable = path.join(appPath, "Contents", "MacOS", "bridge");
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:net");
	vi.doUnmock("node:os");
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
	else vi.stubEnv("PI_CU_SOCKET_PATH", undefined);
	if (spawn) {
		vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	}
	// Always: the default socket path must never be the host's real one, even for an external override.
	vi.doMock("node:os", async (original) => {
		const actual = await original();
		const patched = { ...actual, homedir: () => tmp };
		return { ...patched, default: patched };
	});
	if (!external) {
		vi.doMock("node:net", async (original) => {
			const actual = await original();
			const patched = {
				...actual,
				createConnection: (_target, ...rest) => actual.createConnection(fake.socketPath, ...rest),
			};
			return { ...patched, default: patched };
		});
	}
	return await import("../src/platform/macos/helper.ts");
}

async function fakeOn({ protocol = 8, ...options } = {}) {
	const socketPath = shortSocketPath();
	const fake = await startFakeHelper({
		socketPath,
		protocolVersion: protocol,
		...options,
		diagnostics: { buildIdentity: matchingBuild, ...options.diagnostics },
	});
	cleanups.push(async () => {
		await fake.stop();
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

	test("keyboard stops carry the posted prefix without retry", async () => {
		const fake = await fakeOn({
			handlers: {
				desktopInput: {
					kind: "reply",
					body: { ok: false, error: { code: "app_blocked", evidence: { postedUnits: 1 } } },
				},
			},
		});
		const { MacosHelperClient } = await load({ external: true, fake });
		await assert.rejects(new MacosHelperClient().command("desktopInput", { action: "key" }, { timeoutMs: 30_000 }), {
			code: "app_blocked",
			evidence: { postedUnits: 1 },
		});
		// Sent once, never retried; the deadline's value is `tests/keyboard-deadline-clock.test.ts`'s job.
		assert.equal(fake.requests.filter(({ cmd }) => cmd === "desktopInput").length, 1);
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

	test("a malformed or non-object reply is a transport error and marks the daemon unavailable", async () => {
		const fake = await fakeOn({ handlers: { look: malformed(), nul: raw("null\n") } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		const malformedReply = { name: "HelperTransportError", code: "helper_malformed" };
		await assert.rejects(client.command("look"), malformedReply);
		await assert.rejects(client.command("nul"), malformedReply);
		assert.equal(client.daemonAvailable, false);
	});

	test("times out on a silent or slow helper with a transport error", async () => {
		const fake = await fakeOn({ handlers: { hang: silent(), late: slow(400, ok({})) } });
		const { MacosHelperClient, HelperTransportError } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		for (const cmd of ["hang", "late"]) {
			await assert.rejects(client.command(cmd, {}, { timeoutMs: 60 }), (error) => {
				assert.ok(error instanceof HelperTransportError, cmd);
				assert.equal(error.name, "HelperTransportError");
				assert.match(error.message, new RegExp(`Daemon command '${cmd}' timed out after 60ms\\.`));
				return true;
			});
			assert.equal(client.daemonAvailable, false, `${cmd} forces a re-probe`);
		}
	});

	// #725: a helper that drops the socket before replying fails at once with a coded transport error,
	// not at the command timeout. Timing is asserted as "well before the timeout" (no exact bound).
	test("a helper that disconnects mid-command rejects at once with helper_disconnected (#725)", async () => {
		const fake = await fakeOn({ handlers: { crash: drop() } });
		const { MacosHelperClient, HelperTransportError } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		const timeoutMs = 30_000;
		const started = Date.now();
		await assert.rejects(client.command("crash", {}, { timeoutMs }), (error) => {
			assert.ok(error instanceof HelperTransportError);
			assert.equal(error.code, "helper_disconnected");
			assert.match(error.message, /disconnected before replying to 'crash'/);
			assert.doesNotMatch(error.message, /timed out/);
			return true;
		});
		assert.ok(Date.now() - started < timeoutMs / 2, "the disconnect must not wait out the command timeout");
		assert.equal(client.daemonAvailable, false);
	});

	test("a partial reply cut off by a disconnect is a disconnect, and the next command still works", async () => {
		const fake = await fakeOn();
		fake.script(
			"half",
			effect(() => setTimeout(() => fake.disconnectAll(), 20), raw('{"id":"req_2","ok":tr')),
		);
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(
			client.command("half", {}, { timeoutMs: 30_000 }),
			(error) => error.code === "helper_disconnected",
		);
		assert.equal(client.daemonAvailable, false);
		assert.equal((await client.command("diagnostics")).protocolVersion, 8);
	});

	test("a reply that is followed at once by a disconnect resolves, not helper_disconnected (#725)", async () => {
		const fake = await fakeOn();
		fake.script(
			"last",
			effect(() => setTimeout(() => fake.disconnectAll(), 0), ok({ done: true })),
		);
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		assert.deepEqual(await client.command("last", {}, { timeoutMs: 30_000 }), { done: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(client.daemonAvailable, true, "the close after a settled reply is ignored");
	});

	test("a disconnect releases the abort listener, so a later abort cannot settle the command again (#725)", async () => {
		const fake = await fakeOn({ handlers: { crash: drop() } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		const controller = new AbortController();
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		await assert.rejects(
			client.command("crash", {}, { signal: controller.signal, timeoutMs: 30_000 }),
			(error) => error.code === "helper_disconnected",
		);
		assert.ok(
			removed.mock.calls.some(([type]) => type === "abort"),
			"the abort listener is removed on disconnect",
		);
		controller.abort();
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

	test("an already aborted signal rejects at once and no request reaches the helper (#735)", async () => {
		const fake = await fakeOn({ handlers: { look: ok(1) } });
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(client.command("look", {}, { signal: AbortSignal.abort() }), /Operation aborted\./);
		await assert.rejects(client.daemonCommand("look", {}, 5_000, AbortSignal.abort()), /Operation aborted\./);
		assert.equal(fake.requests.length, 0);
		assert.equal(await client.command("look"), 1, "the client still works afterwards");
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

	test(
		"ensureDaemon gives up after 30 probes, command() reports the unavailable daemon, abort interrupts the wait",
		async () => {
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
		},
		SLOW_MS,
	);

	test(
		"restart shuts the daemon down, waits and reconnects; failure to come back throws",
		async () => {
			const fake = await fakeOn();
			const { MacosHelperClient, HELPER_APP_PATH } = await load({ external: false, fake, spawn: createFakeSpawn({}) });
			const client = new MacosHelperClient();
			fake.relaunchAfterExit();
			await client.restart();
			assert.deepEqual(
				fake.requests.map((request) => request.cmd),
				["diagnostics", "diagnostics", "shutdown", "diagnostics"],
			);
			assert.equal(fake.requests[2].raw.id.startsWith("req_"), true);

			// The default shutdown exits the fake; with no relaunch it stays down.
			fake.relaunchAfterExit(false);
			await assert.rejects(client.restart(), (error) => {
				assert.equal(
					error.message,
					`pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`,
				);
				return true;
			});
		},
		SLOW_MS,
	);

	test(
		"restart ignores a failing shutdown and reconnects to the surviving daemon",
		async () => {
			const fake = await fakeOn({ handlers: { shutdown: fail("cannot stop", "internal_error") } });
			const { MacosHelperClient } = await load({ external: false, fake });
			await new MacosHelperClient().restart();
			assert.deepEqual(
				fake.requests.map((request) => request.cmd),
				["diagnostics", "diagnostics", "shutdown", "diagnostics"],
			);
		},
		SLOW_MS,
	);

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
				protocolVersion: 8.9,
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
			protocolVersion: 8,
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

	test("tolerates a sparse result with zero and false defaults, but an external helper needs its protocol", async () => {
		const fake = await fakeOn({
			handlers: { diagnostics: [{ kind: "reply", body: { ok: true } }, ok({ protocolVersion: 8 })] },
		});
		const { MacosHelperClient } = await load({ external: true, fake });
		const client = new MacosHelperClient();
		await assert.rejects(client.diagnosticsCommand(), { code: "helper_protocol", message: /reports protocol 0;/ });
		const diagnostics = await client.diagnosticsCommand();
		assert.equal(diagnostics.architectureVersion, 0);
		assert.deepEqual(diagnostics.invariants, []);
		assert.equal(diagnostics.parentPid, undefined);
		assert.equal(diagnostics.accessibility, false);
	});
});

test.each([8, 6])("external daemon from another executable with protocol %s is never restarted", async (protocol) => {
	const fake = await fakeOn({ protocol, diagnostics: { executablePath: path.join(tmp, "other", "bridge") } });
	const spawn = createFakeSpawn({});
	const { MacosHelperClient } = await load({ external: true, fake, spawn });
	const client = new MacosHelperClient();
	if (protocol === 8) assert.equal((await client.ensureProtocol()).protocolVersion, 8);
	else await assert.rejects(client.ensureProtocol(), /reports protocol 6; expected 8.*operator/);
	await assert.rejects(client.restart(), /restarted by its operator/);
	assert.deepEqual(
		fake.requests.map(({ cmd }) => cmd),
		protocol === 8 ? ["diagnostics", "diagnostics"] : ["diagnostics"],
	);
	assert.deepEqual(spawn.calls, []);
});

describe("ensureProtocol", () => {
	async function protocolRig({ diagnostics = {}, install = true } = {}) {
		if (install) installExecutable();
		const fake = await fakeOn({ diagnostics: { executablePath: executable, ...diagnostics } });
		const spawn = createFakeSpawn({});
		const mod = await load({ external: false, fake, spawn });
		return { fake, spawn, ...mod, client: new mod.MacosHelperClient() };
	}

	/**
	 * A matching-build daemon that is not the installed helper is refused with `helper_mismatch`: never shut down,
	 * relaunched or stopped, and the client drops its cached availability so the next command probes again.
	 */
	async function assertRefused(rig, reason) {
		// `reason` is literal text: paths can hold regex metacharacters.
		const { client, fake, spawn, HelperCommandError, HELPER_SOCKET_PATH, RESIDENT_MISMATCH_REPAIR } = rig;
		await client.ensureDaemon();
		await assert.rejects(client.ensureProtocol(), (error) => {
			assert.ok(error instanceof HelperCommandError);
			assert.equal(error.code, "helper_mismatch");
			assert.ok(error.message.includes(reason), error.message);
			assert.equal(
				error.message.startsWith(`pi-computer-use helper at ${HELPER_SOCKET_PATH} has this package's build but `),
				true,
			);
			assert.equal(error.message.endsWith(`; it was not restarted or stopped. ${RESIDENT_MISMATCH_REPAIR}`), true);
			return true;
		});
		assert.equal(client.daemonAvailable, false);
		assert.deepEqual(
			fake.requests.map(({ cmd }) => cmd),
			["diagnostics", "diagnostics"],
			"only read-only probes: no shutdown",
		);
		assert.equal(
			spawn.calls.some(({ command }) => command === "open"),
			false,
			"nothing is relaunched",
		);
	}

	test("accepts a current daemon without restarting or reading its start time", async () => {
		const { client, fake, spawn } = await protocolRig({ diagnostics: { pid: 77 } });
		assert.equal((await client.ensureProtocol()).protocolVersion, 8);
		assert.equal(
			fake.requests.some((request) => request.cmd === "shutdown"),
			false,
		);
		assert.deepEqual(spawn.calls, [], "no `ps`: start time is not compared");
	});

	test("accepts a daemon whose executable is a symlink to the installed one", async () => {
		installExecutable();
		const link = path.join(tmp, "link-bridge");
		symlinkSync(executable, link);
		const { client } = await protocolRig({ diagnostics: { executablePath: link } });
		await assert.doesNotReject(client.ensureProtocol());
	});

	test("refuses a matching-build daemon that reports another protocol", async () => {
		await assertRefused(await protocolRig({ diagnostics: { protocolVersion: 6 } }), " reports protocol 6 (expected 8)");
	});

	test("refuses a daemon that reports no executable path", async () => {
		const rig = await protocolRig({ diagnostics: { executablePath: undefined } });
		await assertRefused(rig, `reports no executable path (expected ${rig.HELPER_APP_EXECUTABLE_PATH})`);
	});

	test("refuses a daemon launched from another executable (unresolvable paths compare resolved)", async () => {
		const elsewhere = path.join(tmp, "elsewhere", "bridge");
		const rig = await protocolRig({ install: false, diagnostics: { executablePath: elsewhere } });
		await assertRefused(rig, `runs ${elsewhere} (expected ${rig.HELPER_APP_EXECUTABLE_PATH})`);
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
		await fake.stop();
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
		await fake.stop();
		let route = { exitCode: 0 };
		const spawn = createFakeSpawn({ [path.basename(process.execPath)]: () => route });
		const { MacosHelperClient, HELPER_APP_PATH } = await load({ external: false, fake, spawn });
		const client = new MacosHelperClient();
		await assert.rejects(
			client.ensureInstalled(),
			new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`),
		);
		route = { exitCode: 2, stderr: "swiftc missing\n", stdout: "partial\n" };
		await assert.rejects(
			client.ensureInstalled(),
			/Command failed \(2\): .*setup-helper\.mjs --runtime\nswiftc missing\npartial$/,
		);
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

	test(
		"a failing launch is tolerated and the unavailable daemon is reported",
		async () => {
			const fake = await fakeOn();
			await fake.stop();
			const spawn = createFakeSpawn({ open: { spawnError: new Error("open: not found") } });
			const { MacosHelperClient } = await load({ external: false, fake, spawn });
			assert.equal(await new MacosHelperClient().ensureDaemon(), false);
			assert.equal(spawn.calls.filter((call) => call.command === "open").length, 1);
		},
		SLOW_MS,
	);

	// #1235: `open -n` starts a new instance on every call, so concurrent callers must share one launch.
	describe("concurrent ensureDaemon callers", () => {
		/**
		 * A stopped fake; `open` runs each route in turn. Past the routes, the first `open` brings the fake up after
		 * `delayMs` and later ones are only counted: one startup per rig, settled before the fake stops.
		 */
		async function launchRig(routes = [], delayMs = 150) {
			const fake = await fakeOn();
			await fake.stop();
			let timer;
			let startup;
			const spawn = createFakeSpawn({
				open: () => {
					const route = routes.shift();
					if (route) return route;
					timer ??= setTimeout(() => {
						startup = fake.start();
						// Surfaced by the cleanup's await; handled here so a failure is not unhandled meanwhile.
						startup.catch(() => undefined);
					}, delayMs);
					return { exitCode: 0 };
				},
			});
			cleanups.push(async () => {
				clearTimeout(timer);
				await startup;
			});
			const { MacosHelperClient } = await load({ external: false, fake, spawn });
			const opens = () => spawn.calls.filter(({ command }) => command === "open").length;
			return { client: new MacosHelperClient(), opens, spawn };
		}

		test("share one launch while the helper cold-starts", async () => {
			const { client, opens } = await launchRig();
			assert.deepEqual(await Promise.all([client.ensureDaemon(), client.ensureDaemon(), client.ensureDaemon()]), [
				true,
				true,
				true,
			]);
			assert.equal(opens(), 1);
		});

		test(
			"a later caller after a failed start launches afresh",
			async () => {
				// The first `open` exits without bringing the helper up, so the probe loop gives up.
				const { client, opens } = await launchRig([{ exitCode: 0 }]);
				assert.equal(await client.ensureDaemon(), false);
				assert.equal(opens(), 1);
				assert.equal(await client.ensureDaemon(), true, "the failed start is not joined");
				assert.equal(opens(), 2);
			},
			SLOW_MS,
		);

		test("poll sleeps remove abort listeners", async () => {
			const { client, opens } = await launchRig([{ exitCode: 0 }]);
			const controller = new AbortController();
			const pending = client.ensureDaemon(controller.signal);
			await vi.waitFor(() => assert.equal(opens(), 1));
			const shared = client.pendingStart.controller.signal;
			let most = 0;
			for (let sample = 0; sample < 15; sample += 1) {
				most = Math.max(most, getEventListeners(shared, "abort").length);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(most <= 1, `at most one listener per probe or sleep, saw ${most}`);
			controller.abort();
			await assert.rejects(pending, /Operation aborted\./);
		});

		test("one caller's abort ends only its own wait", async () => {
			const { client, opens } = await launchRig([], 300);
			const controller = new AbortController();
			const aborted = client.ensureDaemon(controller.signal);
			const other = client.ensureDaemon();
			await vi.waitFor(() => assert.equal(opens(), 1));
			controller.abort();
			await assert.rejects(aborted, /Operation aborted\./);
			assert.equal(await other, true);
			assert.equal(opens(), 1);
		});

		test("a start every caller abandoned is aborted, and later callers share a fresh one", async () => {
			const hung = createFakeChild({ hang: true });
			const { client, opens } = await launchRig([hung], 300);
			const controller = new AbortController();
			const abandoned = client.ensureDaemon(controller.signal);
			await vi.waitFor(() => assert.equal(opens(), 1));
			controller.abort();
			await assert.rejects(abandoned, /Operation aborted\./);
			assert.deepEqual(hung.signals, ["SIGTERM"], "the abandoned launch is killed");
			// Created while the abandoned start is still settling: it must neither join nor be cleared by that start.
			const later = client.ensureDaemon();
			await vi.waitFor(() => assert.equal(opens(), 2));
			const joined = client.ensureDaemon();
			assert.deepEqual(await Promise.all([later, joined]), [true, true], "neither inherits the abort");
			assert.equal(opens(), 2);
		});

		test("a caller arriving in the same turn as the last abort starts afresh", async () => {
			const hung = createFakeChild({ hang: true });
			const { client, opens } = await launchRig([hung]);
			const controllers = [new AbortController(), new AbortController()];
			const waits = controllers.map((controller) => client.ensureDaemon(controller.signal));
			await vi.waitFor(() => assert.equal(opens(), 1));
			// No await between the aborts and the newcomer: the start must already count as abandoned.
			for (const controller of controllers) controller.abort();
			const fresh = client.ensureDaemon();
			assert.deepEqual(hung.signals, ["SIGTERM"], "the abandoned launch is killed");
			for (const wait of waits) await assert.rejects(wait, /Operation aborted\./);
			assert.equal(await fresh, true);
			assert.equal(opens(), 2);
		});
	});

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
			await assert.rejects(
				noisy.runProcess("tool", ["a", "b"], 1_000),
				new Error("Command failed (3): tool a b\nbad\nout"),
			);
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
		await Promise.all([
			macosActivityGlow.setActive(true),
			macosActivityGlow.setActive(false),
			macosActivityGlow.setActive(true),
		]);
		const glow = fake.requests.filter((request) => request.cmd === "setActivityGlow");
		assert.deepEqual(
			glow.map((request) => request.args.active),
			[true, false, true],
		);
		// `activity_1` is the connection's own diagnostics check.
		assert.deepEqual(
			glow.map((request) => request.id),
			["activity_2", "activity_3", "activity_4"],
		);
		// one probe connection from ensureDaemon, one persistent glow connection
		assert.equal(fake.connections, 2);
	});

	test("joins a reply split across frames", async () => {
		const { macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: split(ok({}), 4) } });
		await assert.doesNotReject(macosActivityGlow.setActive(true));
	});

	test("an error reply or a mismatched id rejects with HelperCommandError", async () => {
		const { macosActivityGlow, HelperCommandError } = await glowRig({
			handlers: {
				setActivityGlow: [
					fail("no overlay", "overlay_unavailable"),
					raw('{"id":"other","ok":true}\n'),
					{ kind: "reply", body: { ok: false } },
				],
			},
		});
		await assert.rejects(macosActivityGlow.setActive(true), (error) => {
			assert.ok(error instanceof HelperCommandError);
			assert.equal(error.code, "overlay_unavailable");
			assert.equal(error.message, "no overlay");
			return true;
		});
		await assert.rejects(macosActivityGlow.setActive(true), new HelperCommandError("Activity glow command failed."));
		await assert.rejects(
			macosActivityGlow.setActive(true),
			(error) => error.message === "Activity glow command failed." && error.code === undefined,
		);
	});

	test("a malformed reply is a transport error", async () => {
		const { macosActivityGlow } = await glowRig({ handlers: { setActivityGlow: malformed() } });
		await assert.rejects(macosActivityGlow.setActive(true), { code: "helper_malformed" });
	});

	test(
		"times out on a silent helper and reconnects afterwards",
		async () => {
			const { fake, macosActivityGlow, HelperTransportError } = await glowRig({
				handlers: { setActivityGlow: [silent(), ok({})] },
			});
			await assert.rejects(
				macosActivityGlow.setActive(true),
				new HelperTransportError("Activity glow command timed out."),
			);
			await macosActivityGlow.setActive(true);
			assert.equal(fake.connections, 3, "the timed-out socket was destroyed and replaced");
		},
		SLOW_MS,
	);

	test("a disconnect mid-request rejects, then the next call reconnects", async () => {
		const { fake, macosActivityGlow, HelperTransportError } = await glowRig({
			handlers: { setActivityGlow: [drop(), ok({})] },
		});
		await assert.rejects(
			macosActivityGlow.setActive(true),
			new HelperTransportError("Activity glow connection closed."),
		);
		await macosActivityGlow.setActive(true);
		assert.equal(fake.connections, 3);
	});

	test("a connect failure is a transport error and an unavailable daemon is reported", async () => {
		const { fake, macosActivityGlow, macosHelper, HelperTransportError, HELPER_APP_PATH } = await glowRig();
		await macosHelper.ensureDaemon();
		await fake.stop();
		await assert.rejects(macosActivityGlow.setActive(true), HelperTransportError);
		vi.spyOn(macosHelper, "ensureDaemon").mockResolvedValue(false);
		await assert.rejects(
			macosActivityGlow.setActive(true),
			new HelperTransportError(`pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`),
		);
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
	test("an omitted system path is /Applications/pi-computer-use.app", () => {
		const probed = [];
		const resolved = resolveMacosHelperAppPath({
			env: {},
			homeDir: "/home/u",
			fileExists: (candidate) => {
				probed.push(candidate);
				return false;
			},
		});
		assert.deepEqual(probed, [path.join("/Applications", "pi-computer-use.app")]);
		assert.equal(resolved, path.join("/home/u", "Applications", "pi-computer-use.app"));
	});

	test("an injected writability probe decides the system install", () => {
		const system = "/x/pi-computer-use.app";
		const base = { env: {}, homeDir: "/home/u", systemHelperAppPath: system, fileExists: () => true };
		assert.equal(resolveMacosHelperAppPath({ ...base, directoryIsWritable: (dir) => dir === "/x" }), system);
		assert.equal(
			resolveMacosHelperAppPath({ ...base, directoryIsWritable: () => false }),
			path.join("/home/u", "Applications", "pi-computer-use.app"),
		);
	});

	test("an omitted existence probe checks the real filesystem", () => {
		const home = path.join(tmp, "home");
		const missing = path.join(tmp, "missing", "pi-computer-use.app");
		const present = path.join(tmp, "present", "pi-computer-use.app");
		mkdirSync(present, { recursive: true });
		const base = { env: {}, homeDir: home, directoryIsWritable: () => true };
		assert.equal(
			resolveMacosHelperAppPath({ ...base, systemHelperAppPath: missing }),
			path.join(home, "Applications", "pi-computer-use.app"),
		);
		assert.equal(resolveMacosHelperAppPath({ ...base, systemHelperAppPath: present }), present);
	});

	test("an omitted home directory is os.homedir()", () => {
		assert.equal(
			resolveMacosHelperAppPath({ env: {}, systemHelperAppPath: "/x/pi-computer-use.app", fileExists: () => false }),
			path.join(os.homedir(), "Applications", "pi-computer-use.app"),
		);
	});

	test("an omitted env is process.env, and a blank override is ignored", () => {
		vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", "rel/custom.app");
		assert.equal(resolveMacosHelperAppPath(), path.resolve("rel/custom.app"));
		vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", "  ");
		assert.equal(
			resolveMacosHelperAppPath({
				homeDir: "/home/u",
				systemHelperAppPath: "/x/pi-computer-use.app",
				fileExists: () => false,
			}),
			path.join("/home/u", "Applications", "pi-computer-use.app"),
		);
	});

	test("uses the real filesystem for the system install when no probes are injected", () => {
		const homeDir = path.join(tmp, "home");
		const writableDir = path.join(tmp, "Applications");
		mkdirSync(writableDir);
		const system = path.join(writableDir, "pi-computer-use.app");
		assert.equal(
			resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath: system, fileExists: () => true }),
			system,
		);
		const missingParent = path.join(tmp, "nope", "pi-computer-use.app");
		assert.equal(
			resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath: missingParent, fileExists: () => true }),
			path.join(homeDir, "Applications", "pi-computer-use.app"),
		);
	});
});
