import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecordingPi } from "@nredd/pi-test-lib/pi";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, onTestFinished, test, vi } from "vitest";
import { main } from "../scripts/build-native.mjs";
import { macosHelperBuild } from "../src/platform/macos/helper-build.mjs";
import { drop, ok, raw, shortSocketPath, silent, startFakeHelper } from "../test/support/fake-helper.mjs";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
assert.ok(platformDescriptor);
const current = macosHelperBuild(fileURLToPath(new URL("../", import.meta.url)));
const older = `0.0.0+${"0".repeat(64)}`;

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.doUnmock("node:net");
	vi.doUnmock("node:child_process");
	vi.resetModules();
});

async function rig(buildIdentity: string | undefined, { external = false, installed = true } = {}) {
	const app = path.join(makeTestTempDir("cu-build-app-", onTestFinished), "fixture.app");
	const executable = path.join(app, "Contents", "MacOS", "bridge");
	if (installed) {
		mkdirSync(path.dirname(executable), { recursive: true });
		writeFileSync(executable, "not executed\n", { mode: 0o755 });
	}
	const socketPath = shortSocketPath();
	const fake = await startFakeHelper({
		socketPath,
		diagnostics: { protocolVersion: 7, pid: 0, buildIdentity },
		handlers: { listApps: ok([]), setActivityGlow: ok({}) },
	});
	onTestFinished(() => fake.stop());
	vi.stubEnv("PI_CU_SOCKET_PATH", external ? socketPath : undefined);
	vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", app);
	vi.doMock("node:net", async (original) => {
		const real = await original<typeof import("node:net")>();
		return { ...real, default: { ...real, createConnection: () => real.createConnection(socketPath) } };
	});
	const spawn = vi.fn(() => {
		throw new Error("Unexpected helper process launch");
	});
	vi.doMock("node:child_process", async (original) => ({ ...(await original<object>()), spawn }));
	const { macosHelper, macosActivityGlow } = await import("../src/platform/macos/helper.ts");
	onTestFinished(() => macosActivityGlow.close());
	return {
		client: macosHelper,
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
		await client.ensureInstalled();
		const error = {
			code: "stale_helper",
			message: `pi-computer-use helper at ${executable} is stale (helper build ${build ?? "unknown"}, expected ${current}): re-run the package setup to update it.`,
		};
		await assert.rejects(client.ensureProtocol(), error);
		await assert.rejects(client.command("listApps"), error);
		assert.deepEqual(commands(), ["diagnostics", "diagnostics"]);
		assert.equal(spawn.mock.calls.length, 0);
	},
);

test("refuses a stale resident daemon before setup when the executable is missing", async () => {
	const { client, spawn, commands } = await rig(older, { installed: false });
	await assert.rejects(client.ensureInstalled(), { code: "stale_helper" });
	assert.deepEqual(commands(), ["diagnostics"]);
	assert.equal(spawn.mock.calls.length, 0);
});

test.each([silent(), drop(), raw("{malformed}\n"), raw('{"id":"wrong","ok":true}\n')])(
	"refuses setup after a resident accepts the socket but diagnostics returns $kind",
	async (reply) => {
		const { client, fake, spawn, commands } = await rig(current, { installed: false });
		fake.script("diagnostics", reply);
		await assert.rejects(client.ensureInstalled(), /setup was not run/);
		assert.deepEqual(commands(), ["diagnostics"]);
		assert.equal(spawn.mock.calls.length, 0);
	},
);

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

test("an invalid build probe never sends the tool command", async () => {
	const { client, commands, fake } = await rig(current);
	await client.ensureProtocol();
	fake.script("diagnostics", [raw('{"id":"wrong","ok":true}\n'), raw("{malformed}\n")]);
	await assert.rejects(client.command("listApps"), /Invalid helper build probe reply/);
	// Probe and actual command use the same framing path, including JSON decode errors.
	await assert.rejects(client.daemonCommand("listApps", {}, 1_000), SyntaxError);
	assert.ok(commands().every((cmd: string) => cmd === "diagnostics"));
});

test("refuses the wrong build even on a newly launched daemon", async () => {
	const { client, fake } = await rig(older);
	fake.script("diagnostics", [drop(), ok({ buildIdentity: older })]);
	vi.spyOn(client, "launchDaemon").mockResolvedValue(undefined);
	await assert.rejects(client.ensureDaemon(), { code: "stale_helper" });
});

test("keeps the external socket override and shows its reported build in macOS status", async () => {
	const { client, commands, spawn } = await rig(older, { external: true, installed: false });
	await client.ensureInstalled();
	await client.ensureProtocol();
	assert.deepEqual(await client.command("listApps"), []);
	assert.deepEqual(commands(), ["diagnostics", "diagnostics", "listApps"]);
	assert.equal(spawn.mock.calls.length, 0);
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
	const { default: extension } = await import("../src/index.ts");
	const pi = createRecordingPi();
	extension(pi.pi);
	const notify = vi.fn();
	await pi.commands.get("computer-use")?.handler("status", { cwd: process.cwd(), ui: { notify } });
	assert.match(notify.mock.calls[0][0], new RegExp(`^helper build: ${older.replace("+", "\\+")}$`, "m"));
});

test("passes a version and production source hash to swiftc", async () => {
	const root = makeTestTempDir("cu-build-stamp-", onTestFinished);
	const dir = path.join(root, "native", "macos");
	mkdirSync(dir, { recursive: true });
	const versionFile = path.join(root, "package.json");
	writeFileSync(versionFile, '{"version":"1.2.3"}');
	const fixture = ["activity_glow", "agent_cursor", "agent_cursor_motion", "bridge", "helper_entry"];
	for (const file of fixture.toReversed()) writeFileSync(path.join(dir, `${file}.swift`), "// v1\n");
	writeFileSync(path.join(dir, "headless_tests.swift"), "// ignored\n");
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
			const stamp = args.find((arg) => arg.endsWith("/HelperBuildStamp.swift"));
			assert.ok(stamp);
			assert.equal(readFileSync(stamp, "utf8"), `let helperBuildIdentity = "1.2.3+${digest}"\n`);
			compiled = true;
			writeFileSync(args[args.indexOf("-o") + 1], "fixture binary");
		},
	});
	assert.ok(compiled);
	writeFileSync(versionFile, '{"version":"1.2.4"}');
	assert.equal(macosHelperBuild(root), `1.2.4+${digest}`);
	writeFileSync(path.join(dir, "bridge.swift"), "// v2\n");
	assert.notEqual(macosHelperBuild(root), `1.2.4+${digest}`);
});
