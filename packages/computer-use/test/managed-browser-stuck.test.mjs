// A managed browser that survives SIGKILL is reported and its profile is still removed (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({ children: /** @type {import('node:child_process').ChildProcess[]} */ ([]) }));

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal();
	return { ...original, spawn: vi.fn((...args) => {
		const child = original.spawn(...args);
		spawned.children.push(child);
		return child;
	}) };
});

const { shutdownComputerUseSession, testing } = await import("../src/bridge.ts");
const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));

describe.skipIf(process.platform === "win32")("managed browser that outlives SIGKILL", () => {
	let scratch;

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cu-stuck-"));
		vi.stubEnv("TMPDIR", scratch);
		vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
		vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	test("shutdown gives up after SIGTERM and SIGKILL both go unanswered, and still removes the profile", async () => {
		await testing.performLaunchBrowser({});
		const child = spawned.children.at(-1);
		const realKill = child.kill.bind(child);
		const signals = [];
		child.kill = (signal) => {
			signals.push(signal);
			return true;
		};
		const { profile } = JSON.parse(fs.readFileSync(path.join(scratch, "launch.json"), "utf8"));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let finished = false;
		const shutdown = shutdownComputerUseSession().then(() => {
			finished = true;
		});
		for (let tick = 0; tick < 400 && !finished; tick += 1) {
			await vi.advanceTimersByTimeAsync(100);
			await new Promise((resolve) => setImmediate(resolve));
		}
		vi.useRealTimers();
		try {
			await shutdown;
			assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
			assert.equal(fs.existsSync(profile), false, "the profile is removed even though the browser never exited");
		} finally {
			realKill("SIGKILL");
		}
	});
});
