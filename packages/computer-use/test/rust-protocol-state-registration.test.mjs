// Source-registration guard only. Runtime assertions execute through Cargo and coverage:rust.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("Cargo retains the dedicated headless protocol/state/error contracts", () => {
	const source = readFileSync(
		new URL("../native/linux/bridge-rs/tests/protocol_state_errors.rs", import.meta.url),
		"utf8",
	);
	for (const name of [
		"malformed_requests_are_rejected_without_coercion",
		"transport_refuses_bad_envelopes_versions_and_commands_then_drains_eof",
		"responses_preserve_ids_and_omit_the_opposite_payload",
		"every_error_has_the_stable_wire_code_and_display",
		"roots_are_sorted_reused_removed_and_never_resurrect_old_refs",
		"image_dimensions_clamp_frames_and_updates_without_mutating_base",
		"scope_uses_newest_owner_and_refuses_missing_or_expired_ownership",
		"fresh_state_ids_are_unique_across_threads",
	]) {
		assert.ok(source.includes(`#[test]\nfn ${name}()`), `missing Cargo contract: ${name}`);
	}
	assert.doesNotMatch(source, /#\[(?:ignore|cfg)\b/, "headless contracts must run on every Cargo test host");
});
