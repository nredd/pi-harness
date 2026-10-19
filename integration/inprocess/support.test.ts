import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolateStackHome, loadFork, loadOwned } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
beforeAll(async () => {
	home = await isolateStackHome();
});
afterAll(async () => {
	await home.cleanup();
});

it.skipIf(process.platform !== "darwin")("holds process-scoped sleep assertions for stack tests", () => {
	const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" });
	const assertion = processes.match(
		new RegExp(`^\\s*(\\d+)\\s+${process.pid}\\s+/usr/bin/caffeinate -disu -w ${process.pid}$`, "m"),
	);
	expect(assertion, "Missing process-scoped caffeinate -disu assertion").not.toBeNull();
	const assertions = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
	const owned = assertions
		.split("\n")
		.filter((line) => line.includes(`pid ${assertion?.[1]}(caffeinate):`))
		.join("\n");
	for (const type of ["PreventUserIdleSystemSleep", "PreventUserIdleDisplaySleep", "PreventSystemSleep"]) {
		expect(owned).toContain(type);
	}
});

it("loads real fork and owned entries against one host", async () => {
	for (const fork of ["pi-plan-mode", "rpiv-todo", "pi-subagents"] as const) {
		expect(typeof (await loadFork(fork))).toBe("function");
	}
	for (const owned of ["@nredd/pi-dev-tools", "@nredd/pi-session-kit", "@nredd/pi-subscription-router"] as const) {
		expect(typeof (await loadOwned(owned))).toBe("function");
	}
});
