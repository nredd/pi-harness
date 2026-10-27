#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// This imported workspace follows the harness house style, not upstream's conventional commits.
const validSubject = (subject) => subject.length <= 72 && /^(?:[a-z][a-z0-9-]*: )?[A-Z][^\n]*[^.\s]$/.test(subject);
for (const subject of ["Resync computer-use with upstream", "rtl: Preserve the root target"]) assert.ok(validSubject(subject));
for (const subject of ["fix(browser): stabilize targeting", "lowercase subject", "Trailing period.", "A".repeat(73)]) assert.ok(!validSubject(subject));
const ignoredPrefixes = ["Merge ", "Revert "];

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function defaultRange() {
	const eventName = process.env.GITHUB_EVENT_NAME;
	const baseSha = process.env.GITHUB_BASE_SHA;
	const headSha = process.env.GITHUB_SHA || "HEAD";
	if (eventName === "pull_request" && baseSha) return `${baseSha}..${headSha}`;
	return "HEAD~1..HEAD";
}

const range = process.argv[2] ?? process.env.COMMIT_RANGE ?? defaultRange();
let subjects;
try {
	subjects = git(["log", "--format=%s", range]).split("\n").filter(Boolean);
} catch (error) {
	console.error(`Unable to read commits for range '${range}'.`);
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const invalid = subjects.filter((subject) => !ignoredPrefixes.some((prefix) => subject.startsWith(prefix)) && !validSubject(subject));

if (invalid.length > 0) {
	console.error("Invalid commit message(s):");
	for (const subject of invalid) console.error(`- ${subject}`);
	console.error("\nExpected a capitalized imperative subject, at most 72 characters, no trailing period or conventional-commit prefix.");
	console.error("Example: Preserve root targeting");
	process.exit(1);
}

console.log(`Checked ${subjects.length} commit message(s) in ${range}.`);
