// Static TS/native parity only. Revert controls must not compile the unrelated Swift SDK suites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { strictHeadlessRejection } from "../src/actions.ts";

const swift = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");

test("INV-strict-headless TS rejection mirrors the native keyboard-input rejections", () => {
	// Native side: `action == "X"` branches whose first statement unconditionally rejects keyboard input.
	// Conditional rejections (e.g. setText only inside a web area) are not mirrored in TS by design.
	const nativeActions = new Set();
	const branch = /else if (?:let \w+, )?action == "(\w+)" \{\s*try rejectInStrictHeadless\("([^"]*)"\)/g;
	for (const [, action, reason] of swift.matchAll(branch)) {
		if (/requires synthesized keyboard input/.test(reason)) nativeActions.add(action);
	}
	assert(nativeActions.size > 0, "no keyboard-input rejection branches parsed from bridge.swift");
	const allNativeActions = new Set([...swift.matchAll(/action == "(\w+)"/g)].map((match) => match[1]));
	const tsActions = new Set(
		[...allNativeActions, ...nativeActions].filter((action) => strictHeadlessRejection({ action }, true, "darwin") !== undefined),
	);
	assert(
		[...nativeActions].sort().join() === [...tsActions].sort().join(),
		`strictHeadlessRejection (${[...tsActions].sort()}) drifted from bridge.swift rejectInStrictHeadless (${[...nativeActions].sort()})`,
	);
});
