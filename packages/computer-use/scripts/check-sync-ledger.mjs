// Validate patch ownership metadata before running the expensive drop controls.
import assert from "node:assert/strict";

/** Validate every carried patch against executable negative controls.
 * @param {object} ledger Parsed sync-patches.json.
 * @param {object[]} controls Available negative controls.
 * @returns {void}
 * @throws {AssertionError} If patch metadata or a drop control is missing.
 */
export function validateLedger(ledger, controls) {
	assert.ok(Array.isArray(ledger.patches) && ledger.patches.length > 0, "carried patches required");
	const ids = new Set();
	for (const patch of ledger.patches) {
		assert.ok(typeof patch.id === "string" && patch.id.trim() && !ids.has(patch.id), "unique patch id required");
		ids.add(patch.id);
		for (const field of ["purpose", "upstream", "check"]) {
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
