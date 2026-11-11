// Windows and Linux helper clients (`src/platform/{windows,linux}/helper.ts`) over the protocol-faithful fake
// helper (`support/fake-helper.mjs`): framing, protocol mismatch, spawn failure, exit mid-command, timeouts, error codes.
// No real helper, Windows or Linux host: `node:child_process.spawn` is replaced and the executable check uses a temp file.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	body,
	createFakeChild,
	createFakeSpawn,
	createHelperEngine,
	drop,
	fail,
	ok,
	raw,
	silent,
	slow,
	split,
	withProtocol,
} from "./support/fake-helper.mjs";

const REQUIRED_INVARIANTS = [
	"state-scoped-observations",
	"bounded-observation-history",
	"multi-root-forest",
	"progressive-disclosure",
	"atomic-physical-input",
	"concurrent-requests",
	"transactional-batching",
];

let tmp;
let helperPath;
let clients;

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "shc-"));
	helperPath = path.join(tmp, "bridge");
	clients = [];
});

afterEach(() => {
	for (const client of clients) client.dispose();
	vi.useRealTimers();
	vi.doUnmock("node:child_process");
	vi.unstubAllEnvs();
	vi.resetModules();
	rmSync(tmp, { recursive: true, force: true });
});

/** Make `helperPath` an executable (or remove its exec bit). */
function install(executable = true) {
	writeFileSync(helperPath, "#!/bin/sh\n");
	chmodSync(helperPath, executable ? 0o755 : 0o644);
}

/**
 * Child like a real one: `exit` fires before `close`, as in Node. `hold` defers the `spawn` event until `hold.release()`. `exit(code)` ends the stdio streams and emits both.
 * Every child is recorded in `children`.
 */
function realisticChild(children, options, hold) {
	const child = createFakeChild(options);
	child.signalCode = null;
	if (hold) {
		// `hold.release()` emits the deferred `spawn` event: a helper whose start is still in flight.
		const emit = child.emit.bind(child);
		hold.release = () => emit("spawn");
		child.emit = (event, ...args) => (event === "spawn" ? true : emit(event, ...args));
	}
	const close = child.exit;
	child.exit = (code = 0) => {
		child.emit("exit", code, null);
		close(code);
	};
	children.push(child);
	return child;
}

function envelope(platform, handlers = {}, extra = {}) {
	return createHelperEngine({
		profile: "envelope",
		protocolVersion: 4,
		platform,
		handlers,
		diagnostics: { invariants: REQUIRED_INVARIANTS },
		...extra,
	});
}

/**
 * Import a fresh `helper.ts` with `spawn` replaced. `setup` is the fake child options (or a function that may install the
 * helper) for the `setup-helper.mjs` run; `helper` is the child for the helper binary itself.
 */
async function load(platform, { setup = { exitCode: 0 }, helper }) {
	vi.resetModules();
	const children = [];
	const setups = [];
	const spawn = createFakeSpawn({
		[path.basename(process.execPath)]: (command, args, options) => {
			const made = typeof setup === "function" ? setup(command, args, options) : setup;
			const child = realisticChild(setups, made);
			return child;
		},
		"*": () => (typeof helper === "function" ? helper(children) : realisticChild(children, helper)),
	});
	vi.doMock("node:child_process", async (original) => ({ ...(await original()), spawn }));
	const module = await import(`../src/platform/${platform}/helper.ts`);
	return { module, spawn, children, setups };
}

const track = (client) => {
	clients.push(client);
	return client;
};

describe("Windows helper client", () => {
	async function windows(options) {
		vi.stubEnv("PI_COMPUTER_USE_WINDOWS_HELPER_PATH", helperPath);
		const loaded = await load("windows", options);
		const client = track(new loaded.module.WindowsHelperClient());
		return { ...loaded, client };
	}
	const helperSpawns = (spawn) => spawn.calls.filter((call) => call.command === helperPath);
	const setupSpawns = (spawn) => spawn.calls.filter((call) => call.command === process.execPath);

	test("exports the default helper path and a shared client", async () => {
		vi.resetModules();
		vi.stubEnv("PI_COMPUTER_USE_WINDOWS_HELPER_PATH", "");
		const { WINDOWS_HELPER_PATH, WINDOWS_HELPER_PROTOCOL_VERSION, windowsHelper, WindowsHelperClient } = await import("../src/platform/windows/helper.ts");
		assert.equal(WINDOWS_HELPER_PROTOCOL_VERSION, 4);
		assert.equal(WINDOWS_HELPER_PATH, path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe"));
		assert.ok(windowsHelper instanceof WindowsHelperClient);
		windowsHelper.dispose();
	});

	test("runs setup once when the helper is missing, then reuses the installed helper", async () => {
		const engine = envelope("Windows", { look: ok({ roots: [] }) });
		const { client, spawn } = await windows({
			setup: (command, args, options) => {
				install();
				return { exitCode: 0 };
			},
			helper: { engine },
		});
		assert.deepEqual(await client.command("look", { app: "x" }), { roots: [] });
		assert.deepEqual(await client.command("look"), { roots: [] });
		const [setup] = setupSpawns(spawn);
		assert.equal(setupSpawns(spawn).length, 1);
		assert.deepEqual(setup.args.slice(1), ["--platform", "windows", "--runtime"]);
		assert.equal(setup.options.env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(setup.options.env.BUN_BE_BUN, "1");
		assert.deepEqual(setup.options.stdio, ["ignore", "pipe", "pipe"]);
		assert.equal(helperSpawns(spawn).length, 1);
		assert.deepEqual(engine.requests.map((request) => request.cmd), ["look", "look"]);
		assert.deepEqual(engine.requests[0].raw, { protocolVersion: 4, id: engine.requests[0].id, cmd: "look", args: { app: "x" } });
	});

	test("re-runs setup when an installed helper was never validated, and when it disappears", async () => {
		install();
		const engine = envelope("Windows", { look: ok({}) });
		const { client, spawn } = await windows({ helper: { engine } });
		await client.ensureInstalled();
		assert.equal(setupSpawns(spawn).length, 1, "executable but unchecked still runs setup once");
		await client.ensureInstalled();
		assert.equal(setupSpawns(spawn).length, 1, "checked and executable: no setup");
		rmSync(helperPath);
		await assert.rejects(client.ensureInstalled(), /Failed to install Windows helper at /);
		assert.equal(setupSpawns(spawn).length, 2, "checked but gone: setup again");
	});

	test("setup that leaves no executable fails with the install path", async () => {
		const { client } = await windows({ helper: {} });
		await assert.rejects(client.command("look"), new RegExp(`Failed to install Windows helper at ${helperPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
	});

	test("setup failure reports exit code and stderr then stdout", async () => {
		const { client } = await windows({ setup: { exitCode: 3, stdout: "out line\n", stderr: "err line\n" }, helper: {} });
		await assert.rejects(client.ensureInstalled(), (error) => {
			assert.match(error.message, /^Command failed \(3\): .*setup-helper\.mjs --platform windows --runtime\nerr line\nout line$/);
			return true;
		});
	});

	test("setup failure with no output has no trailing detail", async () => {
		const { client } = await windows({ setup: { exitCode: 1 }, helper: {} });
		await assert.rejects(client.ensureInstalled(), (error) => /--runtime$/.test(error.message));
	});

	test("setup spawn error rejects with that error", async () => {
		const { client } = await windows({ setup: { spawnError: new Error("spawn ENOENT") }, helper: {} });
		await assert.rejects(client.ensureInstalled(), /spawn ENOENT/);
	});

	test("setup honours an already aborted signal without spawning", async () => {
		const { client, spawn } = await windows({ helper: {} });
		await assert.rejects(client.ensureInstalled(AbortSignal.abort()), /Operation aborted\./);
		assert.equal(spawn.calls.length, 0);
	});

	test("aborting setup kills it with SIGTERM", async () => {
		const controller = new AbortController();
		const { client, setups } = await windows({ setup: { hang: true }, helper: {} });
		const pending = client.ensureInstalled(controller.signal);
		await vi.waitFor(() => assert.equal(setups.length, 1));
		controller.abort();
		await assert.rejects(pending, /Operation aborted\./);
		assert.deepEqual(setups[0].signals, ["SIGTERM"]);
	});

	test("setup that never finishes times out after 60s and is killed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { client, setups } = await windows({ setup: { hang: true }, helper: {} });
		const pending = client.ensureInstalled();
		await vi.waitFor(() => assert.equal(setups.length, 1));
		const outcome = assert.rejects(pending, /Command timed out after 60000ms: .*setup-helper\.mjs --platform windows --runtime/);
		await vi.advanceTimersByTimeAsync(59_000);
		assert.deepEqual(setups[0].signals, []);
		await vi.advanceTimersByTimeAsync(1_000);
		await outcome;
		assert.deepEqual(setups[0].signals, ["SIGTERM"]);
	});

	test("frames replies split across chunks, ignores blank lines, garbage and unknown ids", async () => {
		install();
		const engine = envelope("Windows", {
			look: split(ok({ roots: [1, 2, 3] }), 4, 1),
			noise: (request) => ({ kind: "raw", text: `\n   \n{not json\n${JSON.stringify({ protocolVersion: 4, id: "stranger", ok: true, result: {} })}\n${JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result: "after noise" })}\n` }),
		});
		const { client } = await windows({ helper: { engine } });
		assert.deepEqual(await client.command("look"), { roots: [1, 2, 3] });
		assert.equal(await client.command("noise"), "after noise");
	});

	test("serves concurrent commands and matches replies by id", async () => {
		install();
		const engine = envelope("Windows", { a: slow(40, ok("A")), b: ok("B") });
		const { client, spawn } = await windows({ helper: { engine } });
		assert.deepEqual(await Promise.all([client.command("a"), client.command("b")]), ["A", "B"]);
		assert.equal(helperSpawns(spawn).length, 1);
	});

	test("error replies carry message and code; defaults apply when missing", async () => {
		install();
		const engine = envelope("Windows", {
			denied: fail("not allowed", "permission_denied"),
			nocode: fail("plain"),
			bare: body({ ok: false }),
		});
		const { client } = await windows({ helper: { engine } });
		await assert.rejects(client.command("denied"), (error) => error.message === "not allowed" && error.code === "permission_denied");
		await assert.rejects(client.command("nocode"), (error) => error.message === "plain" && error.code === undefined);
		await assert.rejects(client.command("bare"), (error) => error.message === "Windows helper command failed." && error.code === undefined);
		await assert.rejects(client.command("missing"), (error) => error.code === "unsupported_command" && error.message === "Unknown command 'missing'");
	});

	test("a reply from another protocol version is rejected with the versions named", async () => {
		install();
		const engine = envelope("Windows", {
			old: withProtocol(3),
			unversioned: (request) => raw(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`),
		});
		const { client } = await windows({ helper: { engine } });
		await assert.rejects(client.command("old"), /Windows helper protocol mismatch: expected 4, got 3\. Restart Pi to use the installed helper\./);
		await assert.rejects(client.command("unversioned"), /expected 4, got unknown\./);
	});

	test("a command that gets no reply times out and a late reply is ignored", async () => {
		install();
		const engine = envelope("Windows", { hang: silent() });
		const { client, children } = await windows({ helper: { engine } });
		await assert.rejects(client.command("hang", {}, { timeoutMs: 30 }), /Helper command 'hang' timed out after 30ms\./);
		children[0].stdout.write(`${JSON.stringify({ protocolVersion: 4, id: engine.requests[0].id, ok: true, result: {} })}\n`);
		engine.script("hang", ok("again"));
		assert.equal(await client.command("hang"), "again");
	});

	test("default command timeout is 15s", async () => {
		install();
		const engine = envelope("Windows", { hang: silent() });
		const { client } = await windows({ helper: { engine } });
		await client.ensureInstalled();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const outcome = assert.rejects(client.command("hang"), /timed out after 15000ms\./);
		await vi.waitFor(() => assert.equal(engine.requests.length, 1), { interval: 1 });
		await vi.advanceTimersByTimeAsync(15_000);
		await outcome;
	});

	test("a failed stdin write rejects the command with the write error", async () => {
		install();
		const { client, children } = await windows({ helper: { engine: envelope("Windows") } });
		await client.command("diagnostics");
		children[0].stdin.destroy();
		await assert.rejects(client.command("diagnostics"), (error) => error.code === "ERR_STREAM_DESTROYED");
	});

	test("#725: a child exiting with a command in flight leaves it waiting for the command timeout", async () => {
		install();
		const engine = envelope("Windows", { crash: silent() });
		const { client, children } = await windows({ helper: (list) => realisticChild(list, { engine }) });
		await client.ensureInstalled();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let settled = false;
		const outcome = client.command("crash", {}, { timeoutMs: 1000 }).then(() => assert.fail("resolved"), (error) => {
			settled = true;
			throw error;
		});
		const rejection = assert.rejects(outcome, /Helper command 'crash' timed out after 1000ms\./);
		await vi.waitFor(() => assert.equal(engine.requests.length, 1), { interval: 1 });
		children[0].exit(1);
		await vi.advanceTimersByTimeAsync(900);
		// Current behavior: the exit does not reject the command; only its timeout does. When #725 lands this
		// becomes an immediate error on exit and this test must be updated.
		assert.equal(settled, false);
		await vi.advanceTimersByTimeAsync(100);
		await rejection;
	});

	test("after the child exits, the next command spawns a fresh helper", async () => {
		install();
		const engine = envelope("Windows", { look: ok("fresh") });
		const { client, children, spawn } = await windows({ helper: (list) => realisticChild(list, { engine }) });
		await client.command("look");
		children[0].exit(0);
		assert.equal(await client.command("look"), "fresh");
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("a spawn error clears the child so the next command respawns", async () => {
		install();
		const { client, children, spawn } = await windows({ helper: (list) => realisticChild(list, { engine: envelope("Windows", { look: ok(1) }) }) });
		await client.command("look");
		children[0].fail(new Error("boom"));
		assert.equal(await client.command("look"), 1);
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("a killed child is replaced even before its exit event; stale events are ignored", async () => {
		install();
		const engine = envelope("Windows", { look: ok(1) });
		const { client, children, spawn } = await windows({ helper: (list) => realisticChild(list, { engine }) });
		await client.command("look");
		children[0].kill();
		await client.command("look");
		assert.equal(helperSpawns(spawn).length, 2);
		// Late exit/error of the replaced child must not clear the live one.
		children[0].emit("exit", 0, null);
		children[0].emit("error", new Error("late"));
		await client.command("look");
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("dispose rejects in-flight commands, destroys the streams and kills the child", async () => {
		install();
		const engine = envelope("Windows", { hang: silent() });
		const { client, children } = await windows({ helper: { engine } });
		const pending = client.command("hang");
		await vi.waitFor(() => assert.equal(engine.requests.length, 1));
		const unref = vi.spyOn(children[0], "unref");
		client.dispose();
		await assert.rejects(pending, /Windows helper closed because the Pi session ended\./);
		assert.deepEqual(children[0].signals, ["SIGTERM"]);
		assert.equal(children[0].stdin.destroyed, true);
		assert.equal(unref.mock.calls.length, 1);
		client.dispose();
		assert.deepEqual(children[0].signals, ["SIGTERM"], "second dispose is a no-op");
	});

	test("dispose with nothing running is a no-op", async () => {
		const { client } = await windows({ helper: {} });
		client.dispose();
	});
});

describe("Linux helper client", () => {
	const SETUP_SCRIPT = "/nonexistent/setup-helper.mjs";

	async function linux(options, clientOptions = { helperPath, setupHelperScript: SETUP_SCRIPT }) {
		const loaded = await load("linux", options);
		const client = track(new loaded.module.LinuxHelperClient(clientOptions));
		return { ...loaded, client };
	}
	const helperSpawns = (spawn) => spawn.calls.filter((call) => call.command === helperPath);
	const setupSpawns = (spawn) => spawn.calls.filter((call) => call.command === process.execPath);
	/** Setup stand-in that installs the helper. */
	const installing = () => {
		install();
		return { exitCode: 0 };
	};
	const linuxEngine = (handlers, extra) => envelope("Linux", handlers, extra);

	test("defaults: helper path, shared client, reset swaps and disposes it", async () => {
		vi.resetModules();
		vi.stubEnv("PI_COMPUTER_USE_LINUX_HELPER_PATH", "");
		const module = await import("../src/platform/linux/helper.ts");
		assert.equal(module.LINUX_HELPER_PROTOCOL_VERSION, 4);
		assert.equal(module.LINUX_HELPER_PATH, path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge"));
		const before = module.linuxHelper;
		assert.ok(before instanceof module.LinuxHelperClient);
		module.resetLinuxHelper();
		assert.notEqual(module.linuxHelper, before);
		await assert.rejects(before.command("look"), /Linux helper closed because the Pi session ended\./);
		module.linuxHelper.dispose();
	});

	test("an installed, compatible helper is probed once and serves commands with no setup", async () => {
		install();
		const engine = linuxEngine({ look: ok({ roots: [] }) });
		const { client, spawn } = await linux({ helper: { engine } });
		assert.deepEqual(await client.command("look", { app: "x" }), { roots: [] });
		assert.deepEqual(await client.command("look"), { roots: [] });
		assert.equal(setupSpawns(spawn).length, 0);
		assert.equal(helperSpawns(spawn).length, 1, "the validated probe child stays as the live process");
		assert.deepEqual(engine.requests.map((request) => request.cmd), ["diagnostics", "look", "look"]);
		assert.deepEqual(engine.requests[1].raw, { protocolVersion: 4, id: engine.requests[1].id, cmd: "look", args: { app: "x" } });
		assert.deepEqual(helperSpawns(spawn)[0].options.stdio, ["pipe", "pipe", "pipe"]);
	});

	test("a missing helper runs setup (with the helper path in its env) then probes", async () => {
		const engine = linuxEngine({ look: ok(1) });
		const { client, spawn } = await linux({ setup: installing, helper: { engine } });
		assert.equal(await client.command("look"), 1);
		const [setup] = setupSpawns(spawn);
		assert.deepEqual(setup.args, [SETUP_SCRIPT, "--platform", "linux", "--runtime"]);
		assert.equal(setup.options.env.PI_COMPUTER_USE_LINUX_HELPER_PATH, helperPath);
		assert.equal(setup.options.env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(setup.options.env.BUN_BE_BUN, "1");
		assert.equal(engine.requests[0].cmd, "diagnostics");
	});

	test("concurrent callers share one probe and one helper process", async () => {
		install();
		const engine = linuxEngine({ a: slow(20, ok("A")), b: ok("B") });
		const { client, spawn } = await linux({ helper: { engine } });
		assert.deepEqual(await Promise.all([client.command("a"), client.command("b"), client.ensureInstalled()]), ["A", "B", undefined]);
		assert.equal(helperSpawns(spawn).length, 1);
		assert.equal(engine.requests.filter((request) => request.cmd === "diagnostics").length, 1);
	});

	test("a checked helper that vanishes is reinstalled; concurrent installs share the setup", async () => {
		const engine = linuxEngine({ look: ok(1) });
		const { client, spawn } = await linux({ setup: installing, helper: (list) => realisticChild(list, { engine }) });
		await client.command("look");
		rmSync(helperPath);
		await Promise.all([client.ensureInstalled(), client.ensureInstalled()]);
		assert.equal(setupSpawns(spawn).length, 2);
		assert.equal(helperSpawns(spawn).length, 2, "the replaced helper is discarded and probed anew");
		assert.equal(await client.command("look"), 1);
	});

	test("a stale protocol is rejected, setup replaces it, and the rejection reason is kept on setup failure", async () => {
		install();
		const engine = linuxEngine({ diagnostics: withProtocol(3) });
		const { client, spawn } = await linux({ setup: { exitCode: 2, stderr: "no prebuilt\n" }, helper: { engine } });
		await assert.rejects(client.ensureInstalled(), (error) => {
			assert.match(error.message, /^Command failed \(2\): .*--platform linux --runtime\nno prebuilt\nInstalled Linux helper .* was rejected: Linux helper protocol mismatch: expected 4, got 3\.$/s);
			assert.doesNotMatch(error.message, /Restart Pi/);
			return true;
		});
		assert.equal(setupSpawns(spawn).length, 1);
	});

	test("a rejected helper that setup replaces is re-probed and then used", async () => {
		install();
		const stale = linuxEngine({ diagnostics: ok({ protocolVersion: 4, architectureVersion: 0, invariants: [] }) });
		const fresh = linuxEngine({ look: ok("fresh") });
		let generation = 0;
		const { client, spawn, children } = await linux({
			setup: () => {
				generation = 1;
				return { exitCode: 0 };
			},
			helper: (list) => realisticChild(list, { engine: generation ? fresh : stale }),
		});
		assert.equal(await client.command("look"), "fresh");
		assert.equal(setupSpawns(spawn).length, 1);
		assert.deepEqual(children[0].signals, ["SIGTERM"], "the rejected helper is killed");
	});

	test("an installed helper that fails validation after setup names the path and the reason", async () => {
		const engine = linuxEngine({ diagnostics: ok({ protocolVersion: 4, architectureVersion: 9 }) });
		const { client, children } = await linux({ setup: installing, helper: { engine } });
		await assert.rejects(client.ensureInstalled(), (error) => {
			assert.ok(error.message.startsWith(`Linux helper installed at ${helperPath} failed validation: `));
			assert.ok(error.message.endsWith("Linux helper architecture mismatch: expected 1, got 9. Rebuild and restart the helper. Re-run setup or delete it."));
			return true;
		});
		assert.deepEqual(children[0].signals, ["SIGTERM"]);
	});

	test("a probe that reports nothing is a protocol mismatch of unknown", async () => {
		install();
		const engine = linuxEngine({ diagnostics: ok(null) });
		const { client } = await linux({ setup: { exitCode: 1 }, helper: { engine } });
		await assert.rejects(client.ensureInstalled(), (error) => error.message.includes("was rejected: protocol mismatch: expected 4, got unknown."));
	});

	test("setup that leaves no executable fails with the install path", async () => {
		const { client } = await linux({ helper: {} });
		await assert.rejects(client.ensureInstalled(), /Failed to install Linux helper at /);
	});

	test("setup that times out adds the manual setup hint and escalates to SIGKILL after the grace", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { client, setups } = await linux({ setup: { hang: true }, helper: {} });
		const outcome = assert.rejects(client.ensureInstalled(), /Command timed out after 60000ms: .*\nRun `PI_COMPUTER_USE_ALLOW_BUILD=1 node .*setup-helper\.mjs --platform linux` once outside Pi/s);
		await vi.waitFor(() => assert.equal(setups.length, 1), { interval: 1 });
		await vi.advanceTimersByTimeAsync(60_000);
		await outcome;
		assert.deepEqual(setups[0].signals, ["SIGTERM"]);
		await vi.advanceTimersByTimeAsync(2_000);
		assert.deepEqual(setups[0].signals, ["SIGTERM", "SIGKILL"]);
	});

	test("setup that exits after SIGTERM is not SIGKILLed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { client, setups } = await linux({ setup: { hang: true }, helper: {} });
		const outcome = assert.rejects(client.ensureInstalled(), /timed out/);
		await vi.waitFor(() => assert.equal(setups.length, 1), { interval: 1 });
		await vi.advanceTimersByTimeAsync(60_000);
		await outcome;
		setups[0].exit(143);
		await vi.advanceTimersByTimeAsync(2_000);
		assert.deepEqual(setups[0].signals, ["SIGTERM"]);
	});

	test("setup failures: exit code with output, without output, spawn error, and a late close reported once", async () => {
		const failing = await linux({ setup: { exitCode: 4, stdout: "built nothing\n" }, helper: {} });
		await assert.rejects(failing.client.ensureInstalled(), (error) => /^Command failed \(4\): .*\nbuilt nothing$/s.test(error.message));
		const noOutput = await linux({ setup: { exitCode: 5 }, helper: {} });
		await assert.rejects(noOutput.client.ensureInstalled(), (error) => /--runtime$/.test(error.message));
		const broken = await linux({ setup: { spawnError: new Error("spawn ENOENT") }, helper: {} });
		await assert.rejects(broken.client.ensureInstalled(), /spawn ENOENT/);
		const twice = await linux({ setup: { hang: true }, helper: {} });
		const pending = twice.client.ensureInstalled();
		await vi.waitFor(() => assert.equal(twice.setups.length, 1));
		twice.setups[0].fail(new Error("first"));
		twice.setups[0].exit(9);
		await assert.rejects(pending, /^Error: first$/);
	});

	test("a non-Error setup failure is stringified", async () => {
		const { client } = await linux({ setup: () => {
			throw "string failure";
		}, helper: {} });
		await assert.rejects(client.ensureInstalled(), /^Error: string failure$/);
	});

	test("aborting during setup kills it and rejects the caller", async () => {
		const { client, spawn, setups } = await linux({ setup: { hang: true }, helper: {} });
		const controller = new AbortController();
		const waiting = client.ensureInstalled(controller.signal);
		await vi.waitFor(() => assert.equal(setups.length, 1));
		controller.abort();
		await assert.rejects(waiting, /Operation aborted\./);
		assert.equal(spawn.calls.length, 1, "no further spawns");
		await assert.rejects(client.ensureInstalled(AbortSignal.abort()), /Operation aborted\./);
	});

	test("dispose is terminal: later calls fail fast without spawning", async () => {
		install();
		const { client, spawn } = await linux({ helper: { engine: linuxEngine({}) } });
		client.dispose();
		await assert.rejects(client.ensureInstalled(), /Linux helper closed because the Pi session ended\./);
		await assert.rejects(client.command("look"), /Linux helper closed/);
		assert.equal(spawn.calls.length, 0);
	});

	test("dispose during the install probe aborts it without a second helper", async () => {
		install();
		const engine = linuxEngine({ diagnostics: silent() });
		const { client, spawn } = await linux({ helper: { engine } });
		const pending = client.ensureInstalled();
		await vi.waitFor(() => assert.equal(engine.requests.length, 1));
		client.dispose();
		await assert.rejects(pending, /Linux helper closed because the Pi session ended\./);
		assert.equal(helperSpawns(spawn).length, 1);
	});

	test("dispose during setup aborts it and spawns nothing", async () => {
		const { client, spawn, setups } = await linux({ setup: { hang: true }, helper: {} });
		const pending = client.ensureInstalled();
		await vi.waitFor(() => assert.equal(setups.length, 1));
		client.dispose();
		await assert.rejects(pending, /Linux helper closed because the Pi session ended\./);
		assert.deepEqual(setups[0].signals, ["SIGTERM"]);
		assert.equal(helperSpawns(spawn).length, 0);
	});

	test("startProcess after dispose is refused", async () => {
		install();
		const { client } = await linux({ helper: { engine: linuxEngine({}) } });
		await client.ensureInstalled();
		client.dispose();
		await assert.rejects(client.startProcess(), /Linux helper closed because the Pi session ended\./);
	});

	test("frames replies split across chunks, ignores blank lines, garbage and unknown ids", async () => {
		install();
		const engine = linuxEngine({
			look: split(ok({ roots: [1, 2, 3] }), 4, 1),
			noise: (request) => raw(`\n   \n{not json\n${JSON.stringify({ protocolVersion: 4, id: "stranger", ok: true, result: {} })}\n${JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result: "after noise" })}\n`),
		});
		const { client } = await linux({ helper: { engine } });
		assert.deepEqual(await client.command("look"), { roots: [1, 2, 3] });
		assert.equal(await client.command("noise"), "after noise");
	});

	test("error replies carry message and code; defaults apply when missing", async () => {
		install();
		const engine = linuxEngine({ denied: fail("not allowed", "permission_denied"), bare: body({ ok: false }) });
		const { client } = await linux({ helper: { engine } });
		await assert.rejects(client.command("denied"), (error) => error.message === "not allowed" && error.code === "permission_denied");
		await assert.rejects(client.command("bare"), (error) => error.message === "Linux helper command failed." && error.code === undefined);
		await assert.rejects(client.command("missing"), (error) => error.code === "unsupported_command" && error.message === "Unknown command 'missing'");
	});

	test("a reply from another protocol version names both versions and the restart hint", async () => {
		install();
		const engine = linuxEngine({ old: withProtocol(3), unversioned: (request) => raw(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`) });
		const { client } = await linux({ helper: { engine } });
		await assert.rejects(client.command("old"), /Linux helper protocol mismatch: expected 4, got 3\. Restart Pi to use the installed helper\./);
		await assert.rejects(client.command("unversioned"), /expected 4, got unknown\./);
	});

	test("a command with no reply times out and a late reply is ignored", async () => {
		install();
		const engine = linuxEngine({ hang: silent() });
		const { client, children } = await linux({ helper: { engine } });
		await assert.rejects(client.command("hang", {}, { timeoutMs: 30 }), /Helper command 'hang' timed out after 30ms\./);
		children[0].stdout.write(`${JSON.stringify({ protocolVersion: 4, id: engine.requests.at(-1).id, ok: true, result: {} })}\n`);
		engine.script("hang", ok("again"));
		assert.equal(await client.command("hang"), "again");
	});

	test("default command timeout is 15s", async () => {
		install();
		const engine = linuxEngine({ hang: silent() });
		const { client } = await linux({ helper: { engine } });
		await client.ensureInstalled();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const outcome = assert.rejects(client.command("hang"), /timed out after 15000ms\./);
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"), { interval: 1 });
		await vi.advanceTimersByTimeAsync(15_000);
		await outcome;
	});

	test("aborting a command rejects it", async () => {
		install();
		const engine = linuxEngine({ hang: silent() });
		const { client } = await linux({ helper: { engine } });
		const controller = new AbortController();
		const pending = client.command("hang", {}, { signal: controller.signal });
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		controller.abort();
		await assert.rejects(pending, /Operation aborted\./);
	});

	test("an abort signal is detached once the command settles, on every path", async () => {
		install();
		const { client } = await linux({ helper: { engine: linuxEngine({ look: ok(1), nope: fail("no", "x"), hang: silent() }) } });
		const listeners = (signal) => getEventListeners(signal, "abort").length;
		const controller = new AbortController();
		assert.equal(await client.command("look", {}, { signal: controller.signal }), 1);
		assert.equal(listeners(controller.signal), 0, "after success");
		await assert.rejects(client.command("nope", {}, { signal: controller.signal }), /no/);
		assert.equal(listeners(controller.signal), 0, "after an error reply");
		await assert.rejects(client.command("hang", {}, { signal: controller.signal, timeoutMs: 20 }), /timed out/);
		assert.equal(listeners(controller.signal), 0, "after a timeout");
	});

	test("aborting while waiting for a shared helper start rejects only that caller", async () => {
		install();
		const engine = linuxEngine({ look: ok(1) });
		const hold = {};
		let spawned = 0;
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }, spawned++ ? hold : undefined) });
		await client.command("look");
		children[0].exit(0);
		const controller = new AbortController();
		const aborted = client.command("look", {}, { signal: controller.signal });
		const other = client.command("look");
		await vi.waitFor(() => assert.equal(helperSpawns(spawn).length, 2), { interval: 1 });
		controller.abort();
		await assert.rejects(aborted, /Operation aborted\./);
		hold.release();
		assert.equal(await other, 1);
		assert.equal(helperSpawns(spawn).length, 2, "both callers shared one start");
	});

	test("a failed stdin write rejects the command with the write error", async () => {
		install();
		const { client, children } = await linux({ helper: (list) => realisticChild(list, { engine: linuxEngine({ look: ok(1) }) }) });
		await client.command("look");
		children[0].stdin.destroy();
		await assert.rejects(client.command("look"), (error) => error.code === "ERR_STREAM_DESTROYED");
	});

	test("a stdin error on the live child rejects in-flight commands and drops it", async () => {
		install();
		const engine = linuxEngine({ hang: silent(), look: ok(1) });
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		const pending = client.command("hang");
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].stdin.emit("error", new Error("EPIPE"));
		await assert.rejects(pending, /^Error: EPIPE$/);
		assert.deepEqual(children[0].signals, ["SIGTERM"]);
		assert.equal(await client.command("look"), 1);
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("a non-Error probe failure is stringified in the rejection", async () => {
		install();
		const engine = linuxEngine({ diagnostics: silent() });
		const { client, children } = await linux({ setup: { exitCode: 1 }, helper: (list) => realisticChild(list, { engine }) });
		const pending = client.ensureInstalled();
		await vi.waitFor(() => assert.equal(engine.requests.length, 1));
		children[0].stdin.emit("error", "pipe closed");
		await assert.rejects(pending, /was rejected: pipe closed\./);
	});

	test("dispose while the executable check is in flight stops ensureInstalled (checked helper present)", async () => {
		install();
		const { client } = await linux({ helper: { engine: linuxEngine({}) } });
		await client.ensureInstalled();
		const present = client.ensureInstalled();
		client.dispose();
		await assert.rejects(present, /Linux helper closed because the Pi session ended\./);
	});

	test("dispose while the executable check finds the checked helper gone stops ensureInstalled", async () => {
		install();
		const { client } = await linux({ helper: { engine: linuxEngine({}) } });
		await client.ensureInstalled();
		rmSync(helperPath);
		const gone = client.ensureInstalled();
		client.dispose();
		await assert.rejects(gone, /Linux helper closed because the Pi session ended\./);
	});

	test("a stdin error on a replaced child leaves the live child and its commands alone", async () => {
		install();
		const engine = linuxEngine({ look: ok(1), hang: silent() });
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		await client.command("look");
		children[0].kill();
		await client.command("look");
		const pending = client.command("hang", {}, { timeoutMs: 100 });
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].stdin.emit("error", new Error("late"));
		await assert.rejects(pending, /Helper command 'hang' timed out after 100ms\./);
		assert.deepEqual(children[1].signals, [], "the live child was not discarded");
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("child exit with a command in flight rejects it with the exit code", async () => {
		install();
		const engine = linuxEngine({ hang: silent() });
		const { client, children } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		const pending = client.command("hang");
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].exit(7);
		await assert.rejects(pending, /Linux helper exited with code 7\./);
	});

	test("child killed by a signal reports the signal; unknown code is reported as such", async () => {
		install();
		const engine = linuxEngine({ hang: silent() });
		const { client, children } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		const first = client.command("hang");
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].emit("exit", null, "SIGKILL");
		await assert.rejects(first, /Linux helper exited on SIGKILL\./);
		const second = client.command("hang");
		await vi.waitFor(() => assert.equal(children.length, 2));
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[1].emit("exit", null, null);
		await assert.rejects(second, /Linux helper exited with code unknown\./);
	});

	test("a helper that drops the connection mid-command rejects with its exit code", async () => {
		install();
		const engine = linuxEngine({ crash: drop() });
		const { client } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		await assert.rejects(client.command("crash"), /Linux helper exited with code 1\./);
	});

	test("a runtime child error rejects in-flight commands and the next command respawns", async () => {
		install();
		const engine = linuxEngine({ hang: silent(), look: ok(1) });
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		const pending = client.command("hang");
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].fail(new Error("pipe broke"));
		await assert.rejects(pending, /^Error: pipe broke$/);
		assert.equal(await client.command("look"), 1);
		assert.equal(helperSpawns(spawn).length, 2);
	});

	test("stale exit and error events from a replaced child leave the live child and its commands alone", async () => {
		install();
		const engine = linuxEngine({ hang: silent(), look: ok(1) });
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }) });
		await client.command("look");
		children[0].exit(0);
		await client.command("look");
		const pending = client.command("hang", {}, { timeoutMs: 100 });
		await vi.waitFor(() => assert.equal(engine.requests.at(-1).cmd, "hang"));
		children[0].emit("exit", 1, null);
		children[0].emit("error", new Error("stale"));
		await assert.rejects(pending, /Helper command 'hang' timed out after 100ms\./);
		assert.equal(helperSpawns(spawn).length, 2);
		assert.equal(await client.command("look"), 1);
		assert.equal(helperSpawns(spawn).length, 2, "the live child was never cleared");
	});

	test("a helper that fails to spawn rejects the command with the spawn error", async () => {
		install();
		const { client } = await linux({ helper: { spawnError: new Error("EACCES") } });
		await assert.rejects(client.command("look"), /EACCES/);
	});

	test("concurrent commands during a respawn share one new child", async () => {
		install();
		const engine = linuxEngine({ look: ok(1) });
		const hold = {};
		let spawned = 0;
		const { client, children, spawn } = await linux({ helper: (list) => realisticChild(list, { engine }, spawned++ ? hold : undefined) });
		await client.command("look");
		children[0].exit(0);
		const both = Promise.all([client.command("look"), client.command("look")]);
		await vi.waitFor(() => assert.equal(helperSpawns(spawn).length, 2), { interval: 1 });
		await vi.waitFor(() => assert.ok(hold.release), { interval: 1 });
		hold.release();
		assert.deepEqual(await both, [1, 1]);
		assert.equal(helperSpawns(spawn).length, 2);
	});
});
