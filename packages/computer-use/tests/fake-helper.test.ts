import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { onTestFinished, test } from "vitest";
import { shortSocketPath } from "../test/support/fake-helper.mjs";

test("removes short socket scratch at test completion", () => {
	let dir: string;
	// Finish hooks run in reverse order: check after shortSocketPath's cleanup.
	onTestFinished(() => assert.equal(existsSync(dir), false));
	dir = dirname(shortSocketPath());
	assert.equal(existsSync(dir), true);
});
