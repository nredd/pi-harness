import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { running, waitFor } from "./helpers.ts";
import { STAY, stayWhileAlive, WORKER_ALIVE_SH } from "./stay.ts";

const spawned: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
	// Only processes this test spawned, by pid, so a failed assertion cannot leave the loop behind.
	for (const child of spawned.splice(0)) child.kill("SIGKILL");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `ps` that logs each probe to `calls` and runs `body` for its exit status. */
function stubPs(body: string): { ps: string; calls: () => number } {
	const dir = mkdtempSync(join(tmpdir(), "psk-stay-"));
	dirs.push(dir);
	const ps = join(dir, "ps");
	const log = join(dir, "calls");
	writeFileSync(ps, `#!/bin/sh\necho >> "${log}"\n${body}\n`);
	chmodSync(ps, 0o755);
	return { ps, calls: () => (existsSync(log) ? readFileSync(log, "utf8").length : 0) };
}

/** Run `stayWhileAlive` on this worker through `ps`, TERM-resistant like the fixtures that use it. */
function guardWith(ps: string): number {
	const guard = spawn("/bin/sh", ["-c", `trap "" TERM; ${stayWhileAlive(process.pid, ps)}`], {
		detached: true,
		stdio: "ignore",
	});
	spawned.push(guard);
	return guard.pid as number;
}

/** An owner that `STAY`s on this worker, so a worker SIGKILLed mid-test cannot orphan it either. */
const owner = (code = ""): ChildProcess =>
	spawn(process.execPath, ["--input-type=module", "-e", `${code}\n${STAY}`], { stdio: ["ignore", "pipe", "ignore"] });

describe("stayWhileAlive", () => {
	it("ends a TERM-resistant shell loop once its owner is SIGKILLed", async () => {
		const parent = owner();
		const guard = spawn("/bin/sh", ["-c", `trap "" TERM; ${stayWhileAlive(parent.pid as number)}`], {
			detached: true,
			stdio: "ignore",
		});
		spawned.push(parent, guard);
		const guardPid = guard.pid as number;
		expect(await running(guardPid)).toBe(true);
		parent.kill("SIGKILL");
		await waitFor(async () => !(await running(guardPid)), 10_000);
	});

	it("keeps looping when a probe exits 143, the status procps `ps` gives a caught SIGTERM", async () => {
		// Exits 143 only while this worker lives, so a SIGKILLed worker still ends the loop.
		const { ps, calls } = stubPs(`${WORKER_ALIVE_SH} && exit 143\nexit 1`);
		const guardPid = guardWith(ps);
		await waitFor(() => calls() >= 2, 10_000);
		expect(await running(guardPid)).toBe(true);
	});

	it("ends once a probe exits 1, the status for no such pid", async () => {
		const { ps, calls } = stubPs("exit 1");
		const guardPid = guardWith(ps);
		await waitFor(async () => !(await running(guardPid)), 10_000);
		expect(calls()).toBe(1);
	});
});

describe("stayFor", () => {
	it("ends a script fixture once the owner that spawned it is SIGKILLed", async () => {
		const stay = JSON.stringify(join(import.meta.dirname, "stay.ts"));
		const parent = owner(
			`import { spawn } from "node:child_process"; import { stayFor } from ${stay};
			const guard = spawn(process.execPath, ["-e", stayFor(process.pid)], { stdio: "ignore" });
			console.log(guard.pid);`,
		);
		spawned.push(parent);
		const [line] = (await once(parent.stdout as NonNullable<ChildProcess["stdout"]>, "data")) as [Buffer];
		const guardPid = Number(line.toString().trim());
		expect(guardPid).toBeGreaterThan(0);
		expect(await running(guardPid)).toBe(true);
		parent.kill("SIGKILL");
		await waitFor(async () => !(await running(guardPid)), 10_000);
	});
});
