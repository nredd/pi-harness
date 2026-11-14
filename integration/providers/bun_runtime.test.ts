import { expect, test } from "vitest";
import { runtimeBun } from "./bun_runtime.mjs";

test("reads the actual host Bun API without replacing its immutable global", () => {
	expect(runtimeBun()).toBe(Reflect.get(globalThis, "Bun"));
});
