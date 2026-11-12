// `launch_browser` after the browser is up: no page to observe, or a page that cannot be observed (nredd/pi-harness#712, Refs #645).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

vi.mock("../src/cdp.ts", async (importOriginal) => {
	const original = await importOriginal();
	return { ...original, listCdpPageContexts: vi.fn(original.listCdpPageContexts), cdpSnapshotForContext: vi.fn(original.cdpSnapshotForContext) };
});

const { listCdpPageContexts, cdpSnapshotForContext } = await import("../src/cdp.ts");
const { shutdownComputerUseSession, testing } = await import("../src/bridge.ts");
const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));

describe.skipIf(process.platform === "win32")("launch_browser observation after start", () => {
	let scratch;

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cu-observe-"));
		vi.stubEnv("TMPDIR", scratch);
		vi.stubEnv("FAKE_BROWSER_LOG", path.join(scratch, "launch.json"));
		vi.stubEnv("PI_COMPUTER_USE_CHROME_EXECUTABLE", FAKE_BROWSER);
		vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await shutdownComputerUseSession();
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	test("a browser that lists no page is an error", async () => {
		vi.mocked(listCdpPageContexts).mockResolvedValueOnce([]);
		await assert.rejects(testing.performLaunchBrowser({}), /^Error: Managed browser launched without a CDP page context\.$/);
	});

	test("a page that cannot be snapshotted is an error", async () => {
		vi.mocked(cdpSnapshotForContext).mockResolvedValueOnce(undefined);
		await assert.rejects(testing.performLaunchBrowser({}), /^Error: Managed browser page could not be observed after launch\.$/);
	});
});
