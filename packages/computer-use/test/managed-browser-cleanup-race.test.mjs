// Real fake-browser processes and disposable profiles only; pause actual rm at its filesystem boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { within } from "../tests/fixtures/check-async.mjs";

const gate = vi.hoisted(() => ({
	target: "",
	calls: 0,
	release: undefined,
	entered: undefined,
	outcomes: [],
	spawnParent: "",
	spawnError: undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		rm: async (...args) => {
			if (String(args[0]) === gate.target) {
				gate.calls++;
				if (gate.calls === 1) {
					gate.entered();
					await new Promise((resolve) => {
						gate.release = resolve;
					});
				}
			}
			try {
				const result = await actual.rm(...args);
				gate.outcomes.push({ path: String(args[0]), exists: fs.existsSync(args[0]) });
				return result;
			} catch (error) {
				gate.outcomes.push({ path: String(args[0]), exists: fs.existsSync(args[0]), error });
				throw error;
			}
		},
	};
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		spawn: (...args) => {
			if (gate.spawnParent) fs.chmodSync(gate.spawnParent, 0o555);
			try {
				return actual.spawn(...args);
			} catch (error) {
				gate.spawnError = error;
				throw error;
			}
		},
	};
});

import { shutdownComputerUseSession, testing } from "../src/bridge.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
let scratch;
let shutdown;
afterEach(async () => {
	gate.release?.();
	try {
		await within(Promise.allSettled([shutdown]), "pending profile removal");
		await within(shutdownComputerUseSession(), "test session shutdown");
	} finally {
		vi.unstubAllEnvs();
		if (scratch) {
			fs.chmodSync(scratch, 0o700);
			fs.rmSync(scratch, { recursive: true, force: true });
		}
		gate.outcomes = [];
		gate.spawnParent = "";
		gate.spawnError = undefined;
		gate.target = "";
		gate.entered = undefined;
		gate.release = undefined;
		shutdown = undefined;
	}
});

/** Launch the existing POSIX fake-browser executable in an owned temporary parent. */
async function launch() {
	scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cu-owned-race-")));
	const log = path.join(scratch, "launch.json");
	vi.stubEnv("TMPDIR", scratch);
	vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", executable);
	vi.stubEnv("FAKE_BROWSER_LOG", log);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
	await within(testing.performLaunchBrowser({}), "fake browser launch");
	const { profile } = JSON.parse(fs.readFileSync(log, "utf8"));
	assert.equal(path.dirname(profile), scratch);
	assert.ok(fs.existsSync(profile));
	gate.target = profile;
	gate.calls = 0;
	return profile;
}

/** Start real shutdown and wait until its first asynchronous removal reaches the barrier. */
async function startCleanup() {
	const entered = new Promise((resolve) => {
		gate.entered = resolve;
	});
	shutdown = shutdownComputerUseSession();
	await within(entered, "first actual profile removal");
}

test.skipIf(process.platform === "win32")("close and shutdown share the real temporary-profile removal", async () => {
	const profile = await launch();
	await startCleanup();
	// Let the close handler and lifecycle continuation run while the first actual rm is paused.
	for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
	const concurrentCalls = gate.calls;
	gate.release();
	await within(shutdown, "shared profile cleanup");
	assert.equal(concurrentCalls, 1, "one temporary profile must never have concurrent removals");
	assert.equal(fs.existsSync(profile), false, "the actual disposable profile is removed");
	assert.deepEqual(
		gate.outcomes.filter((outcome) => outcome.path === profile),
		[{ path: profile, exists: false }],
	);
});

test.skipIf(process.platform === "win32")(
	"exit cleanup during an in-flight removal preserves unrelated data",
	async () => {
		const profile = await launch();
		const other = path.join(scratch, "unrelated");
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, "marker"), "preserve");
		await startCleanup();
		testing.removeProfileDirsOnExit();
		assert.equal(fs.existsSync(profile), false, "synchronous exit cleanup removes the owned directory");
		assert.equal(fs.readFileSync(path.join(other, "marker"), "utf8"), "preserve");
		gate.release();
		await within(shutdown, "late asynchronous removal after exit cleanup");
		assert.equal(fs.existsSync(profile), false);
		assert.equal(fs.readFileSync(path.join(other, "marker"), "utf8"), "preserve");
	},
);

test.skipIf(process.platform === "win32")(
	"failed shared removal stays tracked for synchronous exit retry",
	async () => {
		const profile = await launch();
		await startCleanup();
		for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
		fs.chmodSync(scratch, 0o555);
		try {
			assert.throws(() => fs.accessSync(scratch, fs.constants.W_OK), "requires a non-writable parent");
			gate.release();
			await within(shutdown, "failed shared cleanup");
			assert.equal(gate.calls, 1);
			const [outcome] = gate.outcomes.filter((entry) => entry.path === profile);
			assert.equal(outcome.error.code, "EACCES");
			assert.equal(outcome.exists, true, "the failed actual removal retained the directory");
		} finally {
			fs.chmodSync(scratch, 0o700);
		}
		testing.removeProfileDirsOnExit();
		assert.equal(fs.existsSync(profile), false, "exit cleanup retries the failed shared attempt");
	},
);

test.skipIf(process.platform === "win32")(
	"a failed real spawn preserves error identity when profile cleanup also fails",
	async () => {
		scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cu-owned-spawn-")));
		vi.stubEnv("TMPDIR", scratch);
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", executable);
		vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
		gate.spawnParent = scratch;
		try {
			await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\u0000" }), (error) => {
				assert.equal(error, gate.spawnError, "cleanup must not replace the actual spawn error");
				assert.equal(error.code, "ERR_INVALID_ARG_VALUE");
				return true;
			});
			assert.equal(gate.outcomes.length, 1);
			assert.equal(gate.outcomes[0].error.code, "EACCES");
			assert.equal(gate.outcomes[0].exists, true);
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "");
		} finally {
			fs.chmodSync(scratch, 0o700);
		}
	},
);
