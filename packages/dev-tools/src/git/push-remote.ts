/** Where `git_commit` pushes HEAD, resolved the way git itself picks a push remote. */

/** The slice of a finished git process the resolver reads. A stub can supply just these. */
export interface GitOutcome {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Runs `git <args>`; injected so tests can fail exactly one call. */
export type GitRunner = (args: readonly string[]) => Promise<GitOutcome>;

export type PushRemote = { remote: string; setUpstream: boolean } | { error: string };

const NO_RECOMMIT = "Do NOT commit again.";

const failure = (what: string, r: GitOutcome): { error: string } => ({
	error: `${what} failed (exit ${r.exitCode ?? "signal"}): ${r.stderr.trim() || "no output"}. ${NO_RECOMMIT}`,
});

/**
 * Precedence: `branch.<n>.pushRemote`, `remote.pushDefault`, `branch.<n>.remote`, then the sole remote.
 *
 * - Only `git config --get` exit 1 means unset; any other failure (e.g. 128, corrupt config) is real
 *   and fails closed with git's stderr.
 * - All three keys are read eagerly, so an unreadable key blocks the push even when a higher
 *   precedence key is set. Chosen over lazy reads because it is the more conservative: a config
 *   git cannot read is never pushed through.
 * - `branch.<n>.remote = .` (tracks a local branch) is not a push remote, and does not fall through
 *   to the sole remote either.
 * - Several remotes and nothing configured is ambiguous; this never defaults to `origin`.
 */
export async function resolvePushRemote(run: GitRunner): Promise<PushRemote> {
	const ref = await run(["symbolic-ref", "--short", "-q", "HEAD"]);
	if (ref.exitCode === 1) return { error: `HEAD is detached, so there is no branch to push. ${NO_RECOMMIT}` };
	if (ref.exitCode !== 0) return failure("git symbolic-ref", ref);
	const branch = ref.stdout.trim();

	const values: Array<string | undefined> = [];
	for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
		const r = await run(["config", "--get", key]);
		if (r.exitCode === 1) values.push(undefined);
		else if (r.exitCode !== 0) return failure(`git config --get ${key}`, r);
		else values.push(r.stdout.trim() || undefined);
	}
	const [pushRemote, pushDefault, tracked] = values;
	const remote = pushRemote ?? pushDefault ?? (tracked === "." ? undefined : tracked);
	if (remote) return { remote, setUpstream: false };

	const hint = `set \`branch.${branch}.pushRemote\` or \`remote.pushDefault\`. ${NO_RECOMMIT}`;
	if (tracked === ".")
		return { error: `\`branch.${branch}.remote\` is \`.\` (a local branch), so there is no push remote; ${hint}` };
	const remotes = await run(["remote"]);
	if (remotes.exitCode !== 0) return failure("git remote", remotes);
	const names = remotes.stdout.split("\n").filter(Boolean);
	if (names.length === 1) return { remote: names[0] as string, setUpstream: true };
	return {
		error: `no push remote for \`${branch}\` and ${names.length ? `remotes are ambiguous (${names.join(", ")})` : "there are no remotes"}; ${hint}`,
	};
}
