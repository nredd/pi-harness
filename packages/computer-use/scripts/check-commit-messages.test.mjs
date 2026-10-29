#!/usr/bin/env node
// Exercise the actual CLI against disposable Git histories, including a depth-one file:// clone.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const checker = fileURLToPath(new URL("./check-commit-messages.mjs", import.meta.url));
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !key.startsWith("GIT_") && !key.startsWith("GITHUB_") && key !== "COMMIT_RANGE",
	),
);
// Fixture commits never use the owner's hooks, credentials or signing identity.
Object.assign(env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" });

function fixture(t) {
	const work = mkdtempSync(path.join(os.tmpdir(), "cu-commit-range-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));
	const repo = path.join(work, "repo");
	mkdirSync(repo);
	const git = (...args) =>
		execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Commit fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "commit.gpgsign", "false");
	const commit = (subject) => {
		git("commit", "--allow-empty", "-qm", subject);
		return git("rev-parse", "HEAD");
	};
	const base = commit("Seed fixture");
	const payload = (value) => {
		const file = path.join(work, "event.json");
		writeFileSync(file, JSON.stringify(value));
		return file;
	};
	const run = (extra = {}, args = [], cwd = repo) =>
		spawnSync(process.execPath, [checker, ...args], {
			cwd,
			env: { ...env, ...extra },
			encoding: "utf8",
			timeout: 10_000,
		});
	return { work, repo, git, commit, base, payload, run };
}

function passed(result, range, count) {
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes(`Checked ${count} commit message(s) in ${range}.`), result.stdout);
}

function failed(result, message) {
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, message);
}

test("pull_request reads actual base/head SHAs from the event, not branch names or synthetic merge SHA", (t) => {
	const f = fixture(t);
	f.git("checkout", "-qb", "feature");
	f.commit("Validate first change");
	const head = f.commit("Validate second change");
	f.git("checkout", "-q", "main");
	const base = f.commit("Advance base");
	f.git("merge", "--no-ff", "-qm", "Merge fixture", "feature");
	const merge = f.git("rev-parse", "HEAD");
	const event = f.payload({ pull_request: { base: { sha: base }, head: { sha: head } } });
	passed(
		f.run({
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_EVENT_PATH: event,
			GITHUB_BASE_REF: "main",
			GITHUB_BASE_SHA: "not-a-real-variable",
			GITHUB_SHA: merge,
		}),
		`${base}..${head}`,
		2,
	);
});

test("pull_request rejects an invalid intermediate commit even when the tip and synthetic merge are valid", (t) => {
	const f = fixture(t);
	f.git("checkout", "-qb", "feature");
	f.commit("invalid intermediate subject");
	const head = f.commit("Validate tip");
	f.git("checkout", "-q", "main");
	f.git("merge", "--no-ff", "-qm", "Merge fixture", "feature");
	const event = f.payload({ pull_request: { base: { sha: f.base }, head: { sha: head } } });
	failed(
		f.run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_SHA: f.git("rev-parse", "HEAD") }),
		/invalid intermediate subject/,
	);
});

test("push reads before/after from the event and checks every pushed commit", (t) => {
	const f = fixture(t);
	const before = f.commit("invalid older subject outside the push");
	f.commit("Validate first push change");
	const after = f.commit("Validate second push change");
	const event = f.payload({ before, after });
	passed(f.run({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_SHA: f.base }), `${before}..${after}`, 2);
	const invalidRange = f.payload({ before: f.base, after });
	failed(
		f.run({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: invalidRange }),
		/invalid older subject outside the push/,
	);
});

test("local defaults to the latest commit and preserves explicit CLI-over-env range precedence", (t) => {
	const f = fixture(t);
	f.commit("invalid previous subject");
	f.commit("Validate current subject");
	passed(f.run(), "HEAD~1..HEAD", 1);
	failed(f.run({ COMMIT_RANGE: "HEAD~2..HEAD" }), /invalid previous subject/);
	passed(
		f.run({ COMMIT_RANGE: "HEAD~2..HEAD", GITHUB_EVENT_NAME: "pull_request" }, ["HEAD~1..HEAD"]),
		"HEAD~1..HEAD",
		1,
	);
	failed(f.run({}, ["unavailable-base..HEAD"]), /Unable to read commits/);
	failed(f.run({}, ["--max-count=0"]), /Git option/);
	failed(f.run({ COMMIT_RANGE: "" }), /empty value/);
});

test("PR and push contexts fail closed when event identity is missing or malformed", (t) => {
	const f = fixture(t);
	f.commit("Validate current subject");
	for (const eventName of ["pull_request", "pull_request_target", "push"]) {
		failed(f.run({ GITHUB_EVENT_NAME: eventName }), /GITHUB_EVENT_PATH/);
	}
	const malformed = path.join(f.work, "malformed.json");
	writeFileSync(malformed, "not json");
	failed(f.run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: malformed }), /event payload/);
	for (const value of [{}, { pull_request: { base: { sha: "main" }, head: { sha: f.base } } }]) {
		failed(
			f.run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: f.payload(value) }),
			/pull_request\.base\.sha/,
		);
	}
	failed(
		f.run({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: f.payload({ before: "0".repeat(40), after: f.base }) }),
		/before/,
	);
});

test("depth-one history never silently passes PR, push or local validation; restored history detects bad commits", (t) => {
	const f = fixture(t);
	const hidden = f.commit("invalid hidden subject");
	const head = f.commit("Validate visible tip");
	const shallow = path.join(f.work, "shallow");
	execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(f.repo).href, shallow], { env });
	assert.equal(
		execFileSync("git", ["-C", shallow, "rev-parse", "--is-shallow-repository"], { env, encoding: "utf8" }).trim(),
		"true",
	);
	const prEvent = f.payload({ pull_request: { base: { sha: f.base }, head: { sha: head } } });
	const pr = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: prEvent };
	failed(f.run(pr, [], shallow), /shallow checkout.*fetch-depth: 0/i);
	failed(f.run({}, [], shallow), /shallow checkout.*fetch-depth: 0/i);
	const push = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: path.join(f.work, "push.json") };
	writeFileSync(push.GITHUB_EVENT_PATH, JSON.stringify({ before: f.base, after: head }));
	failed(f.run(push, [], shallow), /shallow checkout.*fetch-depth: 0/i);
	// Both endpoints can exist while an invalid intermediate commit is still hidden by a boundary.
	execFileSync("git", ["-C", shallow, "fetch", "-q", "--depth", "1", "origin", f.base], { env });
	execFileSync("git", ["-C", shallow, "cat-file", "-e", f.base], { env });
	failed(f.run(pr, [], shallow), /shallow checkout.*fetch-depth: 0/i);
	execFileSync("git", ["-C", shallow, "fetch", "-q", "--unshallow", "origin"], { env });
	failed(f.run(pr, [], shallow), /invalid hidden subject/);
	failed(f.run(push, [], shallow), /invalid hidden subject/);
	passed(f.run({}, [], shallow), "HEAD~1..HEAD", 1);
	// Reproduce CI's fix: full history plus the event range passes a valid change.
	const validPr = f.payload({ pull_request: { base: { sha: hidden }, head: { sha: head } } });
	passed(f.run({ ...pr, GITHUB_EVENT_PATH: validPr }, [], shallow), `${hidden}..${head}`, 1);
	writeFileSync(push.GITHUB_EVENT_PATH, JSON.stringify({ before: hidden, after: head }));
	passed(f.run(push, [], shallow), `${hidden}..${head}`, 1);
});

test("owned CI checkout supplies complete history for event-selected ranges", () => {
	const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
	const owned = workflow.slice(workflow.indexOf("\n  owned:"), workflow.indexOf("\n  contracts:"));
	const checkout = owned.match(/- uses: actions\/checkout@[^\n]+[\s\S]*?(?=\n {6}- |$)/)?.[0];
	assert.ok(checkout, "owned checkout must exist");
	assert.match(checkout, /fetch-depth: 0/, "owned checkout must fetch event base/head history");
});
