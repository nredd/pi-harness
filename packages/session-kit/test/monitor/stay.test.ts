import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { running, waitFor } from "./helpers.ts";
import { stayWhileAlive } from "./stay.ts";

const spawned: ChildProcess[] = [];

afterEach(() => {
	// Only processes this test spawned, by pid, so a failed assertion cannot leave the loop behind.
	for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

describe("stayWhileAlive", () => {
	it("ends a TERM-resistant shell loop once its owner is SIGKILLed", async () => {
		const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const guard = spawn("/bin/sh", ["-c", `trap "" TERM; ${stayWhileAlive(owner.pid as number)}`], {
			detached: true,
			stdio: "ignore",
		});
		spawned.push(owner, guard);
		const guardPid = guard.pid as number;
		expect(await running(guardPid)).toBe(true);
		owner.kill("SIGKILL");
		await waitFor(async () => !(await running(guardPid)), 10_000);
	});
});
