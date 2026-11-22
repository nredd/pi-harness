import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, vi } from "vitest";
import { git, makeGitFixture } from "../src/git.ts";
import { makeTestTempDir } from "../src/temp-dir.ts";

test("fixture holds one of every working-tree state against a bare remote", ({ onTestFinished }) => {
	const { repo, remote } = makeGitFixture(onTestFinished);
	expect(git(repo, "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/main");
	expect(git(remote, "rev-parse", "--is-bare-repository").trim()).toBe("true");
	const status = git(repo, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).sort();
	expect(status).toEqual(['?? "spaced name.txt"', " M a.txt", "A  c.txt", "R  old.txt -> renamed.txt"].sort());
});

test("git commits with the fixed identity and no signing", ({ onTestFinished }) => {
	const { repo } = makeGitFixture(onTestFinished);
	git(repo, "commit", "-q", "-m", "More");
	expect(git(repo, "log", "-1", "--format=%an <%ae>").trim()).toBe("h <h@h>");
});

test("fixture registers one cleanup that removes the clone and the remote", ({ onTestFinished }) => {
	// An independently removed root, so a failed registration assertion cannot strand the fixture.
	const scratch = makeTestTempDir("pi-test-lib-", onTestFinished);
	for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, scratch);
	onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	const cleanups: (() => void)[] = [];
	const { repo, remote } = makeGitFixture((cleanup) => cleanups.push(cleanup));
	expect(dirname(remote)).toBe(dirname(repo));
	expect(dirname(dirname(repo))).toBe(scratch);
	expect(cleanups).toHaveLength(1);
	for (const cleanup of cleanups) cleanup();
	expect(existsSync(dirname(repo))).toBe(false);
	expect(readdirSync(scratch)).toEqual([]);
});
