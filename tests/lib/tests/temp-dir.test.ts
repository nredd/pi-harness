import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { makeTestTempDir } from "../src/temp-dir.ts";

test("registers recursive cleanup for each directory and tolerates repeated cleanup", ({ onTestFinished }) => {
	const cleanups: (() => void)[] = [];
	const register = (cleanup: () => void) => {
		cleanups.push(cleanup);
		onTestFinished(cleanup);
	};
	const first = makeTestTempDir("pi-test-lib-", register);
	const second = makeTestTempDir("pi-test-lib-", register);
	expect(first).not.toBe(second);
	writeFileSync(join(first, "fixture.txt"), "fixture");
	expect(cleanups).toHaveLength(2);
	for (const cleanup of cleanups) cleanup();
	expect(existsSync(first)).toBe(false);
	expect(existsSync(second)).toBe(false);
});

test("removes the directory if its cleanup cannot be registered", ({ onTestFinished }) => {
	const parent = makeTestTempDir("pi-test-lib-", onTestFinished);
	const error = new Error("no active test");
	expect(() =>
		makeTestTempDir(join(basename(parent), "child-"), () => {
			expect(readdirSync(parent)).toHaveLength(1);
			throw error;
		}),
	).toThrow(error);
	expect(readdirSync(parent)).toEqual([]);
});
