import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// This is a source-level direct-call guard, not dynamic interposition or a live AX test.
// Keep the native fixture and the real types it invokes free of AX queries and actions.
test("ref/look fixture and production types call no AX APIs except handle construction", () => {
	const bridge = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
	const fixture = readFileSync(new URL("../native/macos/ref_look_tests.swift", import.meta.url), "utf8");
	const calls = (source) => [...source.matchAll(/\b(AX\w+)\s*\(/g)].map((match) => match[1]);
	for (const [start, end] of [
		["final class AXRefStore {", "/// Modality of a root."],
		["final class LookNode {", "final class Box<T> {"],
	]) {
		const first = bridge.indexOf(start);
		const last = bridge.indexOf(end, first);
		assert.ok(first >= 0 && last > first, "real production type boundaries must exist");
		assert.deepEqual(
			calls(bridge.slice(first, last)),
			[],
			"production ref/look types must not query or act through AX",
		);
	}
	assert.deepEqual(
		calls(fixture).filter((name) => name !== "AXRefStore"),
		["AXUIElementCreateApplication", "AXUIElementCreateApplication", "AXUIElementCreateApplication"],
		"fixture must only construct AX handles, never query attributes or send actions",
	);
	assert.ok(fixture.includes("AXUIElementCreateApplication(fixture.processIdentifier)"));
	const reaped = fixture.indexOf("fixture.waitUntilExit()");
	const cleanupAssertion = fixture.search(/check\(\s*fixture\.terminationStatus/);
	assert.ok(reaped >= 0 && cleanupAssertion > reaped, "fixture must be reaped before checking its exit status");
});
