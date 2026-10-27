import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_CHECK_TIMEOUT_MS,
	deferred,
	SIGNAL_READINESS_POLL_MS,
	SIGNAL_READINESS_TIMEOUT_MS,
	within,
	writeSignalReadinessObserver,
} from "./check-async.mjs";

const NEGATIVE_CONTROL_TIMEOUT_MS = 1;

test("deferred readiness resolves through a bounded completion wait", async () => {
	const gate = deferred();
	gate.resolve("ready");
	assert.equal(await within(gate.promise, "resolved readiness"), "ready");
});

test("completion watchdog preserves rejection and reports missing readiness context", async () => {
	const failure = new Error("fixture failed");
	await assert.rejects(
		within(Promise.reject(failure), "failed fixture"),
		(error) => error === failure,
	);
	await assert.rejects(
		within(
			new Promise(() => {}),
			"deliberately missing readiness",
			NEGATIVE_CONTROL_TIMEOUT_MS,
		),
		/Timed out waiting for deliberately missing readiness/,
	);
});

test("signal observer waits for registration in the actual wrapper process", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-signal-observer-"));
	const marker = path.join(dir, "wrapper.pid");
	const observer = path.join(dir, "observer.mjs");
	let child;
	let stopPolling = false;
	try {
		await writeSignalReadinessObserver(observer, marker);
		const entered = deferred();
		child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(observer).href,
				"-e",
				`
process.on("message", message => {
  if (message === "register") {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "exit"]) process.on(signal, () => {});
  }
});
process.send("entered");
`,
			],
			{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		const closed = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		child.once("message", (message) => entered.resolve(message));
		assert.equal(
			await within(
				Promise.race([
					entered.promise,
					closed.then(() => {
						throw new Error(
							"Observer fixture closed before entry acknowledgment",
						);
					}),
				]),
				"unregistered wrapper entry",
			),
			"entered",
		);
		assert.equal(
			await fs.stat(marker).then(
				() => true,
				() => false,
			),
			false,
			"entry alone must not publish handler readiness",
		);
		child.send("register");
		const observed = (async () => {
			while (!stopPolling) {
				const pid = Number(await fs.readFile(marker, "utf8").catch(() => ""));
				if (pid > 0) return pid;
				await new Promise((resolve) =>
					setTimeout(resolve, SIGNAL_READINESS_POLL_MS),
				);
			}
		})();
		assert.equal(
			await within(observed, "post-registration wrapper marker"),
			child.pid,
		);
		child.kill("SIGKILL");
		await within(closed, "observer fixture to close");
	} finally {
		stopPolling = true;
		child?.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("signal observer fails contextually when wrapper handlers never register", async () => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "pi-signal-observer-missing-"),
	);
	const observer = path.join(dir, "observer.mjs");
	const marker = path.join(dir, "wrapper.pid");
	let child;
	try {
		await writeSignalReadinessObserver(observer, marker);
		child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(observer).href,
				"-e",
				`setInterval(() => {}, ${SIGNAL_READINESS_POLL_MS});`,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const closed = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
		});
		assert.equal(
			await within(
				closed,
				"unregistered observer to report its deadline failure",
				SIGNAL_READINESS_TIMEOUT_MS + DEFAULT_CHECK_TIMEOUT_MS,
			),
			1,
		);
		assert.match(
			stderr,
			/Timed out observing wrapper signal-handler registration: SIGTERM, SIGINT, SIGHUP, exit/,
		);
		assert.equal(
			await fs.stat(marker).then(
				() => true,
				() => false,
			),
			false,
		);
	} finally {
		child?.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
});
