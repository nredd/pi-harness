import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { fallbackFlagText, withLeadingFlag } from "../src/ui/fallback-flag.js";

const FLAG = fallbackFlagText(); // "[fallback]", 10 columns
const REST = "R".repeat(100);

describe("withLeadingFlag", () => {
  it("reserves prefix and flag, then truncates the rest", () => {
    const line = withLeadingFlag("> ", FLAG, REST, 30);
    expect(line.startsWith("> [fallback] R")).toBe(true);
    expect(visibleWidth(line)).toBe(30);
  });

  it("drops the prefix before the flag when prefix+flag does not fit", () => {
    const line = withLeadingFlag("  >>> ", FLAG, REST, 12);
    expect(line.startsWith(FLAG)).toBe(true);
    expect(line).not.toContain(">");
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it("drops the rest before the flag, rendering the flag alone", () => {
    expect(withLeadingFlag("> ", FLAG, REST, 10)).toBe(FLAG);
  });

  it("degrades to [fb], then !, never a clamped fragment, below the flag width", () => {
    expect(withLeadingFlag("> ", FLAG, REST, 9)).toBe("[fb]");
    expect(withLeadingFlag("> ", FLAG, REST, 4)).toBe("[fb]");
    expect(withLeadingFlag("> ", FLAG, REST, 3)).toBe("!");
    expect(withLeadingFlag("> ", FLAG, REST, 1)).toBe("!");
    expect(withLeadingFlag("> ", FLAG, REST, 0)).toBe("");
  });

  it("never exceeds the width at any width, and always keeps a recognizable marker", () => {
    for (let width = 1; width <= 40; width++) {
      const line = withLeadingFlag("  ● ", FLAG, REST, width);
      expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
      expect(line.includes("[fallback]") || line === "[fb]" || line === "!", `width ${width}: ${line}`).toBe(true);
    }
  });

  it("is plain truncation when there is no flag", () => {
    const line = withLeadingFlag("> ", "", REST, 10);
    expect(line.startsWith("> RRRRR")).toBe(true);
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  });
});
