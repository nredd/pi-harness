#!/usr/bin/env node
// Launcher for the opt-in live Linux E2E in `test/linux-live.test.mjs`. It owns only the isolated D-Bus
// session: the scenario and every assertion run under Vitest inside it, through the repository launcher.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishCheckCleanup, stopCheckChild, within } from "./check-async.mjs";

if (process.env.PI_CU_LIVE !== "1") {
	throw new Error(
		"Live Linux E2E is disabled. Set PI_CU_LIVE=1 to run it explicitly.",
	);
}
if (process.platform !== "linux")
	throw new Error("Live Linux E2E requires Linux.");

// Budget the complete desktop scenario, including startup, tool calls and inner teardown.
const LIVE_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const packageDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const child = spawn(
	"dbus-run-session",
	[
		"--",
		process.execPath,
		path.join(packageDir, "..", "..", "scripts", "run-vitest.ts"),
		"node",
		"test/linux-live.test.mjs",
		"--coverage.enabled=false",
	],
	{
		cwd: packageDir,
		env: {
			...process.env,
			PI_COMPUTER_USE_HEADLESS: "1",
			PI_COMPUTER_USE_BROWSER_USE: "0",
			// Only this launcher sets the marker, so the scenario never skips inside the session.
			PI_CU_LINUX_LIVE_SESSION: "1",
		},
		detached: true,
		stdio: "inherit",
	},
);
const closed = new Promise(
	/** @returns Subscribes to session stream closure. @throws No intentional errors. */
	(resolve) => child.once("close", resolve),
);
const exited = new Promise(
	/** @returns Registers the session exit outcome. @throws Spawn and signal failures reject the promise. */
	(resolve, reject) => {
		child.once("error", reject);
		child.once(
			"exit",
			/** @returns Settles the session outcome. @throws No errors; signal exits reject the promise. */
			(code, signal) =>
				signal
					? reject(new Error(`Live Linux E2E session exited on ${signal}.`))
					: resolve(code ?? 1),
		);
	},
);
let sessionFailure;
try {
	process.exitCode = await within(
		exited,
		"live Linux E2E D-Bus session",
		LIVE_SESSION_TIMEOUT_MS,
	);
} catch (error) {
	sessionFailure = error;
	throw error;
} finally {
	await finishCheckCleanup(
		"live Linux E2E session",
		[
			/**
			 * A completed leader permits probes only; a running leader retains cleanup ownership.
			 * @returns {Promise<void>} Bounded observation or owned-group cancellation.
			 * @throws {Error} On quiescence or cancellation failure.
			 */
			() => stopCheckChild(child, closed, "live Linux E2E D-Bus session", true),
		],
		sessionFailure,
	);
}
