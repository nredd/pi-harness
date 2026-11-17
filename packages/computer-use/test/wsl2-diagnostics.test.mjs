import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { truncateSync } from "node:fs";
import fs, { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { platformBackendForRuntime } from "../src/platform/index.ts";
import { wslProbe } from "../src/platform/linux/wsl.ts";
import { bounded, WslHelperClient, wslHostHelperConfig } from "../src/platform/linux/wsl-helper.ts";
import { createWindowsBackend } from "../src/platform/windows/backend.ts";

const fsFault = vi.hoisted(() => ({ realpath: undefined, mkdir: undefined, lstat: undefined, rmdir: undefined }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original();
	return {
		...actual,
		realpath: (...args) => (fsFault.realpath ? fsFault.realpath(...args) : actual.realpath(...args)),
		mkdir: (...args) => (fsFault.mkdir ? fsFault.mkdir(...args) : actual.mkdir(...args)),
		lstat: (...args) => (fsFault.lstat ? fsFault.lstat(...args) : actual.lstat(...args)),
		rmdir: (...args) => (fsFault.rmdir ? fsFault.rmdir(...args) : actual.rmdir(...args)),
	};
});

const spawnFault = vi.hoisted(() => ({ refuse: false, frames: [], children: [] }));

// Re-enter Node for the synthetic fixture on every OS. Verify the production argv before substituting it.
vi.mock("node:child_process", async (original) => {
	const actual = await original();
	return {
		...actual,
		spawn(command, args, options) {
			if (!command.endsWith("fixture.exe")) return actual.spawn(command, args, options);
			assert.deepEqual(args, []);
			assert.equal(options.shell, false);
			if (spawnFault.refuse) throw Object.assign(new Error("Synthetic interop execution refused"), { code: "ENOEXEC" });
			const child = actual.spawn(process.execPath, [command], options);
			spawnFault.children.push(child);
			const write = child.stdin.write.bind(child.stdin);
			vi.spyOn(child.stdin, "write").mockImplementation((frame, ...rest) => {
				spawnFault.frames.push(JSON.parse(frame));
				return write(frame, ...rest);
			});
			return child;
		},
	};
});

// Real synthetic subprocess, never a PE executable, WSL interop or a native desktop adapter.
const fixture = `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
 const r = JSON.parse(line);
 if (r.cmd === 'hang') return;
 if (r.cmd === 'stderr') process.stderr.write('synthetic diagnostic');
 if (r.cmd === 'keepalive') setInterval(() => {}, 1000);
 if (r.cmd === 'exit') return process.exit(0);
 if (r.cmd === 'invalid') return process.stdout.write('not-json\\n');
 if (r.cmd === 'invalidUtf8') return process.stdout.write(Buffer.concat([
  Buffer.from(JSON.stringify({ protocolVersion: 4, id: r.id, ok: true, result: '' }).slice(0, -2)),
  Buffer.from([0xff]), Buffer.from('"}\\n'),
 ]));
 if (r.cmd === 'overflow') return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
 if (r.cmd === 'delay') await new Promise(resolve => setTimeout(resolve, 80));
 const reply = { protocolVersion: 4, id: r.id, ok: true, result: { pid: process.pid, cmd: r.cmd, args: r.args } };
 if (r.cmd === 'diagnostics') reply.result = { protocolVersion: 4, architectureVersion: 1, invariants: ['state-scoped-observations', 'bounded-observation-history', 'multi-root-forest', 'progressive-disclosure', 'atomic-physical-input', 'concurrent-requests', 'transactional-batching'], capabilities: ['fail-closed-live-target-v1'] };
 if (r.cmd === 'wrongId') reply.id = 'foreign';
 if (r.cmd === 'wrongVersion') reply.protocolVersion = 3;
 if (r.cmd === 'missingResult') delete reply.result;
 if (r.cmd === 'successWithError') reply.error = null;
 if (r.cmd.startsWith('error')) {
  reply.ok = false; delete reply.result;
  reply.error = { code: 'fixture_refusal', message: 'private app title' };
  if (r.cmd === 'errorNoObject') delete reply.error;
  if (r.cmd === 'errorNoCode') delete reply.error.code;
  if (r.cmd === 'errorEmptyCode') reply.error.code = '';
  if (r.cmd === 'errorCodeNumber') reply.error.code = 7;
  if (r.cmd === 'errorNoMessage') delete reply.error.message;
  if (r.cmd === 'errorMessageNumber') reply.error.message = 7;
  if (r.cmd === 'errorWithResult') reply.result = {};
 }
 if (['permission_denied', 'session_mismatch', 'screen_locked'].includes(r.cmd)) {
  reply.ok = false; delete reply.result; reply.error = { code: r.cmd, message: 'private fixture detail' };
 }
 const wire = JSON.stringify(reply) + '\\n';
 if (r.cmd === 'split') { process.stdout.write(wire.slice(0, 12)); setTimeout(() => process.stdout.write(wire.slice(12)), 5); }
 else if (r.cmd === 'extra') process.stdout.write(wire + wire);
 else if (r.cmd === 'replyExit') process.stdout.write(wire, () => process.exit(0));
 else process.stdout.write(wire);
});
`;

async function withClient(work, source = fixture) {
	spawnFault.frames = [];
	spawnFault.children = [];
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wsl-host-fixture-")));
	const helper = path.join(root, "fixture.exe");
	await writeFile(helper, source, { mode: 0o700 });
	const config = {
		path: helper,
		sha256: createHash("sha256").update(source).digest("hex"),
		lock: path.join(root, "input-lock"),
	};
	const client = new WslHelperClient(config);
	try {
		await work(client, config);
	} finally {
		client.dispose();
		await rm(root, { recursive: true, force: true });
	}
}

for (const capabilities of [
	undefined,
	null,
	"fail-closed-live-target-v1",
	{},
	[],
	["future-v2"],
	["fail-closed-live-target-v1", 1],
]) {
	test(`WSL refuses incompatible diagnostics ${JSON.stringify(capabilities)} before any queued mutation`, async () => {
		const source = fixture.replace(
			"capabilities: ['fail-closed-live-target-v1']",
			`capabilities: ${JSON.stringify(capabilities)}`,
		);
		await withClient(async (client, config) => {
			const backend = createWindowsBackend(client);
			const results = await Promise.allSettled([
				backend.ensureReady({}, { lastPermissionCheckAt: 0 }),
				client.command("actBatch", { actions: [{ action: "click" }] }),
				client.command("act", { action: "typeText" }),
			]);
			assert.ok(results.every((result) => result.status === "rejected"));
			assert.ok(results.some((result) => /fail-closed-live-target-v1/.test(result.reason.message)));
			assert.deepEqual(
				spawnFault.frames.map((frame) => frame.cmd),
				["diagnostics"],
			);
			await assert.rejects(stat(config.lock), { code: "ENOENT" });
			assert.equal(client.child, undefined);
			await vi.waitFor(() =>
				assert.ok(spawnFault.children.every((child) => child.exitCode !== null || child.signalCode !== null)),
			);
			await assert.rejects(client.command("observe"), /closed/);
			assert.equal(spawnFault.children.length, 1);
		}, source);
	});
}

test("WSL readiness refusal cannot authorize a concurrent mutation while acknowledged cleanup is stalled", async () => {
	const source = fixture.replace("capabilities: ['fail-closed-live-target-v1']", "capabilities: []");
	await withClient(async (client, config) => {
		const actual = await vi.importActual("node:fs/promises");
		let release;
		let removals = 0;
		fsFault.rmdir = async (...args) => {
			await actual.rmdir(...args);
			if (++removals === 1)
				await new Promise((resolve) => {
					release = resolve;
				});
		};
		try {
			const pending = client.command("observe").catch((error) => error);
			await vi.waitFor(() => assert.equal(typeof release, "function"));
			await assert.rejects(client.command("actBatch"), /closed/);
			await assert.rejects(stat(config.lock), { code: "ENOENT" });
			assert.deepEqual(
				spawnFault.frames.map((frame) => frame.cmd),
				["diagnostics"],
			);
			release();
			assert.match((await pending).message, /fail-closed-live-target-v1/);
			await assert.rejects(client.command("observe"), /closed/);
			assert.equal(spawnFault.children.length, 1);
		} finally {
			fsFault.rmdir = undefined;
			release?.();
		}
	}, source);
});

test("WSL accepts the exact capability with well-formed future strings and serializes concurrent readiness", async () => {
	const source = fixture.replace("['fail-closed-live-target-v1']", "['future-v2', 'fail-closed-live-target-v1']");
	await withClient(async (client) => {
		const backend = createWindowsBackend(client);
		await Promise.all([
			backend.ensureReady({}, { lastPermissionCheckAt: 0 }),
			client.command("actBatch", { actions: [{ action: "click" }] }),
		]);
		assert.equal(spawnFault.frames[0].cmd, "diagnostics");
		assert.equal(spawnFault.frames.filter((frame) => frame.cmd === "actBatch").length, 1);
		assert.equal(spawnFault.children.length, 1);
	}, source);
});

test("WSL host opt-in validates explicit identity and refuses CI without enabling interop", () => {
	const saved = { ...wslProbe };
	let env = {};
	Object.assign(wslProbe, { env: () => env, hasInteropEntry: () => false, procVersion: () => "Linux" });
	try {
		assert.equal(wslHostHelperConfig(), undefined);
		assert.equal(platformBackendForRuntime("linux").name, "linux");
		env = { PI_COMPUTER_USE_WSL_HOST: "1" };
		assert.throws(() => wslHostHelperConfig(), /interactive WSL/);
		env.WSL_DISTRO_NAME = "Synthetic";
		assert.throws(() => wslHostHelperConfig(), /HOST_HELPER/);
		for (const bad of [
			"bridge.exe",
			"/tmp/bridge.exe",
			"/mnt/c/../bridge.exe",
			"/mnt/c/./bridge.exe",
			"/mnt/c//bridge.exe",
			"/mnt/c/bridge.exe\n",
			"/mnt/c/bridge.ps1",
		]) {
			env.PI_COMPUTER_USE_WSL_HOST_HELPER = bad;
			assert.throws(() => wslHostHelperConfig(), /HOST_HELPER/);
		}
		env.PI_COMPUTER_USE_WSL_HOST_HELPER = "/mnt/c/Fixture/bridge.exe";
		assert.throws(() => wslHostHelperConfig(), /SHA256/);
		env.PI_COMPUTER_USE_WSL_HOST_SHA256 = "A".repeat(64);
		assert.throws(() => wslHostHelperConfig(), /HOST_LOCK/);
		env.PI_COMPUTER_USE_WSL_HOST_LOCK = "/mnt/c/Fixture/input-lock";
		assert.equal(wslHostHelperConfig().sha256, "a".repeat(64));
		assert.equal(platformBackendForRuntime("linux").name, "windows");
		env.CI = "1";
		assert.throws(() => platformBackendForRuntime("linux"), /never a CI runner/);
	} finally {
		Object.assign(wslProbe, saved);
	}
});

test("WSL transport reuses one process, frames split replies and preserves Windows DPI coordinates", async () => {
	await withClient(async (client, config) => {
		const first = await client.command("split", { x: -1920, y: -100, scaleFactor: 1.5 });
		const second = await client.command("stderr");
		assert.equal(first.pid, second.pid);
		assert.deepEqual(first.args, { x: -1920, y: -100, scaleFactor: 1.5 });
		await assert.rejects(stat(config.lock), { code: "ENOENT" });
		await assert.rejects(
			client.command("error"),
			(e) => e.code === "fixture_refusal" && !e.message.includes("private app title"),
		);
		assert.equal((await client.command("echo")).pid, first.pid);
	});
});

test("interop execution refusal never selects a shell or another executable", async () => {
	await withClient(async (client, config) => {
		spawnFault.refuse = true;
		try {
			await assert.rejects(client.command("echo"), { code: "ENOEXEC" });
			await assert.rejects(stat(config.lock), { code: "ENOENT" });
		} finally {
			spawnFault.refuse = false;
		}
		assert.equal((await client.command("echo")).cmd, "echo");
	});
});

test("native permission and session refusals retain their codes without leaking UI details", async () => {
	await withClient(async (client, config) => {
		for (const code of ["permission_denied", "session_mismatch", "screen_locked"]) {
			await assert.rejects(
				client.command(code),
				(error) => error.code === code && !error.message.includes("private fixture detail"),
			);
			await assert.rejects(stat(config.lock), { code: "ENOENT" });
		}
	});
});

test("two WSL sessions queue on one lease, including complete actBatch requests", async () => {
	await withClient(async (first, config) => {
		const second = new WslHelperClient(config);
		try {
			const order = [];
			const start = first.command("delay").then(() => order.push("first"));
			await vi.waitFor(async () => assert.ok((await stat(config.lock)).isDirectory()));
			await Promise.all([
				start,
				second.command("actBatch", { actions: [{ action: "click" }, { action: "typeText" }] }).then((r) => {
					order.push("second");
					assert.equal(r.args.actions.length, 2);
				}),
			]);
			assert.deepEqual(order, ["first", "second"]);
		} finally {
			second.dispose();
		}
	});
});

test("WSL provenance refuses changed, linked and nonexecutable helpers before spawning", async () => {
	await withClient(async (client, config) => {
		const abort = AbortSignal.abort();
		await assert.rejects(client.ensureInstalled(abort), /aborted/);
		await writeFile(config.path, `${fixture}\n// changed`);
		await assert.rejects(client.command("echo"), /SHA-256 mismatch/);
		await writeFile(config.path, fixture);
		if (process.platform !== "win32") {
			await chmod(config.path, 0o600);
			await assert.rejects(client.command("echo"), /EACCES/);
			await chmod(config.path, 0o700);
			const link = `${config.path}.link`;
			await symlink(config.path, link);
			const linked = new WslHelperClient({ ...config, path: link });
			try {
				await assert.rejects(linked.ensureInstalled(), /without symlinks/);
			} finally {
				linked.dispose();
			}
		}
		const directory = `${config.path}.dir`;
		await mkdir(directory);
		const invalid = new WslHelperClient({ ...config, path: directory });
		try {
			await assert.rejects(invalid.ensureInstalled(), /regular file/);
		} finally {
			invalid.dispose();
		}
	});
});

test("WSL bounds requests and deadlines before execution", async () => {
	await withClient(async (client, config) => {
		for (const timeoutMs of [0, -1, NaN, Infinity, 30001])
			await assert.rejects(client.command("echo", {}, { timeoutMs }), /between 1 and 30000/);
		await assert.rejects(client.command("echo", { text: "x".repeat(1024 * 1024) }), /request exceeded/);
		await assert.rejects(client.command("echo", {}, { signal: AbortSignal.abort() }), /aborted/);
		await mkdir(config.lock);
		await assert.rejects(client.command("echo", {}, { timeoutMs: 50 }), /abort/i);
		assert.ok((await stat(config.lock)).isDirectory());
		await rm(config.lock, { recursive: true });
		assert.equal((await client.command("echo")).cmd, "echo");
	});
});

for (const command of [
	"hang",
	"exit",
	"invalid",
	"invalidUtf8",
	"wrongId",
	"wrongVersion",
	"extra",
	"overflow",
	"missingResult",
	"successWithError",
	"errorNoObject",
	"errorNoCode",
	"errorEmptyCode",
	"errorCodeNumber",
	"errorNoMessage",
	"errorMessageNumber",
	"errorWithResult",
]) {
	test(`WSL retains the lease and closes permanently after uncertain ${command}`, async () => {
		await withClient(async (client, config) => {
			await assert.rejects(client.command(command, {}, { timeoutMs: command === "hang" ? 150 : 3000 }));
			assert.ok((await stat(config.lock)).isDirectory());
			await assert.rejects(client.command("echo"), /closed/);
		});
	});
}

test("WSL abort after send retains the lease; queue overflow cannot deliver work", async () => {
	await withClient(async (client, config) => {
		// An acknowledged echo proves the process is running before the abort case.
		await client.command("echo");
		const controller = new AbortController();
		const pending = client.command("hang", {}, { signal: controller.signal });
		// Wait for acquisition, not an assumed host startup delay.
		for (let attempt = 0; attempt < 100; attempt++) {
			if (
				await stat(config.lock).then(
					() => true,
					() => false,
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		// The client has acquired the lock, then resumed into its send microtask.
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, /retained/);
		assert.ok((await stat(config.lock)).isDirectory());
	});
	await withClient(async (client, config) => {
		await mkdir(config.lock);
		const controller = new AbortController();
		const queued = Array.from({ length: 32 }, () =>
			client.command("echo", {}, { signal: controller.signal }).catch((e) => e),
		);
		await assert.rejects(client.command("echo"), /queue is full/);
		controller.abort();
		assert.equal((await Promise.all(queued)).length, 32);
	});
});

test("WSL closes clean idle children, escalates unreaped children and retains failed-write leases", async () => {
	await withClient(async (client) => {
		await client.command("replyExit");
		await vi.waitFor(() => assert.equal(client.child, undefined));
		await assert.rejects(client.command("echo"), /closed/);
	});
	await withClient(async (client) => {
		await client.command("keepalive");
		const child = client.child;
		const realKill = child.kill.bind(child);
		const kill = vi
			.spyOn(child, "kill")
			.mockImplementation((signal) => (signal === "SIGTERM" ? true : realKill(signal)));
		const closed = new Promise((resolve) => child.once("close", resolve));
		client.dispose();
		await closed;
		assert.deepEqual(
			kill.mock.calls.map(([signal]) => signal),
			["SIGTERM", "SIGKILL"],
		);
	});
	await withClient(async (client, config) => {
		await client.command("echo");
		vi.spyOn(client.child.stdin, "write").mockImplementation((_frame, callback) => {
			callback(new Error("synthetic write refusal"));
			return false;
		});
		await assert.rejects(client.command("echo"), /synthetic write refusal/);
		assert.ok((await stat(config.lock)).isDirectory());
	});
});

test("WSL caps changing executable reads and surfaces lease filesystem failures", async () => {
	await withClient(async (client, config) => {
		const check = client.check.bind(client);
		let checking = 0;
		const seam = vi.spyOn(client, "check").mockImplementation((signal) => {
			check(signal);
			if (++checking === 7) truncateSync(config.path, 65 * 1024 * 1024);
		});
		await assert.rejects(client.ensureInstalled(), /exceeded 64MiB/);
		seam.mockRestore();
		await assert.rejects(client.ensureInstalled(), /at most 64MiB/);
		await writeFile(config.path, fixture);
		const invalid = new WslHelperClient({ ...config, lock: path.join(config.path, "missing", "lease") });
		try {
			await assert.rejects(invalid.command("echo"), /ENOTDIR|ENOENT/);
		} finally {
			invalid.dispose();
		}
	});
});

test("already-aborted bounded wait observes a later rejected operation", async () => {
	const unhandled = vi.fn();
	process.on("unhandledRejection", unhandled);
	let rejectWork;
	const work = new Promise((_resolve, reject) => {
		rejectWork = reject;
	});
	try {
		await assert.rejects(bounded(work, AbortSignal.abort()), /aborted/);
		rejectWork(new Error("late fixture rejection"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled.mock.calls.length, 0);
	} finally {
		process.removeListener("unhandledRejection", unhandled);
	}
});

test("readiness aborts a stalled host verification without starting a helper", async () => {
	await withClient(async (client) => {
		let release;
		fsFault.realpath = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const controller = new AbortController();
		const backend = createWindowsBackend(client);
		try {
			const pending = backend.ensureReady({}, { lastPermissionCheckAt: 0 }, controller.signal).catch((error) => error);
			await vi.waitFor(() => assert.equal(typeof release, "function"));
			controller.abort();
			const outcome = await Promise.race([
				pending,
				new Promise((resolve) => setTimeout(() => resolve("stalled"), 100)),
			]);
			assert.notEqual(outcome, "stalled");
			assert.match(outcome.message, /abort/i);
			assert.equal(client.child, undefined);
			release(client.config.path);
		} finally {
			fsFault.realpath = undefined;
		}
	});
});

test("readiness has a five-second deadline without a caller signal", { timeout: 10_000 }, async () => {
	await withClient(async (client, config) => {
		let release;
		fsFault.realpath = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		try {
			const backend = createWindowsBackend(client);
			await assert.rejects(backend.ensureReady({}, { lastPermissionCheckAt: 0 }), /aborted/);
			assert.equal(client.child, undefined);
			release(config.path);
		} finally {
			fsFault.realpath = undefined;
		}
	});
});

test("cancel during lease identity check never begins a new removal", async () => {
	await withClient(async (client, config) => {
		const actual = await vi.importActual("node:fs/promises");
		let calls = 0;
		let release;
		let removals = 0;
		fsFault.lstat = async (...args) => {
			const result = await actual.lstat(...args);
			if (++calls === 2)
				await new Promise((resolve) => {
					release = resolve;
				});
			return result;
		};
		fsFault.rmdir = async (...args) => {
			removals++;
			return actual.rmdir(...args);
		};
		const controller = new AbortController();
		try {
			const pending = client.command("echo", {}, { signal: controller.signal }).catch((error) => error);
			await vi.waitFor(() => assert.equal(typeof release, "function"));
			controller.abort();
			assert.match((await pending).message, /abort/i);
			release();
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(removals, 0);
			assert.ok((await stat(config.lock)).isDirectory());
		} finally {
			fsFault.lstat = undefined;
			fsFault.rmdir = undefined;
		}
	});
});

test("bounded waits refuse an already-aborted signal", async () => {
	await assert.rejects(bounded(Promise.resolve(), AbortSignal.abort()), /aborted/);
});

test("lease acquisition refuses a replaced non-directory", async () => {
	await withClient(async (client, config) => {
		fsFault.lstat = async () => ({ isDirectory: () => false });
		try {
			await assert.rejects(client.command("echo"), /not a directory/);
			assert.ok((await stat(config.lock)).isDirectory());
		} finally {
			fsFault.lstat = undefined;
		}
	});
});

test("stalled verification and late lease acquisition honor the command deadline", async () => {
	await withClient(async (client, config) => {
		let releaseVerification;
		fsFault.realpath = () =>
			new Promise((resolve) => {
				releaseVerification = resolve;
			});
		try {
			await assert.rejects(client.command("echo", {}, { timeoutMs: 50 }), /aborted/);
			releaseVerification(config.path);
		} finally {
			fsFault.realpath = undefined;
		}
	});
	await withClient(async (client, config) => {
		let releaseLease;
		fsFault.mkdir = () =>
			new Promise((resolve) => {
				releaseLease = resolve;
			});
		try {
			await assert.rejects(client.command("echo", {}, { timeoutMs: 50 }), /aborted/);
			const realFs = await vi.importActual("node:fs/promises");
			await realFs.mkdir(config.lock);
			releaseLease();
			await vi.waitFor(async () => assert.ok((await stat(config.lock)).isDirectory()));
		} finally {
			fsFault.mkdir = undefined;
		}
	});
});

for (const hold of ["effect", "completion"]) {
	test(`cooperating sessions preserve the new lease when old removal holds ${hold}`, async () => {
		await withClient(async (first, config) => {
			const second = new WslHelperClient(config);
			const actual = await vi.importActual("node:fs/promises");
			let release;
			let entered = false;
			let removals = 0;
			fsFault.rmdir = async (...args) => {
				removals++;
				if (hold === "completion") await actual.rmdir(...args);
				entered = true;
				await new Promise((resolve) => {
					release = resolve;
				});
				if (hold === "effect") await actual.rmdir(...args);
			};
			try {
				const firstDone = first.command("echo", {}, { timeoutMs: 400 }).catch((error) => error);
				await vi.waitFor(() => assert.equal(entered, true));
				assert.match((await firstDone).message, /aborted/);
				if (hold === "effect") {
					await assert.rejects(second.command("echo", {}, { timeoutMs: 80 }), /abort/i);
					assert.equal(second.child, undefined);
					release();
					await vi.waitFor(async () => await assert.rejects(stat(config.lock), { code: "ENOENT" }));
				}
				const pending = second.command("hang", {}, { timeoutMs: 500 }).catch((error) => error);
				await vi.waitFor(() => assert.ok(second.reply));
				const owner = await stat(config.lock);
				if (hold === "completion") release();
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal((await stat(config.lock)).ino, owner.ino);
				assert.equal(removals, 1);
				await pending;
				assert.equal((await stat(config.lock)).ino, owner.ino);
			} finally {
				fsFault.rmdir = undefined;
				second.dispose();
			}
		});
	});
}

test("changed lease identity is never removed", async () => {
	await withClient(async (client, config) => {
		const actual = await vi.importActual("node:fs/promises");
		let count = 0;
		fsFault.lstat = async (...args) => {
			const result = await actual.lstat(...args);
			if (++count === 2) return { ...result, ino: result.ino + 1, isDirectory: () => true };
			return result;
		};
		try {
			await assert.rejects(client.command("echo"), /lease changed/);
			assert.ok((await stat(config.lock)).isDirectory());
		} finally {
			fsFault.lstat = undefined;
		}
	});
});

test("disposal during delayed acquisition retains a late lease and refuses concurrent sends", async () => {
	await withClient(async (client, config) => {
		const other = new WslHelperClient(config);
		let releaseLease;
		fsFault.mkdir = () =>
			new Promise((resolve) => {
				releaseLease = resolve;
			});
		try {
			const pending = client.command("echo").catch((error) => error);
			await vi.waitFor(() => assert.equal(typeof releaseLease, "function"));
			client.dispose();
			assert.match((await pending).message, /aborted|closed/);
			const actual = await vi.importActual("node:fs/promises");
			await actual.mkdir(config.lock);
			let drained;
			const drain = new Promise((resolve) => {
				drained = resolve;
			});
			fsFault.lstat = async (...args) => {
				try {
					return await actual.lstat(...args);
				} finally {
					drained();
				}
			};
			releaseLease();
			fsFault.mkdir = undefined;
			await drain;
			await new Promise((resolve) => setImmediate(resolve));
			fsFault.lstat = undefined;
			await assert.rejects(other.command("echo", {}, { timeoutMs: 50 }), /abort/i);
			assert.ok((await stat(config.lock)).isDirectory());
		} finally {
			fsFault.mkdir = undefined;
			fsFault.lstat = undefined;
			other.dispose();
		}
	});
});

test("Windows backend factory delegates bounded UIA and physical batches without Linux coordinate conversion", async () => {
	const calls = [];
	const backend = createWindowsBackend({
		ensureInstalled: async () => {},
		dispose() {},
		command: async (cmd, args, options) => {
			calls.push({ cmd, args, options });
			return { roots: [] };
		},
	});
	await backend.listRoots({});
	await backend.actBatch([{ action: "click", target: { pid: 7 }, params: { x: -900, y: 200 } }], { timeoutMs: 100 });
	await backend.readText({ ref: "@e1", stateId: "synthetic" }, { timeoutMs: 200 });
	await backend.waitFor({ text: "fixture", stateId: "synthetic" }, { timeoutMs: 300 });
	assert.equal(calls[0].cmd, "listRoots");
	assert.equal(calls[1].cmd, "actBatch");
	assert.deepEqual(calls[1].args.actions[0].params, { x: -900, y: 200 });
	assert.equal(calls[2].cmd, "uiaReadText");
	assert.equal(calls[3].options.timeoutMs, 300);
});

const WSL_TEXT = /Windows host windows are not reachable from the WSL2 guest.*nredd\/pi-harness#668/;

test("WSL detection reads the environment and kernel string", async () => {
	const { isWsl, wslNoWindowsHint } = await import("../src/platform/linux/wsl.ts");
	const probe = (env, version = "", interop = false) => ({
		env: () => env,
		procVersion: () => version,
		hasInteropEntry: () => interop,
	});
	assert.equal(isWsl(probe({ WSL_DISTRO_NAME: "Ubuntu" })), true);
	assert.equal(isWsl(probe({ WSL_INTEROP: "/run/WSL/1_interop" })), true);
	assert.equal(isWsl(probe({}, "Linux version 5.15.0-microsoft-standard-WSL2 (gcc)")), true);
	assert.equal(isWsl(probe({}, "Linux version 6.5.0-generic (buildd@lcy02)")), false);
	assert.equal(isWsl(probe({}, "", true)), true);
	assert.equal(isWsl(probe({}, "")), false);
	assert.match(wslNoWindowsHint(probe({ WSL_DISTRO_NAME: "Ubuntu" })) ?? "", WSL_TEXT);
	assert.equal(wslNoWindowsHint(probe({})), undefined);
});

test("Linux backend and find_roots explain empty windows under WSL2", async () => {
	// The host transport cases also load the platform factory; capture this fixture's Linux path afresh.
	vi.resetModules();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-wsl2-"));
	const fakeHelper = path.join(tempDir, "linux-bridge");
	await fs.writeFile(
		fakeHelper,
		`#!/usr/bin/env node
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const rootsFile = process.env.PI_TEST_WSL_ROOTS_FILE;
  const roots = rootsFile && require("node:fs").existsSync(rootsFile) ? JSON.parse(require("node:fs").readFileSync(rootsFile, "utf8")) : [];
  const result = request.cmd === "listRoots" ? { roots } : {};
  process.stdout.write(JSON.stringify({ protocolVersion: 4, id: request.id, ok: true, result }) + "\\n");
});
`,
	);
	await fs.chmod(fakeHelper, 0o755);
	process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH = fakeHelper;
	const rootsFile = path.join(tempDir, "roots.json");
	process.env.PI_TEST_WSL_ROOTS_FILE = rootsFile;
	const { platformBackendForRuntime, currentPlatformBackend } = await import("../src/platform/index.ts");
	const { linuxHelper } = await import("../src/platform/linux/helper.ts");
	const { wslProbe } = await import("../src/platform/linux/wsl.ts");
	const { executeFind } = await import("../src/bridge.ts");
	const realProbe = { ...wslProbe };
	try {
		linuxHelper.installChecked = true;
		const linux = platformBackendForRuntime("linux");

		Object.assign(wslProbe, {
			env: () => ({ WSL_DISTRO_NAME: "Ubuntu" }),
			procVersion: () => "",
			hasInteropEntry: () => false,
		});
		await assert.rejects(() => linux.getFrontmost(), WSL_TEXT);
		assert.match(linux.emptyRootsHint?.() ?? "", WSL_TEXT);

		// WSLg: Linux roots exist but none reports a pid. That is not a host-reachability problem.
		await fs.writeFile(rootsFile, JSON.stringify([{ title: "gedit" }]));
		await assert.rejects(
			() => linux.getFrontmost(),
			(error) => error.message === "No frontmost window was available.",
		);
		await fs.rm(rootsFile);

		// Native Linux keeps the original wording and no hint.
		Object.assign(wslProbe, {
			env: () => ({}),
			procVersion: () => "Linux version 6.5.0-generic",
			hasInteropEntry: () => false,
		});
		await assert.rejects(
			() => linux.getFrontmost(),
			(error) => error.message === "No frontmost window was available.",
		);
		assert.equal(linux.emptyRootsHint?.(), undefined);

		// The shared find_roots path appends the backend hint to its empty-result text.
		const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
		const find = async (params = {}) => {
			const result = await executeFind("t", params, undefined, undefined, ctx);
			return result.content.map((block) => block.text).join("\n");
		};
		Object.assign(currentPlatformBackend, {
			ensureReady: async () => ({
				permissionStatus: { accessibility: true, screenRecording: true },
				lastPermissionCheckAt: Date.now(),
			}),
			listApps: async () => [],
			listRoots: async () => [],
			emptyRootsHint: () => "HINT-FROM-BACKEND",
		});
		assert.match(await find(), /No roots are currently visible to pi-computer-use\..*HINT-FROM-BACKEND/s);
		assert.match(await find({ app: "Teams" }), /No roots matched the supplied filters\..*HINT-FROM-BACKEND/s);
		currentPlatformBackend.emptyRootsHint = () => undefined;
		assert.equal(await find({ app: "Teams" }), "No roots matched the supplied filters.");
		assert.equal(await find(), "No roots are currently visible to pi-computer-use.");
		await linux.shutdown?.();
	} finally {
		delete process.env.PI_TEST_WSL_ROOTS_FILE;
		Object.assign(wslProbe, realProbe);
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
