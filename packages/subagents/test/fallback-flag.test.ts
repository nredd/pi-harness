import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { TierDisclosure } from "../src/model-tiers.js";
import { fallbackFlag, fallbackFlagText, hasFallback, withLeadingFlag } from "../src/ui/fallback-flag.js";

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

  it("renders an empty rest as the bare flag with no trailing separator", () => {
    expect(withLeadingFlag("", FLAG, "", 20)).toBe("[fallback]");
    expect(withLeadingFlag("", FLAG, "", 9)).toBe("[fb]");
    expect(withLeadingFlag("", FLAG, "", 3)).toBe("!");
  });

  it("sizes a function rest to what is left beside the flag in the narrow case", () => {
    const rest = (inner: number) => "R".repeat(inner);
    // "  >>> [fallback] " is 17 wide, so the prefix drops and 4 columns remain.
    expect(withLeadingFlag("  >>> ", FLAG, rest, 15)).toBe(`${FLAG} RRRR`);
  });

  it("is plain truncation when there is no flag", () => {
    const line = withLeadingFlag("> ", "", REST, 10);
    expect(line.startsWith("> RRRRR")).toBe(true);
    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  });
});

describe("hasFallback", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}` };

  it("treats an exhausted tier as identity, not a within-tier switch", () => {
    // Exhausted runs carry no admitted/answered pair to compare; only the
    // routed and static kinds can have switched member.
    const tier = { kind: "exhausted", tier: "deep", block: {}, skipped: [] } as unknown as TierDisclosure;
    expect(hasFallback({ modelTier: tier })).toBe(false);
    expect(fallbackFlag(theme, { modelTier: tier })).toBe("<dim>[@deep exhausted]");
  });
});
