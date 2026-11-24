import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, onTestFinished, test, vi } from "vitest";
import { main } from "../scripts/build-native.mjs";
import { macosHelperBuild, macosHelperSourcePaths, writeMacosBuildStamp } from "../src/platform/macos/helper-build.mjs";
import {
	createFakeChild,
	drop,
	effect,
	ok,
	raw,
	shortSocketPath,
	silent,
	slow,
	startFakeHelper,
} from "../test/support/fake-helper.mjs";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
assert.ok(platformDescriptor);
const current = macosHelperBuild(fileURLToPath(new URL("../", import.meta.url)));
const older = `0.0.0+${"0".repeat(64)}`;
const staleMessage = (executable: string, build = "none") =>
	`pi-computer-use helper at ${executable} is stale (helper build ${build}, expected ${current}): from the package root, run \`node scripts/setup-helper.mjs --runtime\`. For a source checkout, rebuild first with \`npm run build:native\`. See https://github.com/nredd/pi-harness/tree/main/packages/computer-use#repair-a-missing-macos-helper`;

afterEach(() => {
	vi.useRealTimers();
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.doUnmock("node:net");
	vi.doUnmock("node:os");
	vi.doUnmock("node:child_process");
	vi.doUnmock("node:fs/promises");
	vi.resetModules();
});

async function rig(
	buildIdentity: string | undefined,
	{
		external = false,
		installed = true,
		alias = "",
		override: overrideFor = undefined as ((home: string, socketPath: string) => string) | undefined,
		/** An `errno` code inspecting the helper executable fails with, independent of runner credentials. */
		executableError = undefined as string | undefined,
	} = {},
) {
	const home = makeTestTempDir("cu-build-app-", onTestFinished);
	const app = path.join(home, "fixture.app");
	vi.doMock("node:os", async (original) => {
		const real = await original<typeof import("node:os")>();
		return { ...real, default: { ...real.default, homedir: () => home } };
	});
	const executable = path.join(app, "Contents", "MacOS", "bridge");
	let executableId: string | undefined;
	if (installed) {
		mkdirSync(path.dirname(executable), { recursive: true });
		writeFileSync(executable, "not executed\n", { mode: 0o755 });
		const stats = statSync(executable, { bigint: true });
		executableId = `${BigInt.asUintN(64, stats.dev)}:${BigInt.asUintN(64, stats.ino)}`;
	}
	const socketPath = shortSocketPath();
	const fake = await startFakeHelper({
		socketPath,
		// The installed helper as `ensureProtocol` expects it: its protocol, executable path and mapped vnode.
		diagnostics: { protocolVersion: 8, pid: 0, executablePath: executable, executableId, buildIdentity },
		handlers: { listApps: ok([]), setActivityGlow: ok({}) },
	});
	onTestFinished(() => fake.stop());
	let override = external ? socketPath : overrideFor?.(home, socketPath);
	if (alias) {
		const managedDir = path.join(home, "Library", "Caches", "pi-computer-use");
		mkdirSync(managedDir, { recursive: true });
		if (alias === "socket") {
			const managedSocket = path.join(managedDir, "bridge.sock");
			writeFileSync(managedSocket, "stand-in for the socket path");
			override = path.join(home, "socket-link");
			symlinkSync(managedSocket, override);
		} else {
			symlinkSync(managedDir, path.join(home, "alias"));
			override = `${path.relative(process.cwd(), home)}/unused/../alias/BRIDGE.sock/`;
		}
	}
	vi.stubEnv("PI_CU_SOCKET_PATH", override);
	vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", app);
	if (executableError) {
		vi.doMock("node:fs/promises", async (original) => {
			const real = await original<typeof import("node:fs/promises")>();
			const lstat = (async (target: string) => {
				if (target === executable) throw Object.assign(new Error(executableError), { code: executableError });
				return await real.lstat(target);
			}) as typeof real.lstat;
			return { ...real, lstat, default: { ...real, lstat } };
		});
	}
	const connect = {
		/** Runs synchronously when a socket connects, before the client classifies the endpoint. */
		atConnect: undefined as (() => void) | undefined,
		afterConnect: undefined as ((socket: import("node:net").Socket) => void) | undefined,
		/** An `errno` code every connection emits instead of connecting. */
		failWith: undefined as string | undefined,
	};
	vi.doMock("node:net", async (original) => {
		const real = await original<typeof import("node:net")>();
		return {
			...real,
			default: {
				...real,
				createConnection: () => {
					if (connect.failWith) {
						const failing = new real.Socket();
						const code = connect.failWith;
						queueMicrotask(() => failing.destroy(Object.assign(new Error(`connect ${code}`), { code })));
						return failing;
					}
					const socket = real.createConnection(socketPath);
					socket.once("connect", () => {
						connect.atConnect?.();
						queueMicrotask(() => connect.afterConnect?.(socket));
					});
					return socket;
				},
			},
		};
	});
	const spawn = vi.fn(() => {
		throw new Error("Unexpected helper process launch");
	});
	vi.doMock("node:child_process", async (original) => ({ ...(await original<object>()), spawn }));
	const { macosHelper, macosActivityGlow } = await import("../src/platform/macos/helper.ts");
	onTestFinished(() => macosActivityGlow.close());
	return {
		client: macosHelper,
		connect,
		home,
		glow: macosActivityGlow,
		fake,
		spawn,
		executable,
		commands: () => fake.requests.map((r: { cmd: string }) => r.cmd),
	};
}

test.each([older, undefined])(
	"refuses a same-protocol managed helper with build %s without restarting",
	async (build) => {
		const { client, commands, executable, spawn } = await rig(build);
		assert.equal(client.isExternal(), false);
		await client.ensureInstalled();
		const error = {
			code: "stale_helper",
			message: staleMessage(executable, build),
		};
		await assert.rejects(client.ensureProtocol(), error);
		await assert.rejects(client.command("listApps"), error);
		assert.deepEqual(commands(), ["diagnostics", "diagnostics"]);
		assert.equal(spawn.mock.calls.length, 0);
	},
);

test("reports the resident helper's executable rather than the configured app on refusal", async () => {
	const { client, fake, executable, commands } = await rig(older);
	const reportedPath = path.join(path.dirname(executable), "old-bridge");
	Object.assign(fake.diagnostics, { executablePath: reportedPath });
	await assert.rejects(client.ensureProtocol(), {
		code: "stale_helper",
		message: staleMessage(reportedPath, older),
	});
	assert.deepEqual(commands(), ["diagnostics"]);
});

test.each(["directory", "socket"])("a symlinked %s override still refuses a stale managed daemon", async (alias) => {
	const { client, commands, spawn } = await rig(older, { alias });
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	assert.deepEqual(commands(), ["diagnostics"]);
	assert.equal(spawn.mock.calls.length, 0);
});

const managedSocket = (home: string) => path.join(home, "Library", "Caches", "pi-computer-use", "bridge.sock");

test("a default socket pathname that links to the override is managed", async () => {
	const { client, glow, home, fake, commands } = await rig(current, { external: true });
	mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
	symlinkSync(fake.socketPath, managedSocket(home));
	assert.deepEqual(await client.command("listApps"), []);
	fake.diagnostics.buildIdentity = older;
	// The daemon is already marked available, so each connection's own check must refuse.
	await assert.rejects(glow.setActive(true), { code: "stale_helper" });
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	assert.deepEqual(commands().slice(-2), ["diagnostics", "diagnostics"]);
});

test.each([
	["protocol", { protocolVersion: 7 }, "reports protocol 7 (expected 8)"],
	["executable", { executablePath: "/elsewhere/bridge" }, "runs /elsewhere/bridge (expected "],
	["executable identity", { executableId: "0:1" }, "runs executable 0:1 (expected "],
])(
	"rejects %s on managed alias: ensureProtocol follows the connection's classification",
	async (_name, diagnostics, reason) => {
		const { client, home, fake, commands, spawn } = await rig(current, { external: true });
		assert.equal(client.isExternal(), true);
		mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
		symlinkSync(fake.socketPath, managedSocket(home));
		Object.assign(fake.diagnostics, diagnostics);
		await assert.rejects(client.ensureProtocol(), (error: Error & { code?: string }) => {
			assert.equal(error.code, "helper_mismatch");
			assert.ok(error.message.includes(reason), error.message);
			return true;
		});
		assert.ok(
			commands().every((cmd: string) => cmd === "diagnostics"),
			"no shutdown",
		);
		assert.equal(spawn.mock.calls.length, 0);
	},
);

test("an override alias that resolves after import is managed", async () => {
	const { client, home, commands } = await rig(older, {
		override: (home) => path.join(home, "later", "bridge.sock"),
	});
	mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
	symlinkSync(path.dirname(managedSocket(home)), path.join(home, "later"));
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	writeFileSync(managedSocket(home), "stand-in for the socket");
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	assert.ok(commands().every((cmd: string) => cmd === "diagnostics"));
});

test("an override that cannot be inspected fails closed to managed", async () => {
	const { client, commands } = await rig(older, {
		override: (home) => {
			writeFileSync(path.join(home, "file"), "not a directory");
			return path.join(home, "file", "h.sock");
		},
	});
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	assert.deepEqual(commands(), ["diagnostics"]);
});

test.each(["command", "glow"])(
	"alias removed after connect: a connected override that vanishes is managed (%s)",
	async (path_) => {
		const { client, glow, fake, connect, commands } = await rig(older, { external: true });
		assert.deepEqual(await client.command("listApps"), []);
		connect.atConnect = () => rmSync(fake.socketPath);
		await assert.rejects(path_ === "glow" ? glow.setActive(true) : client.command("listApps"), {
			code: "stale_helper",
		});
		assert.deepEqual(commands().slice(-1), ["diagnostics"]);
	},
);

test.each(["command", "glow"])(
	"a managed alias removed at connect keeps the build check: both classifications must agree (%s)",
	async (path_) => {
		const { client, glow, home, fake, connect, commands } = await rig(older, { external: true });
		assert.deepEqual(await client.command("listApps"), []);
		mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
		symlinkSync(fake.socketPath, managedSocket(home));
		connect.atConnect = () => rmSync(managedSocket(home));
		await assert.rejects(path_ === "glow" ? glow.setActive(true) : client.command("listApps"), {
			code: "stale_helper",
		});
		assert.deepEqual(commands().slice(-1), ["diagnostics"]);
	},
);

test.each(["command", "glow"])(
	"an alias retargeted while diagnostics is pending cannot exempt a stale helper (%s)",
	async (path_) => {
		const { client, glow, home, fake, commands } = await rig(older, { external: true });
		assert.deepEqual(await client.command("listApps"), []);
		mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
		symlinkSync(fake.socketPath, managedSocket(home));
		fake.script(
			"diagnostics",
			effect(() => rmSync(managedSocket(home)), ok({ protocolVersion: 8, pid: 0, buildIdentity: older })),
		);
		await assert.rejects(path_ === "glow" ? glow.setActive(true) : client.command("listApps"), {
			code: "stale_helper",
		});
		assert.ok(!commands().includes("setActivityGlow"));
		assert.equal(commands().filter((cmd: string) => cmd === "listApps").length, 1);
	},
);

test("a distinct override stays external while the default socket also exists", async () => {
	const { client, home } = await rig(older, { external: true });
	mkdirSync(path.dirname(managedSocket(home)), { recursive: true });
	writeFileSync(managedSocket(home), "another endpoint");
	assert.deepEqual(await client.command("listApps"), []);
});

test("an incompatible replacement of an external helper receives no effect", async () => {
	const { client, fake, commands, spawn } = await rig(older, { external: true });
	await client.ensureProtocol();
	assert.deepEqual(await client.command("listApps"), []);
	fake.diagnostics.protocolVersion = 6;
	await assert.rejects(client.command("listApps"), {
		code: "helper_protocol",
		message: `External helper at ${fake.socketPath} reports protocol 6; expected 8. Its operator must update and restart it.`,
	});
	assert.deepEqual(commands().slice(-1), ["diagnostics"]);
	assert.equal(commands().filter((cmd: string) => cmd === "listApps").length, 1);
	assert.equal(spawn.mock.calls.length, 0);
});

test("the activity glow checks an external helper's protocol before its first frame", async () => {
	const { client, glow, fake, commands } = await rig(older, { external: true });
	await client.ensureProtocol();
	fake.diagnostics.protocolVersion = 6;
	await assert.rejects(glow.setActive(true), { code: "helper_protocol" });
	assert.ok(!commands().includes("setActivityGlow"));
	fake.diagnostics.protocolVersion = 8;
	await glow.setActive(true);
	assert.deepEqual(commands().slice(-2), ["diagnostics", "setActivityGlow"]);
});

test("refuses a stale resident daemon before setup when the executable is missing", async () => {
	const { client, spawn, commands } = await rig(older, { installed: false });
	await assert.rejects(client.ensureInstalled(), { code: "stale_helper" });
	assert.deepEqual(commands(), ["diagnostics"]);
	assert.equal(spawn.mock.calls.length, 0);
});

test.each([silent(), drop(), raw("{malformed}\n"), raw("null\n"), raw('{"id":"wrong","ok":true}\n')])(
	"refuses setup after a resident accepts the socket but diagnostics returns $kind",
	async (reply) => {
		const { client, fake, spawn, commands } = await rig(current, { installed: false });
		fake.script("diagnostics", reply);
		await assert.rejects(client.ensureInstalled(), { code: "helper_inconclusive", message: /setup was not run/ });
		assert.ok(commands().length >= 1 && commands().every((cmd: string) => cmd === "diagnostics"));
		assert.equal(spawn.mock.calls.length, 0);
	},
	30_000,
);

test.each([silent(), drop(), raw("{malformed}\n"), raw("null\n"), raw('{"id":"wrong","ok":true}\n'), "EACCES"])(
	"never launches after an inconclusive probe: %o",
	async (outcome) => {
		const { client, fake, connect, spawn } = await rig(current);
		if (typeof outcome === "string") connect.failWith = outcome;
		else fake.script("diagnostics", outcome);
		const launch = vi.spyOn(client, "launchDaemon");
		await assert.rejects(client.command("listApps"), {
			name: "HelperTransportError",
			code: "helper_inconclusive",
			message: /was not launched and setup was not run/,
		});
		assert.equal(launch.mock.calls.length, 0);
		assert.equal(spawn.mock.calls.length, 0);
		assert.ok(!fake.requests.some((request: { cmd: string }) => request.cmd === "listApps"));
	},
	30_000,
);

test.each(["ENOENT", "ECONNREFUSED"])("runs setup only after %s before connecting", async (code) => {
	const { client, connect, spawn, executable } = await rig(current, { installed: false });
	connect.failWith = code;
	spawn.mockImplementation(() => {
		mkdirSync(path.dirname(executable), { recursive: true });
		writeFileSync(executable, "installed\n", { mode: 0o755 });
		return createFakeChild({ exitCode: 0 });
	});
	await client.ensureInstalled();
	assert.equal(spawn.mock.calls.length, 1);
	assert.deepEqual((spawn.mock.calls[0] as unknown[])[1], [
		fileURLToPath(new URL("../scripts/setup-helper.mjs", import.meta.url)),
		"--runtime",
	]);
});

test.each([
	["ensureDaemon launch", "absent"],
	["ensureDaemon launch", "reply"],
	["ensureInstalled setup", "absent"],
	["ensureInstalled setup", "reply"],
])(
	"absence after connected timeout: %s keeps the connected evidence when the retry finds %s",
	async (caller, retry) => {
		const setup = caller === "ensureInstalled setup";
		const { client, fake, connect, spawn } = await rig(current, { installed: !setup });
		fake.script("diagnostics", [silent(), ok({ protocolVersion: 8, pid: 0, buildIdentity: current })]);
		if (retry === "absent")
			connect.afterConnect = () => {
				connect.failWith = "ENOENT";
			};
		const launch = vi.spyOn(client, "launchDaemon");
		const run = setup ? client.ensureInstalled() : client.command("listApps");
		if (retry === "absent") await assert.rejects(run, { code: "helper_inconclusive", message: /was not launched/ });
		else await run;
		assert.equal(launch.mock.calls.length, 0);
		assert.equal(spawn.mock.calls.length, 0);
	},
	30_000,
);

test("a slow-starting helper is not refused permanently: a later call binds without another launch", async () => {
	const { client, connect, spawn } = await rig(current);
	connect.failWith = "ENOENT";
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const launch = vi.spyOn(client, "launchDaemon").mockImplementation(async () => {
		setTimeout(() => {
			connect.failWith = undefined;
		}, 10_000);
	});
	const first = assert.rejects(client.command("listApps"), /daemon is unavailable/);
	await vi.advanceTimersByTimeAsync(9_000);
	await first;
	assert.equal(connect.failWith, "ENOENT");
	await vi.advanceTimersByTimeAsync(1_000);
	vi.useRealTimers();
	assert.deepEqual(await client.command("listApps"), []);
	assert.equal(launch.mock.calls.length, 1);
	assert.equal(spawn.mock.calls.length, 0);
});

test.each([
	[1_200, false],
	[3_000, false],
	[1_200, true],
	[3_000, true],
])(
	"a healthy resident whose diagnostics take %i ms is used, not launched or reinstalled (installed: %s)",
	async (ms, installed) => {
		const { client, fake, spawn, commands } = await rig(current, { installed });
		fake.script("diagnostics", slow(ms, ok({ protocolVersion: 8, pid: 0, buildIdentity: current })));
		const launch = vi.spyOn(client, "launchDaemon");
		if (installed) assert.deepEqual(await client.command("listApps"), []);
		else await client.ensureInstalled();
		assert.equal(launch.mock.calls.length, 0);
		assert.equal(spawn.mock.calls.length, 0);
		assert.ok(commands().every((cmd: string) => cmd === "diagnostics" || cmd === "listApps"));
	},
	30_000,
);

test("a socket error after connecting is not proof that the daemon was absent", async () => {
	const { client, fake, connect, spawn } = await rig(current, { installed: false });
	fake.script("diagnostics", silent());
	connect.afterConnect = (socket) => socket.destroy(Object.assign(new Error("write failed"), { code: "ECONNREFUSED" }));
	await assert.rejects(client.ensureInstalled(), /setup was not run: HelperTransportError: write failed/);
	assert.equal(spawn.mock.calls.length, 0);
});

test.each([
	["not executable", "EACCES", (exe: string) => writeFileSync(exe, "old\n", { mode: 0o644 })],
	["a directory", "not a regular file", (exe: string) => mkdirSync(exe)],
	["a dangling symlink", "ENOENT", (exe: string) => symlinkSync(`${exe}-gone`, exe)],
	// Injected: a privileged runner can read a `chmod 000` directory, so the errno comes from the fs seam.
	["behind an unreadable directory", "EACCES", undefined],
])("never runs setup over an existing helper executable that is %s", async (_name, reason, make) => {
	const { client, fake, spawn, executable } = await rig(current, {
		installed: false,
		executableError: make ? undefined : reason,
	});
	await fake.stop();
	mkdirSync(path.dirname(executable), { recursive: true });
	make?.(executable);
	await assert.rejects(client.ensureInstalled(), {
		message: `pi-computer-use helper executable at ${executable} exists but is unusable (${reason}); setup was not run. Inspect it, then repair it explicitly with \`node scripts/setup-helper.mjs --runtime\` from the package root.`,
	});
	assert.equal(spawn.mock.calls.length, 0);
});

test("keeps a matching resident when its executable is missing", async () => {
	const { client, spawn, commands } = await rig(current, { installed: false });
	await client.ensureInstalled();
	assert.deepEqual(commands(), ["diagnostics"]);
	assert.equal(spawn.mock.calls.length, 0);
});

test("accepts an identical build and checks a replacement on the next request socket", async () => {
	const { client, fake, commands, glow, spawn } = await rig(current);
	await assert.doesNotReject(client.ensureProtocol());
	assert.deepEqual(await client.command("listApps"), []);
	await glow.setActive(true);
	await glow.setActive(false);
	assert.deepEqual(commands(), [
		"diagnostics",
		"diagnostics",
		"diagnostics",
		"listApps",
		"diagnostics",
		"setActivityGlow",
		"setActivityGlow",
	]);
	fake.diagnostics.buildIdentity = older;
	fake.disconnectAll();
	await assert.rejects(client.command("listApps"), { code: "stale_helper" });
	await assert.rejects(glow.setActive(true), { code: "stale_helper" });
	assert.deepEqual(commands().slice(7), ["diagnostics", "diagnostics"]);
	assert.equal(spawn.mock.calls.length, 0);
});

test("rejects a stale activity connection even when the daemon was already marked available", async () => {
	const { client, fake, glow, commands } = await rig(current);
	await client.ensureProtocol();
	fake.diagnostics.buildIdentity = older;
	await assert.rejects(glow.setActive(true), { code: "stale_helper" });
	assert.deepEqual(commands(), ["diagnostics", "diagnostics", "diagnostics"]);
});

test("restart refuses, never shuts down, a daemon replaced by a stale build", async () => {
	const { client, fake, commands, spawn } = await rig(current);
	await client.ensureProtocol();
	fake.diagnostics.buildIdentity = older;
	await assert.rejects(client.restart(), { code: "stale_helper" });
	assert.ok(!commands().includes("shutdown"));
	assert.equal(spawn.mock.calls.length, 0);
});

test("an invalid build probe never sends the tool command", async () => {
	const { client, commands, fake } = await rig(current);
	await client.ensureProtocol();
	fake.script("diagnostics", [raw('{"id":"wrong","ok":true}\n'), raw("{malformed}\n"), raw("null\n")]);
	await assert.rejects(client.command("listApps"), /Invalid helper build probe reply/);
	// Probe and actual command use the same framing path, including JSON decode errors and non-objects.
	await assert.rejects(client.daemonCommand("listApps", {}, 1_000), { code: "helper_malformed" });
	await assert.rejects(client.daemonCommand("listApps", {}, 1_000), { code: "helper_malformed" });
	assert.ok(commands().every((cmd: string) => cmd === "diagnostics"));
});

test("refuses the wrong build even on a newly launched daemon", async () => {
	const { client, fake } = await rig(older);
	await fake.stop();
	const launch = vi.spyOn(client, "launchDaemon").mockImplementation(() => fake.start());
	await assert.rejects(client.ensureDaemon(), { code: "stale_helper" });
	assert.equal(launch.mock.calls.length, 1);
});

test("keeps the external socket override and shows its reported build in macOS status", async () => {
	const { client, commands, spawn } = await rig(older, { external: true, installed: false });
	assert.equal(client.isExternal(), true);
	await client.ensureInstalled();
	await client.ensureProtocol();
	assert.deepEqual(await client.command("listApps"), []);
	assert.deepEqual(commands(), ["diagnostics", "diagnostics", "diagnostics", "listApps"]);
	assert.equal(spawn.mock.calls.length, 0);
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
	const { default: extension } = await import("../src/index.ts");
	const pi = createRecordingPi();
	extension(pi.pi);
	const notify = vi.fn();
	await pi.commands.get("computer-use")?.handler("status", { cwd: process.cwd(), ui: { notify } });
	assert.match(notify.mock.calls[0][0], new RegExp(`^helper build: ${older.replace("+", "\\+")}$`, "m"));
});

test("all registered macOS tools propagate the exact stale refusal without sending an effect", async () => {
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
	const { commands, executable, spawn } = await rig(older);
	const { default: extension } = await import("../src/index.ts");
	const { reconstructStateFromBranch } = await import("../src/bridge.ts");
	const pi = createRecordingPi();
	extension(pi.pi);
	const stateId = "saved-fixture";
	const ctx = {
		cwd: makeTestTempDir("cu-stale-tools-", onTestFinished),
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "observe_ui",
						details: {
							target: { app: "Fixture", pid: 42, windowId: 11 },
							capture: { stateId, width: 100, height: 100, timestamp: 0 },
							outline: { lookId: "fixture", root: { ref: "@e1", children: [] }, nodes: [] },
						},
					},
				},
			],
		},
	} as unknown as Parameters<typeof reconstructStateFromBranch>[0];
	reconstructStateFromBranch(ctx);
	const fixtures = {
		find_roots: {},
		observe_ui: { mode: "semantic" },
		search_ui: { stateId, text: "button" },
		expand_ui: { stateId, ref: "@e1" },
		inspect_ui: { stateId, ref: "@e1" },
		act_ui: { stateId, actions: [{ action: "press", ref: "@e1" }] },
		read_text: { stateId, ref: "@e1" },
		wait_for: { stateId, text: "button" },
		launch_browser: {},
		navigate_browser: { stateId, url: "https://example.invalid" },
		evaluate_browser: { stateId, expression: "1" },
		desktop_screenshot: {},
		desktop_input: { action: "writeClipboard", text: "fixture" },
	};
	assert.deepEqual([...pi.tools.keys()].sort(), Object.keys(fixtures).sort());
	for (const [name, params] of Object.entries(fixtures)) {
		const tool = pi.tools.get(name);
		assert.ok(tool?.execute, name);
		const before = commands().length;
		await assert.rejects(
			Reflect.apply(tool.execute, tool, [name, params, undefined, undefined, ctx]),
			{
				code: "stale_helper",
				message: staleMessage(executable, older),
			},
			name,
		);
		assert.deepEqual(commands().slice(before), ["diagnostics"], name);
	}
	assert.equal(spawn.mock.calls.length, 0);
});

test("macOS status shows unchecked, then stale with the expected build, then the matching build", async () => {
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
	const { client, fake, executable } = await rig(older);
	const reportedPath = path.join(path.dirname(executable), "old-bridge");
	Object.assign(fake.diagnostics, { executablePath: reportedPath });
	const { default: extension } = await import("../src/index.ts");
	const pi = createRecordingPi();
	extension(pi.pi);
	const status = async () => {
		const notify = vi.fn();
		await pi.commands.get("computer-use")?.handler("status", { cwd: process.cwd(), ui: { notify } });
		return notify.mock.calls[0][0] as string;
	};
	assert.match(await status(), /^helper build: not checked$/m);
	await assert.rejects(client.ensureProtocol(), { code: "stale_helper", message: staleMessage(reportedPath, older) });
	const stale = await status();
	assert.ok(
		stale
			.split("\n")
			.includes(
				`helper build: stale (reported ${older}, expected ${current}): from the package root, run \`node scripts/setup-helper.mjs --runtime\`. For a source checkout, rebuild first with \`npm run build:native\`. See https://github.com/nredd/pi-harness/tree/main/packages/computer-use#repair-a-missing-macos-helper`,
			),
	);
	assert.ok(!stale.includes(reportedPath), "status never shows the daemon-reported executable path");
	assert.ok(!stale.includes(executable));
	fake.diagnostics.buildIdentity = current;
	fake.diagnostics.executablePath = executable;
	await client.ensureProtocol();
	assert.ok((await status()).split("\n").includes(`helper build: ${current}`));
});

test.each([
	["/Users/<user>/bridge", "unrecognized"],
	[`0.7.0+${"A".repeat(64)}\nhelper build: ${current}`, "unrecognized"],
	[42, "unrecognized"],
	[undefined, "none"],
])("macOS status and the refusal never echo a malformed build %j", async (reported, shown) => {
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
	const { client, fake, executable } = await rig(undefined);
	Object.assign(fake.diagnostics, { buildIdentity: reported });
	const { default: extension } = await import("../src/index.ts");
	const pi = createRecordingPi();
	extension(pi.pi);
	await assert.rejects(client.ensureProtocol(), { code: "stale_helper", message: staleMessage(executable, shown) });
	const notify = vi.fn();
	await pi.commands.get("computer-use")?.handler("status", { cwd: process.cwd(), ui: { notify } });
	const status = notify.mock.calls[0][0] as string;
	assert.ok(status.includes(`helper build: stale (reported ${shown}, expected ${current}): `));
	if (typeof reported === "string") assert.ok(!status.includes(reported.split("\n")[0]));
});

test("uncompiled Swift file: the stamp hashes the compiled production sources only", async () => {
	const root = makeTestTempDir("cu-build-stamp-", onTestFinished);
	const dir = path.join(root, "native", "macos");
	mkdirSync(dir, { recursive: true });
	const versionFile = path.join(root, "package.json");
	writeFileSync(versionFile, '{"version":"1.2.3"}');
	const fixture = ["activity_glow", "agent_cursor", "agent_cursor_motion", "bridge", "helper_entry"];
	for (const file of fixture.toReversed()) writeFileSync(path.join(dir, `${file}.swift`), "// v1\n");
	writeFileSync(path.join(dir, "headless_tests.swift"), "// ignored\n");
	// Uncompiled Swift file: scratch in the build checkout is neither compiled nor packed.
	writeFileSync(path.join(dir, "scratch.swift"), "// not compiled\n");
	const digest = createHash("sha256")
		.update(fixture.map((file) => `${file}.swift:6:// v1\n`).join(""))
		.digest("hex");
	let compiled = false;
	await main(["--no-sign"], {
		rootDir: root,
		tmpdir: root,
		platform: "darwin",
		arch: "arm64",
		log: () => {},
		run: async (command: string, args: string[]) => {
			assert.equal(command, "xcrun");
			assert.deepEqual(
				args.filter((arg) => arg.startsWith(dir)),
				macosHelperSourcePaths.map((file: string) => path.join(root, file)),
				"the stamp hashes exactly the compiler input list",
			);
			const stamp = args.find((arg) => arg.endsWith("/HelperBuildStamp.swift"));
			assert.ok(stamp);
			assert.equal(readFileSync(stamp, "utf8"), `let helperBuildIdentity = "1.2.3+${digest}"\n`);
			compiled = true;
			writeFileSync(args[args.indexOf("-o") + 1], "fixture binary");
		},
	});
	assert.ok(compiled);
	const sharedStamp = writeMacosBuildStamp(root, root);
	assert.equal(readFileSync(sharedStamp, "utf8"), `let helperBuildIdentity = "1.2.3+${digest}"\n`);
	writeFileSync(versionFile, '{"version":"1.2.4"}');
	assert.equal(macosHelperBuild(root), `1.2.4+${digest}`);
	for (const file of fixture) writeFileSync(path.join(dir, `${file}.swift`), "// v1\r\n");
	assert.equal(macosHelperBuild(root), `1.2.4+${digest}`, "CRLF checkouts have the same source hash");
	writeFileSync(path.join(dir, "bridge.swift"), "// v2\n");
	assert.notEqual(macosHelperBuild(root), `1.2.4+${digest}`);
});
