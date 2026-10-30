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
});
