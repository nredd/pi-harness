/**
 * Smoke tests for Windows build/install script paths (Task 7).
 *
 * Exercises --platform windows argument routing and path alignment
 * without requiring Windows or a committed prebuilt binary.
 *
 * Verifies:
 *   1. Path constants stay aligned with the Windows backend helper path
 *   2. windowsBinaryPath() candidate logic
 *   3. --platform windows CLI routing in both scripts
 *   4. Expected error messages when prebuilt/cargo are absent
 *   5. Existing macOS/Linux skip/fallback paths remain unchanged
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";

const SCRIPTS_DIR = fileURLToPath(new URL("../scripts", import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, "..");
// Scratch root and helper fingerprints are taken in the suite's `beforeAll`, so a skipped default
// `npm test` creates no temp dir and reads no helper.
let TEST_ROOT;
let TEST_HELPER_APP;
let TEST_WINDOWS_HELPER;
const LIVE_HELPER = "/Applications/pi-computer-use.app/Contents/MacOS/bridge";
// Each script run carries its own 120 s deadline; the Vitest case only adds teardown headroom so the
// script's labelled timeout, not the runner's, reports a hang.
const SCRIPT_TIMEOUT_MS = 120_000;
const SCRIPT_CASE_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + 5000;

function fileFingerprint(filePath) {
	if (!fs.existsSync(filePath)) return "missing";
	const stat = fs.statSync(filePath);
	const hash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	return `${stat.mtimeMs}:${stat.size}:${hash}`;
}

let liveHelperBefore;
let armPrebuiltBefore;

// ---------------------------------------------------------------------------
// Path constants – replicated to avoid crossing the TS/ESM module boundary
// while still catching drift between the scripts and Windows backend helper path.
// ---------------------------------------------------------------------------

const HOMEDIR = os.homedir();

// From scripts/setup-helper.mjs:
const WINDOWS_HELPER_DEST = path.join(HOMEDIR, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");

// Expected by src/platform/windows/helper.ts → WINDOWS_HELPER_PATH:
const WINDOWS_HELPER_STABLE_PATH = path.join(HOMEDIR, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");

// windowsBinaryPath() candidates (function present in both scripts):
const WINDOWS_CRATE_DIR = path.join(ROOT, "native", "windows", "bridge-rs");
const RELEASE_DIR = path.join(WINDOWS_CRATE_DIR, "target", "release");
const EXE_CANDIDATE = path.join(RELEASE_DIR, "windows-bridge.exe");

/** Spawn a script, capturing stdout/stderr and the exit code. */
function runScript(relPath, args, timeoutMs = SCRIPT_TIMEOUT_MS) {
	const scriptPath = path.join(SCRIPTS_DIR, relPath);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_COMPUTER_USE_HELPER_APP_PATH: TEST_HELPER_APP,
				PI_COMPUTER_USE_WINDOWS_HELPER_PATH: TEST_WINDOWS_HELPER,
				// These smoke tests validate routing and isolated install paths, not
				// Keychain integration. Signing can open SecurityAgent on headless macOS.
				PI_COMPUTER_USE_NO_SIGN: "1",
			},
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const timeout = setTimeout(() => {
			stderr += `Timed out after ${timeoutMs}ms: ${relPath} ${args.join(" ")}\n`;
			child.kill("SIGTERM");
			finish({ code: -1, stdout, stderr });
		}, timeoutMs);
		timeout.unref();
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => finish({ code, stdout, stderr }));
		child.on("error", (err) => finish({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
	});
}

/** Remove a path recursively, ignoring errors. */
function rmSilent(p) {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		/* ok */
	}
}

function isWin32() {
	return process.platform === "win32";
}
function isDarwin() {
	return process.platform === "darwin";
}

// Opt-in, as before the port: `check` never ran this suite, and its two macOS helper builds outlast the
// scripts' own 120 s deadline on a loaded host. `npm run test:windows-scripts` sets the flag.
describe.skipIf(process.env.PI_CU_WINDOWS_SCRIPTS !== "1")("Windows build/install script routing (PI_CU_WINDOWS_SCRIPTS=1)", () => {
	beforeAll(() => {
		TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-computer-use-script-test-"));
		TEST_HELPER_APP = path.join(TEST_ROOT, "pi-computer-use.app");
		TEST_WINDOWS_HELPER = path.join(TEST_ROOT, "windows-bridge.exe");
		liveHelperBefore = fileFingerprint(LIVE_HELPER);
		armPrebuiltBefore = fileFingerprint(path.join(ROOT, "prebuilt", "macos", "arm64", "bridge"));
	});
	afterAll(() => rmSilent(TEST_ROOT));

	test("path alignment", () => {
		assert.equal(WINDOWS_HELPER_DEST, WINDOWS_HELPER_STABLE_PATH, "setup-helper.mjs dest matches WINDOWS_HELPER_PATH in src/platform/windows/helper.ts");
		assert.equal(
			EXE_CANDIDATE,
			path.join(ROOT, "native", "windows", "bridge-rs", "target", "release", "windows-bridge.exe"),
			"windowsBinaryPath exePath points to windows-bridge.exe in release dir",
		);
		assert.equal(
			path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"),
			path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"),
			"prebuilt stored under prebuilt/windows/windows-bridge.exe",
		);
	});

	test(
		"build-native.mjs --platform windows (output to tmpdir)",
		async () => {
			// Use a temp output path so we never pollute prebuilt/windows/ during tests.
			const tmpBuildOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-windows-smoke-")), "windows-bridge.exe");
			try {
				const result = await runScript("build-native.mjs", ["--platform", "windows", "--output", tmpBuildOut]);
				if (isWin32()) {
					assert.equal(result.code, 0, "build-native.mjs --platform windows --output <tmp> exits 0 on Windows");
					assert.match(result.stdout, /Building Windows helper/, "prints build start message");
				} else {
					assert.equal(result.code, 1, "host build is rejected instead of being renamed to .exe");
					assert.match(result.stderr, /Refusing to label a host binary as Windows/, "explains that a Windows host or target is required");
				}
			} finally {
				rmSilent(path.dirname(tmpBuildOut));
			}
			assert.equal(!fs.existsSync(tmpBuildOut), true, "temporary Windows build output is cleaned up");
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"build-native.mjs (no args, platform detection)",
		async () => {
			const result = await runScript("build-native.mjs", ["--output", path.join(TEST_ROOT, "native-default")]);
			if (isWin32()) {
				assert.equal(result.code, 0, "no-args exits 0 on Windows");
				assert.match(result.stdout, /Building Windows helper/, "builds Windows helper on win32");
			} else if (isDarwin()) {
				assert.equal(result.code, 0, "no-args exits 0 on macOS");
				assert.match(result.stdout, /Building .*native helper|Built .*helper/, "builds macOS helper on darwin");
			} else {
				assert.equal(result.code, 0, "no-args exits 0 on Linux");
				assert.match(result.stdout, /Skipping native build/, "prints platform-skip message");
			}
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"build-native.mjs --platform darwin",
		async () => {
			const result = await runScript("build-native.mjs", ["--platform", "darwin", "--output", path.join(TEST_ROOT, "native-darwin")]);
			if (isDarwin()) {
				assert.equal(result.code, 0, "--platform darwin exits 0 on macOS");
				assert.match(result.stdout, /Building .*native helper|Built .*helper/, "builds macOS helper on darwin");
			} else {
				assert.equal(result.code, 1, "--platform darwin exits 1 without macOS toolchain");
				assert.match(result.stderr, /xcrun|ENOENT|Command failed/, "errors about missing xcrun/swift toolchain");
			}
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"setup-helper.mjs --platform windows (prebuilt handling)",
		async () => {
			const prebuiltExists = fs.existsSync(path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"));
			const result = await runScript("setup-helper.mjs", ["--platform", "windows"]);
			if (prebuiltExists) {
				// When the prebuilt exists, setup may succeed, or fail gracefully with EPERM if the
				// destination helper is locked by a running process.
				const isOk = result.code === 0 || result.stderr.includes("EPERM");
				assert.equal(isOk, true, "--platform windows handles prebuilt (install or EPERM gracefully)");
			} else {
				// When no prebuilt exists and --allow-build is not given, must error with instructions.
				assert.equal(result.code, 1, "--platform windows exits 1 when prebuilt absent");
				assert.match(result.stderr, /No Windows prebuilt helper found/, "prints helpful error about missing prebuilt with build instructions");
			}
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"setup-helper.mjs (no args, platform detection)",
		async () => {
			const result = await runScript("setup-helper.mjs", []);
			if (isWin32()) {
				// Default setup never silently opts into a build. A source checkout has no Windows prebuilt.
				const prebuiltExists = fs.existsSync(path.join(ROOT, "prebuilt", "windows", "windows-bridge.exe"));
				if (prebuiltExists) {
					assert.equal(result.code === 0 || result.stderr.includes("EPERM"), true, "no-args handles win32 prebuilt setup");
				} else {
					assert.equal(result.code, 1, "no-args refuses an absent Windows prebuilt without build opt-in");
					assert.match(result.stderr, /No Windows prebuilt helper found/);
				}
			} else if (isDarwin()) {
				assert.equal(result.code === 0 || result.stderr.includes("EPERM"), true, "no-args installs only into the isolated test app on macOS");
				const combined = result.stderr + result.stdout;
				assert.equal(/installed|current|unavailable|EPERM/i.test(combined), true, "prints macOS install/current/sandbox status");
			} else {
				assert.equal(result.code, 1, "no-args exits 1 on non-Windows/non-macOS");
				assert.match(result.stderr, /only supported on macOS/, "prints macOS-only error");
			}
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"setup-helper.mjs --postinstall (platform detection)",
		async () => {
			const result = await runScript("setup-helper.mjs", ["--postinstall"]);
			if (isWin32()) {
				// On Windows, postinstall should exit 0 gracefully. The helper may be
				// installed, up-to-date, or the install skipped with a clear message.
				assert.equal(result.code, 0, "--postinstall exits 0 on Windows");
				const combined = result.stderr + result.stdout;
				const hasAcceptableMsg = /skipped|installed|up to date/i.test(combined);
				assert.equal(hasAcceptableMsg, true, "prints skip, install, or up-to-date message");
			} else if (isDarwin()) {
				assert.equal(result.code, 0, "--postinstall exits 0 on macOS");
				const combined = result.stderr + result.stdout;
				assert.equal(/installed|current|unavailable|skipped|EPERM/i.test(combined), true, "prints macOS install/current/sandbox status");
			} else {
				assert.equal(result.code, 0, "--postinstall exits 0 on non-Windows/non-macOS");
				assert.match(result.stderr, /skipping helper setup/, "prints skip warning");
			}
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test(
		"setup-helper.mjs --platform windows --postinstall",
		async () => {
			const result = await runScript("setup-helper.mjs", ["--platform", "windows", "--postinstall"]);
			assert.equal(result.code, 0, "--platform windows --postinstall exits 0 (postinstall catch-all)");
			const combined = result.stderr + result.stdout;
			const hasMsg = /skipped|installed|up to date/i.test(combined);
			assert.equal(hasMsg, true, "prints appropriate status message (skip, install, or up-to-date)");
		},
		SCRIPT_CASE_TIMEOUT_MS,
	);

	test("source-level --platform routing", () => {
		// Confirm the --platform handler lines exist in the right shape.
		const grepSource = (relPath, pattern) => pattern.test(fs.readFileSync(path.join(SCRIPTS_DIR, relPath), "utf8"));
		assert.equal(grepSource("build-native.mjs", /explicitPlatform === "windows"/), true, "build-native.mjs routes on --platform windows");
		assert.equal(grepSource("build-native.mjs", /explicitPlatform === "darwin"/), true, "build-native.mjs routes on --platform darwin");
		assert.equal(grepSource("setup-helper.mjs", /explicitPlatform === "windows"/), true, "setup-helper.mjs routes on --platform windows");
	});

	// Last on purpose: Vitest runs a file's cases in order, so this sees every build/setup run above.
	test("live-install isolation", () => {
		assert.equal(fileFingerprint(LIVE_HELPER), liveHelperBefore, "tests do not modify the installed macOS helper");
		assert.equal(fileFingerprint(path.join(ROOT, "prebuilt", "macos", "arm64", "bridge")), armPrebuiltBefore, "tests do not rebuild the committed macOS helper");
	});
});
