#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This imported workspace follows the harness house style, not upstream's conventional commits.
const validSubject = (subject) => subject.length <= 72 && /^(?:[a-z][a-z0-9-]*: )?[A-Z][^\n]*[^.\s]$/.test(subject);
for (const subject of ["Resync computer-use with upstream", "rtl: Preserve the root target"])
	assert.ok(validSubject(subject));
for (const subject of ["fix(browser): stabilize targeting", "lowercase subject", "Trailing period.", "A".repeat(73)])
	assert.ok(!validSubject(subject));
const ignoredPrefixes = ["Merge ", "Revert "];

/** Require event object identities, never branch names, zero SHAs or a synthetic merge commit. */
function eventSha(value, field) {
	if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) || /^0+$/.test(value)) {
		throw new Error(
			`GitHub event field '${field}' must contain a nonzero full commit SHA; supply COMMIT_RANGE explicitly if this event has no comparison base.`,
		);
	}
	return value;
}

/** Validate complete Git history, with process/file boundaries injectable for offline refusals. */
export function main(
	argv = process.argv.slice(2),
	deps = { exec: execFileSync, read: readFileSync, env: process.env, log: console.log, error: console.error },
) {
	const git = (args) => deps.exec("git", args, { encoding: "utf8" }).trim();
	// GitHub provides the event payload path, not a GITHUB_BASE_SHA variable. Fail closed in CI.
	function defaultRange() {
		const eventName = deps.env.GITHUB_EVENT_NAME;
		if (!["pull_request", "pull_request_target", "push"].includes(eventName)) return "HEAD~1..HEAD";
		if (!deps.env.GITHUB_EVENT_PATH)
			throw new Error("GITHUB_EVENT_PATH is required to select a PR or push commit range.");
		let event;
		try {
			event = JSON.parse(deps.read(deps.env.GITHUB_EVENT_PATH, "utf8"));
		} catch {
			throw new Error("Unable to read or parse the GitHub event payload at GITHUB_EVENT_PATH.");
		}
		if (eventName === "push") return `${eventSha(event?.before, "before")}..${eventSha(event?.after, "after")}`;
		return `${eventSha(event?.pull_request?.base?.sha, "pull_request.base.sha")}..${eventSha(event?.pull_request?.head?.sha, "pull_request.head.sha")}`;
	}
	let range;
	let subjects;
	try {
		range = argv[0] ?? deps.env.COMMIT_RANGE ?? defaultRange();
		if (!range || range.startsWith("-"))
			throw new Error("Commit range must be a revision or revision range, not an empty value or Git option.");
		// Existing endpoints do not prove a complete range: Git can silently stop at a shallow boundary.
		if (git(["rev-parse", "--is-shallow-repository"]) === "true")
			throw new Error("Commit validation requires complete history, but this repository is shallow.");
		subjects = git(["log", "--format=%s", range, "--"]).split("\n").filter(Boolean);
	} catch (error) {
		deps.error(range ? `Unable to read commits for range '${range}'.` : "Unable to select a commit range.");
		deps.error(error instanceof Error ? error.message : String(error));
		try {
			if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
				deps.error(
					"Commit validation cannot use missing history in a shallow checkout; fetch complete history (actions/checkout fetch-depth: 0). No commits were skipped or accepted.",
				);
			}
		} catch {
			/* Outside a Git repository; preserve the original validation failure. */
		}
		return 1;
	}
	const invalid = subjects.filter(
		(subject) => !ignoredPrefixes.some((prefix) => subject.startsWith(prefix)) && !validSubject(subject),
	);
	if (invalid.length > 0) {
		deps.error("Invalid commit message(s):");
		for (const subject of invalid) deps.error(`- ${subject}`);
		deps.error(
			"\nExpected a capitalized imperative subject, at most 72 characters, no trailing period or conventional-commit prefix.",
		);
		deps.error("Example: Preserve root targeting");
		return 1;
	}
	deps.log(`Checked ${subjects.length} commit message(s) in ${range}.`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
