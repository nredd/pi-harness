import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { running, tempDir } from "./helpers.ts";

/** Write an executable stand-in for `ps`. */
function fakePs(dir: string, body: string): string {
	const path = join(dir, "ps");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("running", () => {
	it("is true for this process and false for an absent pid", async () => {
		expect(await running(process.pid)).toBe(true);
		expect(await running(2 ** 22 + 12345)).toBe(false);
	});

	it("treats a zombie state as not running", async () => {
		const tmp = tempDir();
		try {
			expect(await running(process.pid, { ps: fakePs(tmp.dir, "echo Z") })).toBe(false);
			expect(await running(process.pid, { ps: fakePs(tmp.dir, "echo Ss") })).toBe(true);
		} finally {
			tmp.cleanup();
		}
	});

	it("reads a non-zero exit with no output as absent", async () => {
		const tmp = tempDir();
		try {
			expect(await running(process.pid, { ps: fakePs(tmp.dir, "exit 1") })).toBe(false);
		} finally {
			tmp.cleanup();
		}
	});

	it("rethrows when ps cannot be spawned, times out, or fails with output", async () => {
		const tmp = tempDir();
		try {
			await expect(running(process.pid, { ps: join(tmp.dir, "missing") })).rejects.toThrow();
			await expect(running(process.pid, { ps: fakePs(tmp.dir, "sleep 5"), timeoutMs: 100 })).rejects.toThrow();
			await expect(running(process.pid, { ps: fakePs(tmp.dir, "echo S; exit 2") })).rejects.toThrow();
		} finally {
			tmp.cleanup();
		}
	});
});
