import { execFileSync } from "node:child_process";
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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { prepareMerge } from "../../src/git/merge.ts";
import { createMockPi } from "../support.ts";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: ENV }).trim();
}

const mock = createMockPi();
beforeAll(() => registerGitTools(mock.pi));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real repository paused at a content-conflicting merge, with its conflict resolved but unstaged. */
function mergeFixture(): { root: string; repo: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-merge-"));
	roots.push(root);
	const repo = join(root, "repo");
	git(root, ["init", "-q", "-b", "main", repo]);
	git(repo, ["config", "user.name", "fixture"]);
	git(repo, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(repo, "shared.txt"), "base\n");
	writeFileSync(join(repo, "other.txt"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "Initial"]);
	git(repo, ["switch", "-qc", "topic"]);
	writeFileSync(join(repo, "shared.txt"), "topic\n");
	git(repo, ["commit", "-qam", "Topic"]);
	git(repo, ["switch", "-q", "main"]);
	writeFileSync(join(repo, "shared.txt"), "main\n");
	git(repo, ["commit", "-qam", "Main"]);
	expect(() => git(repo, ["merge", "--no-commit", "topic"])).toThrow();
	writeFileSync(join(repo, "shared.txt"), "resolved\n");
	return { root, repo };
}

function parents(repo: string): string[] {
	return git(repo, ["show", "-s", "--format=%P", "HEAD"]).split(" ").filter(Boolean);
}

describe("git_commit merge approval", () => {
	it("commits a fully approved resolved merge with both parents", async () => {
		const { repo } = mergeFixture();
		const before = git(repo, ["rev-parse", "HEAD"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Merge resolved topic", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(repo)).toHaveLength(2);
		expect(parents(repo)[0]).toBe(before);
		expect(git(repo, ["show", "HEAD:shared.txt"])).toBe("resolved");
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
	});

	it("approves the complete merge from a subdirectory with relative diffs enabled", async () => {
		const { repo } = mergeFixture();
		const sub = join(repo, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "file"), "approved\n");
		git(repo, ["config", "diff.relative", "true"]);
		const before = git(repo, ["rev-parse", "HEAD"]);
		const topic = git(repo, ["rev-parse", "topic"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Merge from subdirectory", paths: [join(repo, "shared.txt"), "file"], push: false },
			sub,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(repo)).toEqual([before, topic]);
		expect(git(repo, ["show", "HEAD:shared.txt"])).toBe("resolved");
		expect(git(repo, ["show", "HEAD:sub/file"])).toBe("approved");
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
	});

	it("rejects an unapproved staged path outside a subdirectory with relative diffs enabled", async () => {
		const { repo } = mergeFixture();
		const sub = join(repo, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "file"), "approved\n");
		writeFileSync(join(repo, "other.txt"), "unrelated\n");
		git(repo, ["add", "other.txt"]);
		git(repo, ["config", "diff.relative", "true"]);
		const before = git(repo, ["rev-parse", "HEAD"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject outside staged path", paths: [join(repo, "shared.txt"), "file"], push: false },
			sub,
		);
		expect(result.isError, mock.text(result)).toBe(true);
		expect(mock.text(result)).toContain('Merge index contains unapproved paths: "other.txt"');
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
		expect(git(repo, ["show", ":other.txt"])).toBe("unrelated");
		expect(git(repo, ["show", "HEAD:other.txt"])).toBe("base");
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
	});

	it("preserves root-relative configured hooks when called from a subdirectory", async () => {
		const { root, repo } = mergeFixture();
		const sub = join(repo, "sub");
		const hooks = join(repo, "hooks");
		mkdirSync(sub);
		mkdirSync(hooks);
		const marker = join(root, "relative-hook-ran");
		writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`, {
			mode: 0o700,
		});
		git(repo, ["config", "core.hooksPath", "hooks"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Preserve relative merge hook", paths: [join(repo, "shared.txt")], push: false },
			sub,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(repo)).toHaveLength(2);
		expect(existsSync(marker), "configured root-relative pre-commit hook must execute").toBe(true);
		expect(readFileSync(marker, "utf8")).toBe("ran");
	});

	it("rejects root-relative hooks staging outside a subdirectory with relative diffs enabled", async () => {
		const { root, repo } = mergeFixture();
		const sub = join(repo, "sub");
		const hooks = join(repo, "hooks");
		mkdirSync(sub);
		mkdirSync(hooks);
		writeFileSync(join(sub, "file"), "approved\n");
		writeFileSync(join(repo, "other.txt"), "unrelated\n");
		const marker = join(root, "relative-commit-msg-ran");
		writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ngit add other.txt\n`, {
			mode: 0o700,
		});
		git(repo, ["config", "core.hooksPath", "hooks"]);
		git(repo, ["config", "diff.relative", "true"]);
		const before = git(repo, ["rev-parse", "HEAD"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject outside hook path", paths: [join(repo, "shared.txt"), "file"], push: false },
			sub,
		);
		expect(result.isError, mock.text(result)).toBe(true);
		expect(mock.text(result)).toContain('Merge index contains unapproved paths: "other.txt"');
		expect(readFileSync(marker, "utf8")).toBe("ran");
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
		expect(git(repo, ["show", ":other.txt"])).toBe("unrelated");
		expect(git(repo, ["show", "HEAD:other.txt"])).toBe("base");
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
	});

	it("rejects unresolved, partially approved, and unrelated staged merge indexes", async () => {
		const { repo } = mergeFixture();
		const unresolved = await mock.call(
			"git_commit",
			{ subject: "Merge unresolved topic", paths: ["other.txt"], push: false },
			repo,
		);
		expect(unresolved.isError).toBe(true);
		expect(mock.text(unresolved)).toContain("unresolved conflicts");
		git(repo, ["add", "shared.txt"]);
		writeFileSync(join(repo, "other.txt"), "unrelated\n");
		git(repo, ["add", "other.txt"]);
		const partial = await mock.call(
			"git_commit",
			{ subject: "Merge partial topic", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(partial.isError).toBe(true);
		expect(mock.text(partial)).toContain('Merge index contains unapproved paths: "other.txt"');
		expect(parents(repo)).toHaveLength(1);
	});

	it("accepts a symlinked worktree spelling", async () => {
		const { root, repo } = mergeFixture();
		const alias = join(root, "repo-alias");
		symlinkSync(repo, alias);
		const result = await mock.call(
			"git_commit",
			{ subject: "Merge through symlink", paths: ["shared.txt"], push: false },
			alias,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(repo)).toHaveLength(2);
	});

	it("accepts a configured no-hooks path", async () => {
		const { repo } = mergeFixture();
		git(repo, ["config", "core.hooksPath", "/dev/null"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Merge without hooks", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(repo)).toHaveLength(2);
	});

	it("uses the linked worktree git dir and configured hooks without bypassing them", async () => {
		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		const marker = join(root, "pre-commit-ran");
		writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
		git(repo, ["config", "core.hooksPath", hooks]);
		const linked = join(root, "linked");
		git(repo, ["worktree", "add", "-q", "-b", "linked", linked, "topic"]);
		expect(() => git(linked, ["merge", "--no-commit", "main"])).toThrow();
		writeFileSync(join(linked, "shared.txt"), "linked resolved\n");
		const result = await mock.call(
			"git_commit",
			{ subject: "Merge main in linked worktree", paths: ["shared.txt"], push: false },
			linked,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(parents(linked)).toHaveLength(2);
		expect(readFileSync(marker, "utf8")).toBe("ran");
	});

	it("rejects a hook that stages a path outside the approved merge", async () => {
		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(repo, "outside.txt"), "outside\n");
		writeFileSync(join(hooks, "commit-msg"), "#!/bin/sh\ngit add outside.txt\n", { mode: 0o700 });
		git(repo, ["config", "core.hooksPath", hooks]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject staged hook path", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError).toBe(true);
		expect(mock.text(result)).toContain('Merge index contains unapproved paths: "outside.txt"');
		expect(parents(repo)).toHaveLength(1);
	});

	it("keeps configured signing enabled with a controlled signer", async () => {
		const { root, repo } = mergeFixture();
		const gpg = join(root, "gpg");
		const invoked = join(root, "gpg-invoked");
		writeFileSync(
			gpg,
			`#!/bin/sh\nprintf signed > ${JSON.stringify(invoked)}\nprintf '[GNUPG:] SIG_CREATED D 1 10 00 0 0 0 0 0 0\\n' >&2\nprintf '%s\\n' '-----BEGIN PGP SIGNATURE-----' fake '-----END PGP SIGNATURE-----'\n`,
			{ mode: 0o700 },
		);
		chmodSync(gpg, 0o700);
		git(repo, ["config", "commit.gpgsign", "true"]);
		git(repo, ["config", "gpg.format", "openpgp"]);
		git(repo, ["config", "gpg.program", gpg]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Sign resolved merge", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		expect(existsSync(invoked), mock.text(result)).toBe(true);
		expect(readFileSync(invoked, "utf8")).toBe("signed");
		expect(git(repo, ["cat-file", "-p", "HEAD"])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
	});

	it("keeps reference-transaction hooks enabled for merges", async () => {
		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(
			join(hooks, "reference-transaction"),
			'#!/bin/sh\nif [ "$1" = prepared ]; then echo reference refusal >&2; exit 1; fi\n',
			{ mode: 0o700 },
		);
		git(repo, ["config", "core.hooksPath", hooks]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Relay reference hook failure", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError).toBe(true);
		expect(mock.text(result)).toContain("reference refusal");
		expect(parents(repo)).toHaveLength(1);
	});

	it("relays an actual merge hook failure without committing", async () => {
		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho hook refusal >&2\nexit 1\n", { mode: 0o700 });
		git(repo, ["config", "core.hooksPath", hooks]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Relay merge hook failure", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError).toBe(true);
		expect(mock.text(result)).toContain("hook refusal");
		expect(parents(repo)).toHaveLength(1);
	});

	it("rejects a merge whose identity changes between approval and the index check", async () => {
		const { repo } = mergeFixture();
		const merge = await prepareMerge(["shared.txt"], { cwd: repo });
		expect(merge).toBeDefined();
		try {
			writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${git(repo, ["rev-parse", "HEAD"])}\n`);
			await expect(merge?.check()).rejects.toThrow("Merge identity changed; review the merge again");
		} finally {
			merge?.cleanup();
		}
	});

	it("reports an unreadable MERGE_HEAD instead of treating it as no merge", async () => {
		const { repo } = mergeFixture();
		rmSync(join(repo, ".git", "MERGE_HEAD"));
		mkdirSync(join(repo, ".git", "MERGE_HEAD"));
		await expect(prepareMerge(["shared.txt"], { cwd: repo })).rejects.toThrow(/EISDIR/);
	});

	it("rejects a malformed MERGE_HEAD", async () => {
		const { repo } = mergeFixture();
		writeFileSync(join(repo, ".git", "MERGE_HEAD"), "not-a-sha\n");
		await expect(prepareMerge(["shared.txt"], { cwd: repo })).rejects.toThrow("Invalid MERGE_HEAD");
	});

	it("rejects approved paths outside the worktree", async () => {
		const { repo } = mergeFixture();
		for (const path of ["../outside.txt", "..", "."])
			await expect(prepareMerge([path], { cwd: repo })).rejects.toThrow(
				"Merge paths must name complete files inside the worktree",
			);
	});

	it("accepts an absolute path spelled through a symlinked cwd, including a deleted file", async () => {
		const { root, repo } = mergeFixture();
		const alias = join(root, "repo-alias");
		symlinkSync(repo, alias);
		const prepared = await prepareMerge(
			[join(alias, "shared.txt"), join(alias, "gone.txt"), join(alias, "no", "such", "dir.txt")],
			{ cwd: alias },
		);
		prepared?.cleanup();
		expect(prepared).toBeDefined();
	});

	it("rejects absolute paths that escape the worktree, directly or through a symlink", async () => {
		const { root, repo } = mergeFixture();
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(repo, "escape"));
		for (const path of [join(outside, "x.txt"), join(repo, "escape", "x.txt"), "escape/x.txt"])
			await expect(prepareMerge([path], { cwd: repo })).rejects.toThrow(
				"Merge paths must name complete files inside the worktree",
			);
	});

	it("reports a conflict outside the caller's subdirectory as unresolved", async () => {
		const { repo } = mergeFixture();
		const sub = join(repo, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "file"), "approved\n");
		git(repo, ["checkout", "-q", "--merge", "--", "shared.txt"]);
		writeFileSync(join(repo, "shared.txt"), "still conflicted\n");
		const conflicted = git(repo, ["ls-files", "--unmerged"]);
		expect(conflicted).toContain("shared.txt");
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject hidden conflict", paths: ["file"], push: false },
			sub,
		);
		expect(result.isError).toBe(true);
		expect(mock.text(result)).toContain("Merge has unresolved conflicts");
	});

	it("keeps every hook in the configured hooks directory enabled for merges", async () => {
		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		const marker = join(root, "post-index-change-ran");
		writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\nprintf x >> ${JSON.stringify(marker)}\n`, {
			mode: 0o700,
		});
		git(repo, ["config", "core.hooksPath", hooks]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Preserve post-index-change", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError, mock.text(result)).toBe(false);
		// Once for the staging `git add`, once more for the merge commit itself.
		expect(readFileSync(marker, "utf8")).toBe("xx");
	});

	it("leaves the named paths staged when a merge is rejected", async () => {
		const { repo } = mergeFixture();
		writeFileSync(join(repo, "other.txt"), "unrelated\n");
		git(repo, ["add", "other.txt"]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject staged leftovers", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError).toBe(true);
		expect(git(repo, ["show", ":shared.txt"])).toBe("resolved");
	});

	it("keeps ordinary-commit failures at the add stage outside a repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dev-tools-nogit-"));
		roots.push(dir);
		const result = await mock.call("git_commit", { subject: "Add nothing here", paths: ["a.txt"], push: false }, dir);
		expect(result.isError).toBe(true);
		expect((result.structuredContent as { stage: string }).stage).toBe("add");
		expect(mock.text(result)).toContain("git add");
	});

	it("reports a malformed MERGE_HEAD at the validate stage", async () => {
		const { repo } = mergeFixture();
		writeFileSync(join(repo, ".git", "MERGE_HEAD"), "not-a-sha\n");
		const result = await mock.call(
			"git_commit",
			{ subject: "Reject malformed merge", paths: ["shared.txt"], push: false },
			repo,
		);
		expect((result.structuredContent as { stage: string }).stage).toBe("validate");
		expect(mock.text(result)).toContain("Invalid MERGE_HEAD");
	});

	it("rethrows an aborted repository query instead of treating it as no merge", async () => {
		const { repo } = mergeFixture();
		const controller = new AbortController();
		controller.abort();
		await expect(prepareMerge(["shared.txt"], { cwd: repo, signal: controller.signal })).rejects.toThrow(
			/git merge approval/,
		);
	});

	it.each([
		["pre-commit", true],
		["post-commit", false],
	])("matches plain Git when %s is a directory (blocks: %s)", async (hook, blocks) => {
		// Observed on Apple Git 2.54.0: a `pre-commit/` directory is `cannot exec ... Permission denied` and
		// refuses the commit; a `post-commit/` directory prints the same error but the commit still lands.
		const plain = mkdtempSync(join(tmpdir(), "pi-dev-tools-plain-"));
		roots.push(plain);
		git(plain, ["init", "-q", "-b", "main"]);
		git(plain, ["config", "user.name", "fixture"]);
		git(plain, ["config", "user.email", "fixture@example.invalid"]);
		mkdirSync(join(plain, "hooks", hook), { recursive: true });
		git(plain, ["config", "core.hooksPath", join(plain, "hooks")]);
		writeFileSync(join(plain, "a.txt"), "a\n");
		git(plain, ["add", "a.txt"]);
		let plainFailed = false;
		try {
			git(plain, ["commit", "-qm", "Plain"]);
		} catch {
			plainFailed = true;
		}
		expect(plainFailed).toBe(blocks);

		const { root, repo } = mergeFixture();
		const hooks = join(root, "hooks");
		mkdirSync(join(hooks, hook), { recursive: true });
		git(repo, ["config", "core.hooksPath", hooks]);
		const result = await mock.call(
			"git_commit",
			{ subject: "Match plain Git", paths: ["shared.txt"], push: false },
			repo,
		);
		expect(result.isError).toBe(blocks);
		expect(parents(repo)).toHaveLength(blocks ? 1 : 2);
		if (blocks) expect(mock.text(result)).toContain(join(hooks, hook));
	});
});
