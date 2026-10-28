import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolateStackHome, loadFork, loadOwned } from "./support.ts";

const launchHome = process.env.HOME;
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

it("keeps spawn-time HOME while isolating each Pi and XDG fixture", async () => {
	expect(process.env.HOME).toBe(launchHome);
	expect(homedir()).toBe(launchHome);
	const fixture = await isolateStackHome();
	try {
		expect(process.env.HOME).toBe(launchHome);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(fixture.root, "agent"));
		expect(process.env.XDG_CONFIG_HOME).toBe(join(fixture.root, ".config"));
		expect(fixture.root).not.toBe(home.root);
	} finally {
		await fixture.cleanup();
	}
	expect(process.env.PI_CODING_AGENT_DIR).toBe(join(home.root, "agent"));
	expect(process.env.XDG_CONFIG_HOME).toBe(join(home.root, ".config"));
});

it("loads real fork and owned entries against one host", async () => {
	for (const fork of ["pi-plan-mode", "rpiv-todo", "pi-subagents"] as const) {
		expect(typeof (await loadFork(fork))).toBe("function");
	}
	for (const owned of ["@nredd/pi-dev-tools", "@nredd/pi-session-kit", "@nredd/pi-subscription-router"] as const) {
		expect(typeof (await loadOwned(owned))).toBe("function");
	}
});
