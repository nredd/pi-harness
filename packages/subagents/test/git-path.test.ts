import { describe, expect, it } from "vitest";
import { unquoteGitPath } from "../src/git-path.js";

describe("unquoteGitPath", () => {
  it.each([
    ["plain", "src/a.ts", "src/a.ts"],
    ["leading dash", "-x", "-x"],
    ["octal utf-8", '"d\\303\\251p"', "d\u00e9p"],
    ["four-byte octal utf-8", '"\\360\\237\\230\\200"', "\u{1F600}"],
    ["real U+FFFD", '"\\357\\277\\275"', "\uFFFD"],
    ["escaped quote", '"say \\"hi\\""', 'say "hi"'],
    ["escaped backslash", '"a\\\\b"', "a\\b"],
    ["tab and newline", '"a\\tb\\nc"', "a\tb\nc"],
    ["other control escapes", '"\\a\\b\\f\\r\\v"', "\x07\b\f\r\v"],
    ["octal control", '"\\001"', "\x01"],
    ["spaces", '"my dir/"', "my dir/"],
    ["literal quote mid name", 'a"b', 'a"b'],
  ])("decodes %s", (_name, text, expected) => {
    expect(unquoteGitPath(text)).toBe(expected);
  });

  it.each([
    ["raw non-ASCII", "d\u00e9p"],
    ["raw U+FFFD", "d\uFFFDp"],
    ["raw non-ASCII inside quotes", '"d\u00e9p"'],
    ["unknown escape", '"a\\qb"'],
    ["truncated octal", '"a\\30"'],
    ["unescaped inner quote", '"a"b"'],
    ["trailing backslash", '"a\\"'],
    ["invalid UTF-8", '"\\377"'],
    ["truncated UTF-8", '"\\303"'],
  ])("rejects %s", (_name, text) => {
    expect(() => unquoteGitPath(text)).toThrow();
  });
});
