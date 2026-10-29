import assert from "node:assert/strict";
import { test } from "vitest";
import { isStaleExtensionContextError } from "../src/extension-runtime.js";

test("recognizes both supported stale extension context errors", () => {
  assert.equal(
    isStaleExtensionContextError(new Error("This extension ctx is stale after session replacement or reload")),
    true,
  );
  assert.equal(isStaleExtensionContextError(new Error("Extension context is no longer active")), true);
});

test("does not swallow unrelated extension failures", () => {
  assert.equal(isStaleExtensionContextError(new Error("network failure")), false);
  assert.equal(isStaleExtensionContextError("Extension context is no longer active"), false);
  assert.equal(isStaleExtensionContextError(undefined), false);
});
