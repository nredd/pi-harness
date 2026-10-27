import { describe, expect, it } from "vitest";
import { type GitOutcome, type GitRunner, resolvePushRemote } from "../../src/git/push-remote.ts";

const ok = (stdout = ""): GitOutcome => ({ exitCode: 0, stdout, stderr: "" });
const unset: GitOutcome = { exitCode: 1, stdout: "", stderr: "" };
const fail = (exitCode: number, stderr: string): GitOutcome => ({ exitCode, stdout: "", stderr });

/** Stub runner: `answers` maps `args.join(" ")` to an outcome; anything unlisted is unset (exit 1). */
function stub(answers: Record<string, GitOutcome>): { run: GitRunner; calls: string[] } {
	const calls: string[] = [];
	const run: GitRunner = async (args) => {
		const key = args.join(" ");
		calls.push(key);
		return answers[key] ?? unset;
	};
	return { run, calls };
}
const HEAD = "symbolic-ref --short -q HEAD";

describe("resolvePushRemote with one failing git call", () => {
	it("fails closed on config --get exit 128 and relays stderr", async () => {
		const { run, calls } = stub({
			[HEAD]: ok("main\n"),
			"config --get remote.pushDefault": fail(128, "fatal: bad config line 7 in file .git/config"),
		});
		const r = await resolvePushRemote(run);
		expect(r).toEqual({
			error:
				"git config --get remote.pushDefault failed (exit 128): fatal: bad config line 7 in file .git/config. Do NOT commit again.",
		});
		expect(calls).not.toContain("remote");
	});

	it("treats config --get exit 1 as unset and carries on", async () => {
		const { run } = stub({ [HEAD]: ok("main\n"), remote: ok("fork\n") });
		expect(await resolvePushRemote(run)).toEqual({ remote: "fork", setUpstream: true });
	});

	it("reads all three keys eagerly: an unreadable key blocks even when pushRemote is set", async () => {
		const { run, calls } = stub({
			[HEAD]: ok("main\n"),
			"config --get branch.main.pushRemote": ok("fork\n"),
			"config --get branch.main.remote": fail(128, "fatal: unable to read config file"),
		});
		const r = await resolvePushRemote(run);
		expect("error" in r && r.error).toContain("unable to read config file");
		expect(calls).toContain("config --get branch.main.remote");
	});

	it("reports git remote's real stderr, not 'no remotes'", async () => {
		const { run } = stub({ [HEAD]: ok("main\n"), remote: fail(128, "fatal: unable to read remotes") });
		const r = await resolvePushRemote(run);
		expect(r).toEqual({ error: "git remote failed (exit 128): fatal: unable to read remotes. Do NOT commit again." });
		expect("error" in r && r.error).not.toContain("no remotes");
	});

	it("fails closed when symbolic-ref exits other than 1, with its stderr", async () => {
		const { run, calls } = stub({ [HEAD]: fail(128, "fatal: not a git repository") });
		const r = await resolvePushRemote(run);
		expect(r).toEqual({
			error: "git symbolic-ref failed (exit 128): fatal: not a git repository. Do NOT commit again.",
		});
		expect("error" in r && r.error).not.toContain("detached");
		expect(calls).toEqual([HEAD]);
	});

	it("does not duplicate stderr in the message", async () => {
		const { run } = stub({ [HEAD]: ok("main\n"), remote: fail(128, "fatal: not a git repository") });
		const r = await resolvePushRemote(run);
		expect("error" in r && r.error.match(/not a git repository/g)).toHaveLength(1);
	});
});
