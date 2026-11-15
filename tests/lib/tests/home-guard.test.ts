import { expect, test } from "vitest";
import { assertHomeDirectory, type GuardListener, installHomeGuard } from "../src/home-guard.ts";

test("matching HOME and homedir pass", () => {
	expect(() => assertHomeDirectory("matching.test.ts", "/fixture", "/fixture")).not.toThrow();
});

test("mismatched HOME fails with the file and injection fix", () => {
	expect(() => assertHomeDirectory("offender.test.ts", "/fixture", "/real-home")).toThrow(
		/HOMEDIR GUARD: offender.test.ts:.*Inject the home directory/,
	);
});

test("missing HOME fails closed", () => {
	// Passing undefined uses the real env default; remove it only for this pure check.
	const previous = process.env.HOME;
	try {
		delete process.env.HOME;
		expect(() => assertHomeDirectory("missing.test.ts", undefined, "/real-home")).toThrow(/HOMEDIR GUARD/);
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});

test("installed guard checks setup and both per-test boundaries", () => {
	const before: GuardListener[] = [];
	const after: GuardListener[] = [];
	const hooks = {
		beforeEach: (listener: GuardListener) => before.push(listener),
		afterEach: (listener: GuardListener) => after.push(listener),
	};
	const context = { task: { file: { filepath: "boundary.test.ts" } } };
	installHomeGuard("setup.test.ts", hooks);
	expect([before.length, after.length]).toEqual([1, 1]);
	for (const listener of [...before, ...after]) expect(() => listener(context)).not.toThrow();
	const previous = process.env.HOME;
	try {
		delete process.env.HOME;
		expect(() => installHomeGuard(undefined, hooks)).toThrow(/^HOMEDIR GUARD: <unknown test file>:/);
		expect([before.length, after.length]).toEqual([1, 1]);
		for (const listener of [...before, ...after]) {
			expect(() => listener(context)).toThrow(/^HOMEDIR GUARD: boundary\.test\.ts:/);
		}
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});
