import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { makeTestTempDir } from "../src/temp-dir.ts";

vi.mock(import("node:fs"), async (importOriginal) => {
	const fs = await importOriginal();
	return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

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
	// The platform owns the retry loop for transient errors, including EBUSY and EPERM.
	expect(rmSync).toHaveBeenCalledWith(first, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

test("preserves both errors when registration and cleanup fail", ({ onTestFinished }) => {
	const parent = makeTestTempDir("pi-test-lib-", onTestFinished);
	const registrationError = new Error("no active test");
	const removalError = Object.assign(new Error("handle still open after retries"), { code: "EBUSY" });
	vi.mocked(rmSync).mockImplementationOnce(() => {
		throw removalError;
	});
	expect(() =>
		makeTestTempDir(join(basename(parent), "child-"), () => {
			throw registrationError;
		}),
	).toThrow(expect.objectContaining({ errors: [registrationError, removalError] }));
});
