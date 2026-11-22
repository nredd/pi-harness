// The live macOS input sink makes its OS effects only through the three it injects into the production wiring, so
// the headless Swift test of `NativeInputSink.production` (`native/macos/act_tests.swift`) sees every direct wait and
// post (nredd/pi-harness#1198). That Swift test is the behavioral check; this source guard only catches a direct OS
// call added to the sink outside the injected effects. It cannot see a wait hidden behind another function.
// Source-only, whitespace-insensitive: no Swift runs here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const swift = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
/** Direct OS waits and posts: `usleep`, `Thread.sleep` and `CGEvent.post(tap:)`. */
const OS_EFFECT = /\busleep\s*\(|\bThread\s*\.\s*sleep\b|\.\s*post\s*\(\s*tap\s*:/g;

/** The brace-balanced body of the declaration that starts at `pattern`. */
function body(source: string, pattern: RegExp): string {
	const match = pattern.exec(source);
	if (!match) throw new Error(`${pattern} is not declared`);
	const open = source.indexOf("{", match.index);
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
	}
	throw new Error(`${pattern} body is unbalanced`);
}

test("the live sink binds its OS effects to the production wiring and nowhere else in the sink", () => {
	const sink = body(swift, /\bstruct\s+NativeInputSink\b/);
	const live = /static\s+let\s+live\s*=\s*production\s*\(([^)]*\)[^)]*\)[^)]*)\)/.exec(sink);
	if (!live) throw new Error("`live` is not `production(activate:sleep:post:)`");
	expect(live[1].replace(/\s+/g, "")).toBe(
		"activate:activateIfInactive,sleep:{_=usleep($0)},post:{$0.post(tap:.cghidEventTap)}",
	);
	// Outside the `live` binding the sink makes no direct wait or post of its own.
	expect(sink.replace(live[0], "").match(OS_EFFECT)).toBeNull();
	expect(body(sink, /\bstatic\s+func\s+production\s*\(/).match(OS_EFFECT)).toBeNull();
});
