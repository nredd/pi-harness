import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { main as commits } from "../check-commit-messages.mjs";

const quiet = { log() {}, error() {} };

test("commit policy fails closed across event, history and command failures", () => {
	const base = "a".repeat(40);
	const head = "b".repeat(64);
	const calls = [];
	const deps = {
		...quiet,
		env: {},
		read: () =>
			JSON.stringify({ before: base, after: head, pull_request: { base: { sha: base }, head: { sha: head } } }),
		exec: (_command, args) => {
			calls.push(args);
			return args[0] === "log" ? "Merge bad\nRevert bad\nValid subject\nrtl: Valid area\n" : "false";
		},
	};
	assert.equal(commits([], deps), 0);
	assert.equal(calls.at(-1)[2], "HEAD~1..HEAD");
	assert.equal(commits([], { ...deps, env: { COMMIT_RANGE: "explicit" } }), 0);
	assert.equal(calls.at(-1)[2], "explicit");
	for (const event of ["push", "pull_request", "pull_request_target"]) {
		const env = { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: "event.json" };
		assert.equal(commits([], { ...deps, env }), 0);
		assert.equal(calls.at(-1)[2], `${base}..${head}`);
		assert.equal(commits([], { ...deps, env: { GITHUB_EVENT_NAME: event } }), 1);
		for (const payload of [
			"invalid",
			"null",
			"{}",
			JSON.stringify({ before: "0".repeat(40), after: head }),
			JSON.stringify({ before: "branch", after: head }),
		])
			assert.equal(commits([], { ...deps, env, read: () => payload }), 1);
	}
	for (const range of ["", "--all"]) assert.equal(commits([range], deps), 1);
	assert.equal(commits([], { ...deps, exec: () => "true" }), 1);
	for (const error of [new Error("not a repository"), "non-Error refusal"])
		assert.equal(
			commits([], {
				...deps,
				exec: () => {
					throw error;
				},
			}),
			1,
		);
	assert.equal(
		commits([], { ...deps, exec: (_command, args) => (args[0] === "log" ? "lowercase\nTrailing period.\n" : "false") }),
		1,
	);
	assert.equal(commits([], { ...deps, exec: (_command, args) => (args[0] === "log" ? "" : "false") }), 0);
});

test("commit CLI dispatch is measured and imports without argv remain inert", async () => {
	const argv = process.argv;
	const env = process.env;
	const exitCode = process.exitCode;
	try {
		process.env = { ...env, COMMIT_RANGE: "HEAD..HEAD" };
		const url = new URL("../check-commit-messages.mjs", import.meta.url);
		process.argv = [process.execPath];
		vi.resetModules();
		await import(url.href);
		process.argv = [process.execPath, fileURLToPath(url)];
		vi.resetModules();
		await import(url.href);
	} finally {
		process.argv = argv;
		process.env = env;
		process.exitCode = exitCode;
	}
});
