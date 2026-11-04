import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { running, waitFor } from "./helpers.ts";
import { STAY, stayWhileAlive } from "./stay.ts";

const spawned: ChildProcess[] = [];

afterEach(() => {
	// Only processes this test spawned, by pid, so a failed assertion cannot leave the loop behind.
	for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

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
