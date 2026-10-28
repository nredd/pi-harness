// Validate patch ownership metadata before running the expensive drop controls.
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localStatuses = new Set(["drafted", "harness-only", "local-only", "candidate", "proposed-after-issue-first"]);

/** Require a disposition and a reviewable reference, without reading workstation-only drafts in CI.
 * @param {object} upstream Structured upstream status/reference.
 * @param {string} id Diagnostic record identity.
 * @returns {void}
 * @throws {AssertionError} On missing/malformed status or reference.
 */
function validateUpstream(upstream, id) {
	assert.ok(upstream && typeof upstream === "object" && !Array.isArray(upstream), `${id}: upstream object required`);
	const { status, reference } = upstream;
	assert.ok(
		localStatuses.has(status) || ["merged-upstream", "release-requested"].includes(status),
		`${id}: upstream status invalid`,
	);
	assert.ok(
		typeof reference === "string" && reference.trim() === reference && reference.length > 0,
		`${id}: upstream reference required`,
	);
	if (!localStatuses.has(status)) {
		const kind = status === "merged-upstream" ? "pull" : "issues";
		assert.match(
			reference,
			new RegExp(`^https://github\\.com/injaneity/pi-computer-use/${kind}/[1-9][0-9]*$`),
			`${id}: upstream reference must be an upstream ${kind} URL`,
		);
		return;
	}
	// The drafts are intentionally outside the repository and unavailable on hosted CI.
	if (reference === "~/code/review-notes/upstream-issues-drafts.md") return;
	assert.ok(
		/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(reference) &&
			!reference.split("/").some((part) => [".", ".."].includes(part)),
		`${id}: upstream reference must be a package-relative file or the drafts path`,
	);
	let isFile = false;
	try {
		isFile = statSync(path.join(root, reference)).isFile();
	} catch {
		/* Missing references fail the assertion below. */
	}
	assert.ok(isFile, `${id}: upstream reference file does not exist: ${reference}`);
}

/** Validate every carried patch against executable negative controls.
 * @param {object} ledger Parsed sync-patches.json.
 * @param {object[]} controls Available negative controls.
 * @returns {void}
 * @throws {AssertionError} If patch metadata or a drop control is missing.
 */
export function validateLedger(ledger, controls) {
	assert.ok(Array.isArray(ledger.patches) && ledger.patches.length > 0, "carried patches required");
	assert.ok(Array.isArray(ledger.absorbed), "absorbed records required");
	for (const record of ledger.absorbed) validateUpstream(record.upstream, record.id);
	validateUpstream(ledger.release?.upstream, "release");
	const ids = new Set();
	for (const patch of ledger.patches) {
		assert.ok(typeof patch.id === "string" && patch.id.trim() && !ids.has(patch.id), "unique patch id required");
		ids.add(patch.id);
		validateUpstream(patch.upstream, patch.id);
		for (const field of ["purpose", "check"]) {
			assert.ok(typeof patch[field] === "string" && patch[field].trim(), `${patch.id}: ${field} required`);
		}
		assert.ok(Array.isArray(patch.files) && patch.files.length > 0, `${patch.id}: files required`);
		for (const file of patch.files) assert.ok(ledger.files.includes(file), `${patch.id}: undeclared file ${file}`);
		assert.ok(Array.isArray(patch.dropControls) && patch.dropControls.length > 0, `${patch.id}: dropControls required`);
		for (const name of patch.dropControls) {
			const control = controls.find((entry) => entry.name === name);
			assert.ok(control, `${patch.id}: unknown drop control ${name}`);
			assert.ok(patch.files.includes(control.file), `${patch.id}: drop control file not owned`);
			assert.equal(control.check, patch.check, `${patch.id}: drop check mismatch`);
		}
	}
	for (const control of controls) {
		assert.ok(
			ledger.patches.some((patch) => patch.dropControls.includes(control.name)),
			`unowned drop control: ${control.name}`,
		);
	}
}
