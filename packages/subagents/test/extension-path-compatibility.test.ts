/** Frontmatter extension paths retain this caller's historical path contract. */
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseExtensionsSpec } from "../src/agent-runner.js";

const cwd = resolve("/work");
const home = resolve("/injected/home");

// Expected pre-injection transformations, with only the home dependency replaced.
const cases = [
  ["bare tilde", "~", home],
  ["forward tilde", "~/x", home + "/x"],
  ["backslash tilde (also on POSIX)", "~\\x", home + "\\x"],
  ["file URL remains literal", "file:///tmp/x", "file:///tmp/x"],
  ["backslash drive remains platform-native", "C:\\x", "C:\\x"],
  ["forward drive remains platform-native", "C:/x", "C:/x"],
  ["shell drive is not interpreted", "/c/x", "/c/x"],
  ["WSL drive is not interpreted", "/mnt/c/x", "/mnt/c/x"],
  ["absolute", "/absolute/x", "/absolute/x"],
  ["relative", "./relative/x", "./relative/x"],
];

describe("extension path compatibility before/after home injection", () => {
  it.each(cases)("preserves %s", (_label, input, previousExpansion) => {
    const expected = isAbsolute(previousExpansion) ? previousExpansion : resolve(cwd, previousExpansion);
    expect(parseExtensionsSpec([input], cwd, home).paths).toEqual([expected]);
  });
});
