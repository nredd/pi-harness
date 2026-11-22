// The live macOS input sink is the injected production wiring and nothing else, so the headless Swift test of
// `NativeInputSink.production` covers every wait the live HID path makes (nredd/pi-harness#1198). Source-only: no
// Swift runs here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const swift = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");

test("the live sink binds only the three OS effects to the production wiring", () => {
	expect(swift).toContain(
		"\tstatic let live = production(activate: activateIfInactive, sleep: { _ = usleep($0) }, post: { $0.post(tap: .cghidEventTap) })\n",
	);
	const start = swift.indexOf("\tstatic func production(");
	const end = swift.indexOf("\tstatic let live = ", start);
	expect(start).toBeGreaterThan(0);
	const factory = swift.slice(start, end);
	// Every wait goes through the injected `sleep`, which the Swift test records.
	expect(factory).not.toMatch(/usleep|Thread\.sleep|\.post\(tap:/);
	expect(factory).toContain("postHID: { event, _ in post(event) },");
});
