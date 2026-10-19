import { afterAll, beforeAll, expect, it } from "vitest";
import { isolateStackHome, loadFork, loadOwned } from "./support.ts";

let home: ReturnType<typeof isolateStackHome>;
beforeAll(() => {
	home = isolateStackHome();
});
afterAll(() => {
	home.cleanup();
});

it("loads real fork and owned entries against one host", async () => {
	for (const fork of ["pi-plan-mode", "rpiv-todo", "pi-subagents"] as const) {
		expect(typeof (await loadFork(fork))).toBe("function");
	}
	for (const owned of ["@nredd/pi-dev-tools", "@nredd/pi-session-kit", "@nredd/pi-subscription-router"] as const) {
		expect(typeof (await loadOwned(owned))).toBe("function");
	}
});
