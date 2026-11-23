// The Windows helper reference lives twice: the source-owned `PI_DOCS_REFERENCE` block in the crate's `lib.rs` and its
// preserved copy in `README.md`. They drifted apart (the block kept protocol `5` after the bump to `6`), so pin both
// copies to one body and every protocol number in it to the helper and client constants (nredd/pi-harness#983).
// Source-only: no Rust runs here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { WINDOWS_HELPER_PROTOCOL_VERSION } from "../src/platform/windows/helper.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const lib = read("../native/windows/bridge-rs/src/lib.rs");
const protocol = read("../native/windows/bridge-rs/src/protocol.rs");
const readme = read("../README.md");

/** The text strictly between the first `start` and the next `end`, trimmed. */
function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	if (from < 0) throw new Error(`${start} is missing`);
	const to = source.indexOf(end, from + start.length);
	if (to < 0) throw new Error(`${end} is missing after ${start}`);
	return source.slice(from + start.length, to).trim();
}

const block = between(lib, "PI_DOCS_REFERENCE_BEGIN reference/platforms/windows", "PI_DOCS_REFERENCE_END");

test("the README preserves the lib.rs Windows reference verbatim", () => {
	const page = between(readme, "<!-- Preserved from docs/content/docs/reference/platforms/windows.mdx -->", "<details");
	// The page adds only front matter and the generator banner ahead of the body.
	const banner = "Do not edit it directly. */}";
	const at = page.indexOf(banner);
	if (at < 0) throw new Error("The preserved page has no generator banner");
	expect(page.slice(at + banner.length).trim()).toBe(block);
});

test("every protocol number in the Windows reference is the helper and client protocol", () => {
	const helper = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(protocol);
	if (!helper) throw new Error("PROTOCOL_VERSION is not declared");
	expect(Number(helper[1])).toBe(WINDOWS_HELPER_PROTOCOL_VERSION);
	const cited = [
		...block.matchAll(/protocol version \*\*(\d+)\*\*/g),
		...block.matchAll(/"protocolVersion": (\d+)/g),
		...block.matchAll(/protocol `(\d+)`/g),
	].map((match) => Number(match[1]));
	// The prose version, both envelope examples and the diagnostics sentence.
	expect(cited).toHaveLength(4);
	expect(new Set(cited)).toEqual(new Set([WINDOWS_HELPER_PROTOCOL_VERSION]));
});
