import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/error-message.js";

describe("errorMessage", () => {
  it("reads an Error's message, not its stack or name", () => {
    expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
  });

  it("stringifies anything else a caller threw", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
