import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { runCheckCommand, writeSignalReadinessObserver } from "../scripts/check-async.mjs";

// This runs the generated module in real Node. It does not claim Istanbul coverage of its text.
test("readiness preload propagates real marker-write failure rather than reporting ready", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-observer-refusal-"));
	try {
		const observer = path.join(dir, "observer.mjs");
		const marker = path.join(dir, "missing-parent", 'quoted-"-marker.pid');
		await writeSignalReadinessObserver(observer, marker);
		await assert.rejects(
			runCheckCommand(
				process.execPath,
				[
					"--import",
					pathToFileURL(observer).href,
					"-e",
					'for (const event of ["SIGTERM", "SIGINT", "SIGHUP", "exit"]) process.on(event, () => {}); setInterval(() => {}, 1000);',
				],
				{ label: "marker refusal", timeoutMs: 5000 },
			),
			(error) => {
				assert.match(error.message, /marker refusal.*exited with 1/);
				assert.match(error.cause.stderr, /ENOENT/);
				assert.match(error.cause.stderr, /missing-parent/);
				return true;
			},
		);
		await assert.rejects(fs.stat(marker), { code: "ENOENT" });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
