// Refuse the old desktop call graph without compiling or executing any AppKit code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync(new URL("../native/macos/agent_cursor_tests.swift", import.meta.url), "utf8");

test("cursor entry runs deterministic checks before the explicit live gate", () => {
	const entry = source.slice(
		source.indexOf("static func main()"),
		source.indexOf("private static func testMotionLifecycle"),
	);
	assert.match(entry, /testMotionLifecycle\(\)/);
	assert.doesNotMatch(entry, /testOverlayLifecycle\(\)/, "cursor entry must never call the live overlay directly");
	assert.match(
		entry,
		/CursorLiveGate\.run\(environment: ProcessInfo\.processInfo\.environment, overlay: testOverlayLifecycle\)/,
	);
	assert.match(entry, /testLiveGateSelection\(\)/, "native default must execute fake gate refusal assertions");
});

test("cursor gate refuses every non-opt-in environment before invoking the overlay", () => {
	const gate = source.slice(source.indexOf("enum CursorLiveGate"));
	assert.match(gate, /guard environment\["PI_COMPUTER_USE_LIVE"\] == "1" else/);
	assert.match(gate, /NOT RUN: cursor overlay lifecycle/);
	assert.match(gate, /return\s*\}\s*overlay\(\)/, "overlay callback must be behind the exact opt-in guard");
	assert.doesNotMatch(
		gate,
		/NSApplication|NSWindow|AgentCursor\(/,
		"selection gate must not construct desktop objects",
	);
});
