// Compile the production policy seam, not a JavaScript copy. Non-Windows execution is NOT Windows coverage.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const manifest = fileURLToPath(new URL("../native/windows/bridge-rs/Cargo.toml", import.meta.url));

test("Windows raw-input policy refuses before delivery", () => {
	const target = mkdtempSync(path.join(os.tmpdir(), "cu-windows-refusal-"));
	try {
		const result = spawnSync(
			"cargo",
			[
				"test",
				"--locked",
				"--manifest-path",
				manifest,
				"--lib",
				"input::tests::raw_input_refusals_do_not_dispatch",
				"--",
				"--exact",
			],
			{
				env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: "2" },
				encoding: "utf8",
				timeout: 80_000,
				maxBuffer: 8 * 1024 * 1024,
			},
		);
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /1 passed; 0 failed/);
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
}, 90_000);
