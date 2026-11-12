import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	upstreamRowNames,
	validateLedger,
	validateLedgerOrder,
	validateUpstreamRows,
} from "../scripts/check-sync-ledger.mjs";

const control = { name: "remove behavior", file: "src/a.ts", check: "check-a.mjs" };
const ledger = {
	files: [control.file],
	absorbed: [
		{
			id: "root-targeting",
			upstream: { status: "merged-upstream", reference: "https://github.com/injaneity/pi-computer-use/pull/95" },
		},
	],
	release: {
		upstream: { status: "release-requested", reference: "https://github.com/injaneity/pi-computer-use/issues/116" },
	},
	patches: [
		{
			id: "a",
			purpose: "Retain behavior",
			upstream: { status: "harness-only", reference: "UPSTREAM.md" },
			files: [control.file],
			check: control.check,
			dropControls: [control.name],
		},
	],
};

test("accepts complete structured metadata and rejects each missing status/drop proof", () => {
	validateLedger(ledger, [control]);
	for (const field of ["upstream", "dropControls", "files", "check", "purpose"]) {
		const broken = structuredClone(ledger);
		delete broken.patches[0][field];
		assert.throws(() => validateLedger(broken, [control]), new RegExp(field));
	}
	assert.throws(() => validateLedger(ledger, []), /unknown drop control/);
	assert.throws(() => validateLedger(ledger, [{ ...control, file: "src/b.ts" }]), /not owned/);
	assert.throws(() => validateLedger(ledger, [{ ...control, check: "wrong" }]), /mismatch/);
});

test("real revert inventory agrees with the checked-in ledger", () => {
	const script = fileURLToPath(new URL("../scripts/check-sync-reverts.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script, "--validate-only"], { encoding: "utf8", timeout: 10_000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Sync ledger and actual revert cases validated/);
});

test("every checked-in disposition rejects missing status or reference; every patch requires its drop control", () => {
	const checkedIn = JSON.parse(readFileSync(new URL("../sync-patches.json", import.meta.url), "utf8"));
	const controls = checkedIn.patches.flatMap((patch) =>
		patch.dropControls.map((name) => ({ name, file: patch.files[0], check: patch.check })),
	);
	validateLedger(checkedIn, controls);
	for (let index = 0; index < checkedIn.patches.length; index++) {
		for (const field of ["upstream", "dropControls", "status", "reference"]) {
			const broken = structuredClone(checkedIn);
			const patch = broken.patches[index];
			delete (["status", "reference"].includes(field) ? patch.upstream : patch)[field];
			assert.throws(() => validateLedger(broken, controls), new RegExp(field));
		}
	}
	for (const field of ["status", "reference"]) {
		const broken = structuredClone(checkedIn);
		delete broken.release.upstream[field];
		assert.throws(() => validateLedger(broken, controls), new RegExp(field));
		for (let index = 0; index < checkedIn.absorbed.length; index++) {
			const missing = structuredClone(checkedIn);
			delete missing.absorbed[index].upstream[field];
			assert.throws(() => validateLedger(missing, controls), new RegExp(field));
		}
	}
});

test("rejects old text-only dispositions and blank, unknown or malformed statuses", () => {
	for (const upstream of ["harness-only", "drafted, not filed", null, [], 1, {}]) {
		const broken = structuredClone(ledger);
		broken.patches[0].upstream = upstream;
		assert.throws(() => validateLedger(broken, [control]), /upstream/);
	}
	for (const status of [undefined, "", " ", "drafted ", "filed", {}, [], 7]) {
		const broken = structuredClone(ledger);
		broken.patches[0].upstream.status = status;
		assert.throws(() => validateLedger(broken, [control]), /upstream status/);
	}
});

test("requires reviewable local references, allowing the explicit workstation draft path on CI", () => {
	for (const reference of [
		undefined,
		null,
		"",
		" ",
		" UPSTREAM.md",
		"UPSTREAM.md ",
		{},
		[],
		7,
		"not a reference",
		"../UPSTREAM.md",
		"/etc/passwd",
		"docs/../UPSTREAM.md",
		"missing-file.md",
		"docs",
		"https://example.com/draft",
		"~/other/draft.md",
		"javascript:alert(1)",
	]) {
		const broken = structuredClone(ledger);
		broken.patches[0].upstream.reference = reference;
		assert.throws(() => validateLedger(broken, [control]), /upstream reference/);
	}
	for (const status of ["drafted", "harness-only", "local-only", "candidate", "proposed-after-issue-first"]) {
		const valid = structuredClone(ledger);
		valid.patches[0].upstream = { status, reference: "~/code/review-notes/upstream-issues-drafts.md" };
		validateLedger(valid, [control]);
	}
});

test("merged upstream and release requests require real upstream PR/issue URL shapes, not local paths", () => {
	for (const [record, correct, wrongKind] of [
		[
			"absorbed",
			"https://github.com/injaneity/pi-computer-use/pull/95",
			"https://github.com/injaneity/pi-computer-use/issues/95",
		],
		[
			"release",
			"https://github.com/injaneity/pi-computer-use/issues/116",
			"https://github.com/injaneity/pi-computer-use/pull/116",
		],
	]) {
		for (const reference of [
			undefined,
			"",
			" ",
			"UPSTREAM.md",
			"~/code/review-notes/upstream-issues-drafts.md",
			"#95",
			"injaneity/pi-computer-use#116",
			wrongKind,
			correct.replace("https:", "http:"),
			`${correct}?query=1`,
			`${correct}#fragment`,
			correct.replace("github.com", "githubXcom"),
			correct.replace("injaneity", "other"),
			correct.replace(/\d+$/, "0"),
			null,
			{},
			7,
		]) {
			const broken = structuredClone(ledger);
			(record === "absorbed" ? broken.absorbed[0] : broken.release).upstream.reference = reference;
			assert.throws(() => validateLedger(broken, [control]), /upstream reference/);
		}
	}
});

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("checked-in ledger lists, UPSTREAM.md rows and revert cases are sorted so PRs append without conflicts", () => {
	const checkedIn = JSON.parse(read("sync-patches.json"));
	validateLedgerOrder(checkedIn, read("UPSTREAM.md"), read("scripts/check-sync-reverts.mjs"));
	const markdown = read("UPSTREAM.md");
	const reverts = read("scripts/check-sync-reverts.mjs");
	const swap = (items) => [items[1], items[0], ...items.slice(2)];
	const unsorted = [
		() => ({ ...checkedIn, files: swap(checkedIn.files) }),
		() => ({ ...checkedIn, patches: swap(checkedIn.patches) }),
		() => ({ ...checkedIn, patches: [{ ...checkedIn.patches[0], files: ["b", "a"] }] }),
		() => ({ ...checkedIn, patches: [{ ...checkedIn.patches[0], dropControls: ["b", "a"] }] }),
	];
	for (const make of unsorted) assert.throws(() => validateLedgerOrder(make(), markdown, reverts), /sorted/);
	const rows = markdown.split("\n").filter((line) => upstreamRowNames(line).length > 0);
	const swapped = markdown.replace(rows[0], "\u0000").replace(rows[1], rows[0]).replace("\u0000", rows[1]);
	assert.throws(() => validateLedgerOrder(checkedIn, swapped, reverts), /UPSTREAM\.md rows must be sorted/);
	assert.throws(
		() => validateLedgerOrder(checkedIn, markdown, '\t\tname: "b",\n\t\tname: "a",\n'),
		/cases must be sorted/,
	);
});

test("every sync-patches.json patch has an UPSTREAM.md row and every row has a patch", () => {
	const checkedIn = JSON.parse(read("sync-patches.json"));
	const markdown = read("UPSTREAM.md");
	validateUpstreamRows(checkedIn, markdown);
	const [row] = upstreamRowNames(markdown);
	assert.throws(() => validateUpstreamRows(checkedIn, `${markdown}\n| Orphan | x | y | z |\n`), /without a sync-patches/);
	assert.throws(() => validateUpstreamRows(checkedIn, markdown.replace(`| ${row} |`, "| Renamed |")), /no UPSTREAM\.md row/);
	const missing = structuredClone(checkedIn);
	delete missing.patches[0].rows;
	assert.throws(() => validateUpstreamRows(missing, markdown), /rows required/);
});
