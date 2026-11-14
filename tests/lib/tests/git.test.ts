import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { git, makeGitFixture } from "../src/git.ts";

test("fixture holds one of every working-tree state against a bare remote", () => {
	const { repo, remote } = makeGitFixture();
	try {
		expect(git(repo, "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/main");
		expect(git(remote, "rev-parse", "--is-bare-repository").trim()).toBe("true");
		const status = git(repo, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).sort();
		expect(status).toEqual(['?? "spaced name.txt"', " M a.txt", "A  c.txt", "R  old.txt -> renamed.txt"].sort());
	} finally {
		rmSync(dirname(repo), { recursive: true, force: true });
	}
});

test("git commits with the fixed identity and no signing", () => {
	const { repo } = makeGitFixture();
	try {
		git(repo, "commit", "-q", "-m", "More");
		expect(git(repo, "log", "-1", "--format=%an <%ae>").trim()).toBe("h <h@h>");
	} finally {
		rmSync(dirname(repo), { recursive: true, force: true });
	}
});
