// The Linux helper's `KILL_GRACE` (`native/linux/bridge-rs/src/main.rs`) is the client's
// `HELPER_TERMINATE_GRACE_MS`: its compile-time assertion keeps the stuck exit inside that
// grace, so the two must not drift apart (#1342).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { HELPER_TERMINATE_GRACE_MS } from "../src/platform/linux/helper.ts";

test("the Linux helper's KILL_GRACE equals the client's HELPER_TERMINATE_GRACE_MS", () => {
	const rust = readFileSync(new URL("../native/linux/bridge-rs/src/main.rs", import.meta.url), "utf8");
	const literal = /^const KILL_GRACE: Duration = Duration::from_millis\((\d+)\);$/m.exec(rust)?.[1];
	expect(literal, "main.rs declares `const KILL_GRACE: Duration = Duration::from_millis(<ms>);`").toBeDefined();
	expect(Number(literal)).toBe(HELPER_TERMINATE_GRACE_MS);
});
