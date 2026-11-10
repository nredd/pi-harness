import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { testing } from "../src/bridge.ts";

const { managedBrowserNeedsHeadless, managedBrowserArgs } = testing;
const BASE = ["--remote-debugging-port=9222", "--user-data-dir=/tmp/profile", "--no-first-run", "--no-default-browser-check"];
const OPTS = { remoteDebuggingPort: 9222, userDataDir: "/tmp/profile", url: "https://example.com" };

describe("managed browser headless detection (upstream #104)", () => {
	beforeEach(() => {
		vi.stubEnv("DISPLAY", "");
		vi.stubEnv("WAYLAND_DISPLAY", "");
		vi.stubEnv("PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS", "");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	/**
	 * Pretend to run on another platform.
	 * @param {string} value `process.platform` value.
	 * @returns {object} The spy, restored by `vi.restoreAllMocks`.
	 */
	const platform = (value) => vi.spyOn(process, "platform", "get").mockReturnValue(value);

	test("linux without a display runs headless", () => {
		platform("linux");
		assert.equal(managedBrowserNeedsHeadless(), true);
		vi.spyOn(process, "getuid").mockReturnValue(1000);
		assert.deepEqual(managedBrowserArgs(OPTS), [...BASE, "--headless=new", "--disable-gpu", OPTS.url]);
	});

	test("root additionally gets --no-sandbox", () => {
		platform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(0);
		assert.deepEqual(managedBrowserArgs(OPTS), [...BASE, "--headless=new", "--disable-gpu", "--no-sandbox", OPTS.url]);
	});

	test("DISPLAY or WAYLAND_DISPLAY keeps the browser windowed", () => {
		platform("linux");
		vi.stubEnv("DISPLAY", ":0");
		assert.equal(managedBrowserNeedsHeadless(), false);
		assert.deepEqual(managedBrowserArgs(OPTS), [...BASE, OPTS.url]);
		vi.stubEnv("DISPLAY", "");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		assert.equal(managedBrowserNeedsHeadless(), false);
	});

	test("macOS and Windows always have a desktop session", () => {
		for (const value of ["darwin", "win32"]) {
			platform(value);
			assert.equal(managedBrowserNeedsHeadless(), false, value);
		}
	});

	test("explicit override wins in both directions", () => {
		platform("linux");
		vi.stubEnv("DISPLAY", ":0");
		for (const value of ["1", "true", "TRUE"]) {
			vi.stubEnv("PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS", value);
			assert.equal(managedBrowserNeedsHeadless(), true, value);
		}
		vi.stubEnv("DISPLAY", "");
		for (const value of ["0", "false"]) {
			vi.stubEnv("PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS", value);
			assert.equal(managedBrowserNeedsHeadless(), false, value);
		}
	});
});
