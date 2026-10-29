import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDiff, loadStat, MAX_UNTRACKED_FILES, runGit, untrackedPatch } from "../../src/diff/git.ts";
import { PER_FILE_BYTES } from "../../src/diff/parse.ts";
import { alive, waitFor } from "../monitor/helpers.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const saved: Record<string, string | undefined> = {};
const ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};
beforeAll(() => {
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
});
afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const write = (name: string, content: string | Buffer) => {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), content);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-diff-test-"));
	git("init", "-q", "-b", "main");
});
afterEach(() => {
	vi.useRealTimers();
	vi.mocked(spawn).mockReset();
	rmSync(dir, { recursive: true, force: true });
});

function commitAll(msg = "c") {
	git("add", "-A");
	git("commit", "-q", "-m", msg);
}

describe("loadDiff", () => {
	it("reports a non-repo clearly", async () => {
		const plain = mkdtempSync(join(tmpdir(), "psk-nogit-"));
		try {
			const r = await loadDiff(plain);
			expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("is empty on a clean tree", async () => {
		write("a.txt", "a\n");
		commitAll();
		const r = await loadDiff(dir);
		expect(r).toMatchObject({ ok: true, files: [], label: "HEAD" });
	});

	it("combines unstaged, staged and untracked changes against HEAD", async () => {
		write("a.txt", "one\ntwo\n");
		write("b.txt", "b\n");
		commitAll();
		write("a.txt", "one\nTWO\n");
		git("add", "a.txt");
		write("a.txt", "one\nTWO\nthree\n");
		write("b.txt", "bb\n");
		write("new dir/c d.txt", "x\ny\n");
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		expect(r.files.map((f) => [f.path, f.status])).toEqual([
			["a.txt", "modified"],
			["b.txt", "modified"],
			["new dir/c d.txt", "untracked"],
		]);
		const [a, , c] = r.files;
		expect(a).toMatchObject({ additions: 2, deletions: 1 });
		expect(c?.lines.slice(-3)).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y"].slice(-3));
		expect(c).toMatchObject({ additions: 2, deletions: 0 });
	});

	it("works from a subdirectory and sees the whole repo", async () => {
		write("sub/a.txt", "a\n");
		commitAll();
		write("top.txt", "t\n");
		write("sub/a.txt", "changed\n");
		const r = await loadDiff(join(dir, "sub"));
		if (!r.ok) throw new Error(r.error);
		expect(r.files.map((f) => f.path).sort()).toEqual(["sub/a.txt", "top.txt"]);
	});

	it("handles a repo with no commits (staged + untracked)", async () => {
		write("a.txt", "a\n");
		git("add", "a.txt");
		write("b.txt", "b\n");
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		expect(r.label).toMatch(/no commits/);
		expect(r.files.map((f) => [f.path, f.status])).toEqual([
			["a.txt", "added"],
			["b.txt", "untracked"],
		]);
	});

	it("diffs against an explicit ref and rejects bad refs without crashing", async () => {
		write("a.txt", "1\n");
		commitAll("first");
		write("a.txt", "2\n");
		commitAll("second");
		const r = await loadDiff(dir, "HEAD~1");
		if (!r.ok) throw new Error(r.error);
		expect(r.files).toHaveLength(1);
		expect(r.label).toBe("HEAD~1");
		for (const bad of ["no-such-ref", "-p", "--output=/tmp/x", "a b"]) {
			const res = await loadDiff(dir, bad);
			expect(res.ok).toBe(false);
		}
		const msg = await loadDiff(dir, "no-such-ref");
		expect(msg).toMatchObject({ ok: false, error: expect.stringMatching(/bad ref "no-such-ref"/) });
	});

	it("skips untracked files for a commit range", async () => {
		write("a.txt", "1\n");
		commitAll("first");
		write("a.txt", "2\n");
		commitAll("second");
		write("loose.txt", "x\n");
		const r = await loadDiff(dir, "HEAD~1..HEAD");
		if (!r.ok) throw new Error(r.error);
		expect(r.files.map((f) => f.path)).toEqual(["a.txt"]);
	});

	it("honours .gitignore and lists untracked binaries, symlinks and empty files safely", async () => {
		write(".gitignore", "ignored.txt\n");
		commitAll();
		write("ignored.txt", "nope\n");
		write("bin.dat", Buffer.from([1, 2, 0, 3]));
		write("empty.txt", "");
		symlinkSync("../outside", join(dir, "link"));
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
		expect(Object.keys(byPath).sort()).toEqual(["bin.dat", "empty.txt", "link"]);
		expect(byPath["bin.dat"]?.lines.join("\n")).toContain("binary file (4 bytes)");
		expect(byPath["empty.txt"]?.lines.join("\n")).toContain("empty file");
		expect(byPath.link?.lines.at(-1)).toBe("+-> ../outside");
	});

	it("detects renames and keeps odd paths intact", async () => {
		write("old name.txt", "same content here\nmore\nlines\n");
		commitAll();
		git("mv", "old name.txt", "new\u00e9.txt");
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		expect(r.files[0]).toMatchObject({ path: "new\u00e9.txt", oldPath: "old name.txt", status: "renamed" });
	});

	it("caps big untracked files per file and says so", async () => {
		commitAllEmpty();
		write("big.txt", `${"line of text\n".repeat(40_000)}`);
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		const big = r.files[0];
		expect(big?.notice).toMatch(/file truncated at 200KB/);
		const bytes = big?.lines.reduce((n, l) => n + l.length + 1, 0) ?? 0;
		expect(bytes).toBeLessThan(PER_FILE_BYTES + 4096);
	});

	it("caps the untracked file count", async () => {
		commitAllEmpty();
		for (let i = 0; i < MAX_UNTRACKED_FILES + 5; i++) write(`u/f${String(i).padStart(4, "0")}.txt`, "x\n");
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		expect(r.files).toHaveLength(MAX_UNTRACKED_FILES);
		expect(r.notices.join()).toMatch(/5 more untracked files/);
	}, 60_000);

	it("caps a huge tracked diff at the total limit with a notice", async () => {
		write("huge.txt", "seed\n");
		commitAll();
		write("huge.txt", `${"changed line number\n".repeat(150_000)}`);
		const r = await loadDiff(dir);
		if (!r.ok) throw new Error(r.error);
		expect(r.files[0]?.notice).toBeDefined();
		expect(r.files[0]?.additions).toBeGreaterThan(1000);
	}, 60_000);

	it("never writes to the repo (no index refresh lock)", async () => {
		write("a.txt", "a\n");
		commitAll();
		write("a.txt", "b\n");
		const before = git("status", "--porcelain=v2");
		await loadDiff(dir);
		expect(git("status", "--porcelain=v2")).toBe(before);
	});
});

function commitAllEmpty() {
	git("commit", "-q", "--allow-empty", "-m", "init");
}

describe("loadStat", () => {
	it("returns the --stat plus ?? lines, and errors for non-repos and bad refs", async () => {
		write("a.txt", "1\n");
		commitAll();
		write("a.txt", "2\n");
		write("u.txt", "u\n");
		const r = await loadStat(dir);
		expect(r).toMatchObject({ ok: true });
		expect(r.ok && r.text).toContain("a.txt");
		expect(r.ok && r.text).toContain("?? u.txt");
		expect(await loadStat(dir, "nope")).toMatchObject({ ok: false });
		expect(await loadStat(tmpdir())).toMatchObject({ ok: false });
	});
});

describe("runGit / untrackedPatch", () => {
	it("stops git at the byte cap and flags truncation", async () => {
		write("a.txt", "x\n");
		commitAll();
		const r = await runGit(["log", "--format=%H%n%B"], { cwd: dir, maxBytes: 10 });
		expect(r.truncated).toBe(true);
		expect(r.stdout.length).toBe(10);
	});

	it("kills a SIGTERM-resistant git group and resolves when its grandchild holds pipes", async () => {
		const shim = join(dir, "git-shim");
		writeFileSync(shim, "#!/bin/sh\ntrap '' TERM\n/bin/sleep 30 &\nwait\n");
		chmodSync(shim, 0o755);
		const started = Date.now();
		const r = await runGit(["status"], { cwd: dir, cmd: shim, timeoutMs: 20 });
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(r.code).toBeNull();
	});

	it.each(["timeout", "cap"])("reaps a pipe-closing TERM-resistant descendant after %s", async (cause) => {
		const shim = join(dir, "git-shim");
		const pidfile = join(dir, "descendant");
		writeFileSync(
			shim,
			`#!/bin/sh\n/bin/sh -c 'trap "" TERM; exec >/dev/null 2>&1; echo $$ > "${pidfile}"; while :; do sleep 1; done' &\nwhile [ ! -s "${pidfile}" ]; do sleep 0.01; done\nprintf 'oversized output'\nwait\n`,
		);
		chmodSync(shim, 0o755);
		// Admit timeout/cap clocks only after the real shim has created its resistant descendant.
		// Its stdout is the readiness handshake, so host scheduling cannot race a 150ms deadline.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let ready!: () => void;
		const readiness = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const nativeSpawn = vi.mocked(spawn).getMockImplementation();
		if (!nativeSpawn) throw new Error("Missing native spawn implementation");
		vi.mocked(spawn).mockImplementationOnce((...args) => {
			const child = nativeSpawn(...args);
			child.stdout?.once("data", () => ready());
			return child;
		});
		let pid = 0;
		try {
			const running = runGit([], {
				cwd: dir,
				cmd: shim,
				timeoutMs: cause === "timeout" ? 150 : 5000,
				maxBytes: cause === "cap" ? 1 : 4096,
			});
			await readiness;
			pid = Number(readFileSync(pidfile, "utf8"));
			expect(pid).toBeGreaterThan(0);
			await vi.advanceTimersByTimeAsync(cause === "timeout" ? 2150 : 2000);
			expect((await running).truncated).toBe(cause === "cap");
			vi.useRealTimers();
			await waitFor(() => !alive(pid));
		} finally {
			vi.useRealTimers();
			if (!pid && existsSync(pidfile)) pid = Number(readFileSync(pidfile, "utf8"));
			try {
				if (pid > 0) process.kill(pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
	});

	it("reports a missing cwd as a spawn error instead of throwing", async () => {
		const r = await runGit(["status"], { cwd: join(dir, "does-not-exist") });
		expect(r.spawnError).toBeDefined();
	});

	it("marks a missing trailing newline and an unreadable path", async () => {
		write("n.txt", "no newline");
		const f = await untrackedPatch(dir, "n.txt", 1000);
		expect(f.lines.at(-1)).toBe("\\ No newline at end of file");
		const gone = await untrackedPatch(dir, "gone.txt", 1000);
		expect(gone.lines.at(-1)).toMatch(/unreadable/);
		const exhausted = await untrackedPatch(dir, "n.txt", 0);
		expect(exhausted.lines.at(-1)).toMatch(/budget/);
	});
});
