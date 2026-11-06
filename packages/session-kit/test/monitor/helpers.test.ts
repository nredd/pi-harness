import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { published, running, tempDir } from "./helpers.ts";

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

describe("published", () => {
	/** Run `script` under this runtime with piped output, as the worker-death test runs its nested Vitest. */
	function child(script: string, env: Record<string, string> = {}) {
		return spawn(process.execPath, ["-e", script], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	it("resolves once a live child renames the path into place", async () => {
		const tmp = tempDir();
		const path = join(tmp.dir, "ready.json");
		const proc = child(
			'const fs = require("node:fs"); const p = process.env.READY; setTimeout(() => { fs.writeFileSync(p + ".tmp", "{}"); fs.renameSync(p + ".tmp", p); }, 100); setInterval(() => {}, 1000);',
			{ READY: path },
		);
		try {
			await published(path, proc);
			expect(proc.exitCode).toBeNull();
		} finally {
			proc.kill("SIGKILL");
			tmp.cleanup();
		}
	});

	it("rejects with the exit code and the child's output when it exits first", async () => {
		const tmp = tempDir();
		try {
			const proc = child('console.log("inner stdout"); console.error("inner stderr"); process.exit(3);');
			await expect(published(join(tmp.dir, "ready.json"), proc)).rejects.toThrow(
				/exited before publishing readiness: 3\n(?=[\s\S]*inner stdout)(?=[\s\S]*inner stderr)/,
			);
		} finally {
			tmp.cleanup();
		}
	});

	it("rejects with the signal when the child is killed first", async () => {
		const tmp = tempDir();
		try {
			const proc = child('process.kill(process.pid, "SIGKILL");');
			await expect(published(join(tmp.dir, "ready.json"), proc)).rejects.toThrow(
				"exited before publishing readiness: SIGKILL",
			);
		} finally {
			tmp.cleanup();
		}
	});

	it("rejects for a child that already exited before the call", async () => {
		const tmp = tempDir();
		try {
			const proc = child("process.exit(4);");
			await new Promise((r) => proc.once("close", r));
			await expect(published(join(tmp.dir, "ready.json"), proc)).rejects.toThrow(
				"exited before publishing readiness: 4",
			);
		} finally {
			tmp.cleanup();
		}
	});

	it("resolves when the path exists even if the child already exited", async () => {
		const tmp = tempDir();
		const path = join(tmp.dir, "ready.json");
		try {
			writeFileSync(path, "{}");
			const proc = child("process.exit(0);");
			await new Promise((r) => proc.once("close", r));
			await published(path, proc);
		} finally {
			tmp.cleanup();
		}
	});
});
