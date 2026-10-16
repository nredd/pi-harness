import { describe, expect, it } from "vitest";
import { parseRef, refKey, sameModel } from "../src/model-ref.js";

describe("model refs", () => {
	it("splits at the first slash so ids may contain slashes", () => {
		expect(parseRef("openrouter/meta/llama-4")).toEqual({ provider: "openrouter", id: "meta/llama-4" });
		expect(refKey({ provider: "openrouter", id: "meta/llama-4" })).toBe("openrouter/meta/llama-4");
	});

	it("rejects a missing provider or id", () => {
		for (const ref of ["", "nope", "/id", "provider/"]) expect(parseRef(ref), ref).toBeUndefined();
	});

	it("compares provider and id only", () => {
		expect(sameModel({ provider: "a", id: "b" }, { provider: "a", id: "b" })).toBe(true);
		expect(sameModel({ provider: "a", id: "b" }, { provider: "a", id: "c" })).toBe(false);
	});
});
