// A persistent managed browser that survives SIGKILL keeps its profile locked (#674).
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";

const spawned = vi.hoisted(() => ({ children: [] as ChildProcess[] }));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: vi.fn((...args: Parameters<typeof original.spawn>) => {
			const child = original.spawn(...args);
			spawned.children.push(child);
			return child;
		}),
	};
});

const { shutdownComputerUseSession, testing } = await import("../src/bridge.ts");
const { loadComputerUseConfig } = await import("../src/config.ts");
const FAKE_BROWSER = fileURLToPath(new URL("../test/fixtures/fake-browser.mjs", import.meta.url));
let scratch: string;

beforeEach(() => {
	// Platform seam: POSIX validation runs on every host.
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "pi-cu-persistent-stuck-"));
	vi.stubEnv("TMPDIR", scratch);
	vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
	vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(scratch, { recursive: true, force: true });
});

test("a persistent browser that survives SIGKILL keeps its profile locked", async () => {
	const profile = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "persistent-")));
	const agent = path.join(scratch, "agent");
	fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
	fs.writeFileSync(
		path.join(agent, "extensions/pi-computer-use.json"),
		JSON.stringify({ managed_browser_profile: profile }),
	);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	loadComputerUseConfig(scratch);
	await testing.performLaunchBrowser({});
	const child = spawned.children.at(-1) as ChildProcess;
	const realKill = child.kill.bind(child);
	child.kill = () => true;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const shutdown = assert.rejects(shutdownComputerUseSession(), /did not stop/);
	try {
		for (let tick = 0; tick < 120; tick++) {
			await vi.advanceTimersByTimeAsync(100);
			await new Promise((resolve) => setImmediate(resolve));
		}
		await shutdown;
		assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
	} finally {
		vi.useRealTimers();
		const closed = new Promise((resolve) => child.once("close", resolve));
		realKill("SIGKILL");
		await closed;
		loadComputerUseConfig(scratch);
	}
});
