// The configuration reference lives twice: the source-owned `PI_DOCS_REFERENCE` block in `src/config.ts` and its
// preserved copy in `README.md`. The block lagged the README's `blocked_apps` section (it dropped
// `com.apple.LocalAuthenticationRemoteService` and the keyboard admission text), so pin both copies to one body and
// require every always-blocked macOS agent in it (nredd/pi-harness#1380). Source-only: nothing is generated here.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ALWAYS_BLOCKED_BUNDLE_IDS, getComputerUseConfig } from "../src/config.ts";

/** Read a package file with LF line endings, so a CRLF checkout compares equal. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = read("../src/config.ts");
const readme = read("../README.md");

/** The text strictly between the first `start` and the next `end`, trimmed at the edges only. */
function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start);
	if (from < 0) throw new Error(`${start} is missing`);
	const to = text.indexOf(end, from + start.length);
	if (to < 0) throw new Error(`${end} is missing after ${start}`);
	return text.slice(from + start.length, to).trim();
}

const block = between(source, "PI_DOCS_REFERENCE_BEGIN reference/configuration", "PI_DOCS_REFERENCE_END");

/** The block with each `{{config-default:<key>}}` placeholder rendered as the key's JSON default, as the README shows it. */
function renderDefaults(text: string): string {
	const defaults: Record<string, unknown> = { ...getComputerUseConfig() };
	return text.replace(/\{\{config-default:(\w+)\}\}/g, (_, key: string) => {
		if (!(key in defaults)) throw new Error(`config-default:${key} names no config option`);
		return JSON.stringify(defaults[key]);
	});
}

test("the README preserves the config.ts configuration reference verbatim", () => {
	const page = between(readme, "<!-- Preserved from docs/content/docs/reference/configuration.mdx -->", "<details");
	// The page adds only front matter and the generator banner ahead of the body.
	const banner = "Do not edit it directly. */}";
	const at = page.indexOf(banner);
	if (at < 0) throw new Error("The preserved page has no generator banner");
	expect(page.slice(at + banner.length).trim()).toBe(renderDefaults(block));
});

test("the configuration reference renders a default for every placeholder it uses", () => {
	expect(renderDefaults(block)).not.toContain("{{config-default:");
	expect(() => renderDefaults("{{config-default:no_such_option}}")).toThrow("names no config option");
});

test("the configuration reference names every always-blocked macOS agent", () => {
	// Dropping an id from both copies keeps them identical; the code list catches that.
	for (const id of ALWAYS_BLOCKED_BUNDLE_IDS) expect(block).toContain(`\`${id}\``);
});
