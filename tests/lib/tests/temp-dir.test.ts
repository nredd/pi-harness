import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { CLEANUP_RETRY_OPTIONS, makeOwnedTempDir, makeTestTempDir } from "../src/temp-dir.ts";

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
	expect(first).toBe(join(tmpdir(), basename(first)));
	expect(first).not.toBe(second);
	writeFileSync(join(first, "fixture.txt"), "fixture");
	expect(cleanups).toHaveLength(2);
	for (const cleanup of cleanups) cleanup();
	// The platform owns the retry loop for transient errors, including EBUSY and EPERM.
	expect(rmSync).toHaveBeenCalledWith(first, { recursive: true, force: true, ...CLEANUP_RETRY_OPTIONS });
	expect(existsSync(first)).toBe(false);
	expect(existsSync(second)).toBe(false);
});

test("creates and cleans a fixture directly under an explicit base directory", ({ onTestFinished }) => {
	const baseDir = makeTestTempDir("pi-test-lib-", onTestFinished);
	const cleanups: (() => void)[] = [];
	const register = (cleanup: () => void) => {
		cleanups.push(cleanup);
		onTestFinished(cleanup);
	};
	const child = makeTestTempDir("child-", register, { baseDir });
	expect(dirname(child)).toBe(baseDir);
	expect(basename(child)).toMatch(/^child-/u);
	writeFileSync(join(child, "fixture.txt"), "fixture");
	expect(cleanups).toHaveLength(1);
	for (const cleanup of cleanups) cleanup();
	expect(readdirSync(baseDir)).toEqual([]);
});

test.each(["../escape-", "nested/../../escape-", join(tmpdir(), "absolute-")])(
	"refuses a prefix that leaves an explicit base directory: %s",
	(prefix) => {
		const baseDir = makeTestTempDir("pi-test-lib-", onTestFinished);
		const register = vi.fn();
		expect(() => makeTestTempDir(prefix, register, { baseDir })).toThrow(/stay inside baseDir/u);
		expect(register).not.toHaveBeenCalled();
		expect(readdirSync(baseDir)).toEqual([]);
		expect(readdirSync(dirname(baseDir)).filter((name) => name.startsWith("escape-"))).toEqual([]);
	},
);

test("removes the directory if its cleanup cannot be registered", ({ onTestFinished }) => {
	const parent = makeTestTempDir("pi-test-lib-", onTestFinished);
	const error = new Error("no active test");
	expect(() =>
		makeTestTempDir(
			"child-",
			() => {
				expect(readdirSync(parent)).toHaveLength(1);
				throw error;
			},
			{ baseDir: parent },
		),
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

test("an owned directory is removed only by its returned remove, with the same retries", ({ onTestFinished }) => {
	const baseDir = makeTestTempDir("pi-test-lib-", onTestFinished);
	const { dir, remove } = makeOwnedTempDir("owned-", { baseDir });
	expect(dirname(dir)).toBe(baseDir);
	writeFileSync(join(dir, "fixture.txt"), "fixture");
	expect(existsSync(dir)).toBe(true);
	remove();
	remove();
	expect(rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true, ...CLEANUP_RETRY_OPTIONS });
	expect(readdirSync(baseDir)).toEqual([]);
	expect(() => makeOwnedTempDir("../escape-", { baseDir })).toThrow(/stay inside baseDir/u);
});
