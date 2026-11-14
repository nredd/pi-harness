import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLock } from "../../src/stats/lock.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

let dir: string;
let lock: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stats-lock-"));
	lock = join(dir, "sub", "export.lock");
});
afterEach(() => {
	vi.mocked(fsp.rename).mockReset();
	rmSync(dir, { recursive: true, force: true });
});

const BUSY = "export already running";
/** A pid no process has: far above any pid_max. */
const DEAD = 2 ** 30;

describe("withLock", () => {
	it("holds the lock for the duration and releases it, returning the result", async () => {
		const seen = await withLock(lock, BUSY, async () => readFileSync(lock, "utf8"));
		expect(seen).toBe(String(process.pid));
		expect(existsSync(lock)).toBe(false);
		// and again: released locks can be retaken
		await withLock(lock, BUSY, async () => undefined);
	});

	it("releases the lock when the work fails", async () => {
		await expect(
			withLock(lock, BUSY, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});

	it("fails a second taker while a live process holds it", async () => {
		await withLock(lock, BUSY, async () => {
			await expect(withLock(lock, BUSY, async () => 1)).rejects.toThrow(BUSY);
			// the failed attempt did not take or remove the holder's lock
			expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
		});
	});

	it("reclaims a lock whose owner is dead, or whose contents are not a pid", async () => {
		mkdirSync(join(dir, "sub"));
		for (const contents of [String(DEAD), "", "not a pid", "-4"]) {
			writeFileSync(lock, contents);
			await expect(withLock(lock, BUSY, async () => "ok")).resolves.toBe("ok");
			expect(existsSync(lock)).toBe(false);
		}
	});

	it("reclaims a lock path that is not even a readable file", async () => {
		mkdirSync(lock, { recursive: true });
		await expect(withLock(lock, BUSY, async () => "ok")).resolves.toBe("ok");
	});

	it("treats a lock owned by an unsignalable but live process as held", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(lock, "1");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		});
		try {
			await expect(withLock(lock, BUSY, async () => 1)).rejects.toThrow(BUSY);
		} finally {
			kill.mockRestore();
		}
	});

	it("does not remove a lock it no longer owns", async () => {
		await withLock(lock, BUSY, async () => writeFileSync(lock, "1"));
		expect(readFileSync(lock, "utf8")).toBe("1");
	});

	it("reports busy when another process wins the reclaim race", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(lock, String(DEAD));
		vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
		await expect(withLock(lock, BUSY, async () => 1)).rejects.toThrow(BUSY);
		// the dead lock is still there for whoever won; nothing was published by us
		vi.mocked(fsp.rename).mockImplementationOnce(async () => {});
		await expect(withLock(lock, BUSY, async () => 1)).rejects.toThrow(BUSY);
	});

	it.skipIf(process.getuid?.() === 0)("passes through other failures to take the lock", async () => {
		mkdirSync(join(dir, "sub"));
		chmodSync(join(dir, "sub"), 0o500);
		try {
			await expect(withLock(lock, BUSY, async () => 1)).rejects.toMatchObject({ code: "EACCES" });
		} finally {
			chmodSync(join(dir, "sub"), 0o700);
		}
	});
});
