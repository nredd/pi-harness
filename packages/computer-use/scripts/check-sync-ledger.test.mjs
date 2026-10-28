import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateLedger } from "./check-sync-ledger.mjs";

const control = { name: "remove behavior", file: "src/a.ts", check: "check-a.mjs" };
const ledger = {
	files: [control.file],
	patches: [
		{
			id: "a",
			purpose: "Retain behavior",
			upstream: "harness-only",
			files: [control.file],
			check: control.check,
			dropControls: [control.name],
		},
	],
};

test("accepts complete metadata and rejects each missing status/drop proof", () => {
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

test("every checked-in carried patch rejects missing upstream status or drop control", () => {
	const checkedIn = JSON.parse(readFileSync(new URL("../sync-patches.json", import.meta.url), "utf8"));
	const controls = checkedIn.patches.flatMap((patch) =>
		patch.dropControls.map((name) => ({ name, file: patch.files[0], check: patch.check })),
	);
	for (const patch of checkedIn.patches) {
		for (const field of ["upstream", "dropControls"]) {
			const broken = structuredClone(checkedIn);
			delete broken.patches.find((entry) => entry.id === patch.id)[field];
			assert.throws(() => validateLedger(broken, controls), new RegExp(field));
		}
	}
});
