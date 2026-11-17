/** Requires the corrected core active-run cancellation contract, not released .11. */
import { it } from "vitest";
import { verifyConcurrentChildren } from "../../../../integration/inprocess/fixtures/router-ownership.ts";
import { RETRY, TERMINAL, verifyOwnership } from "../fixtures/ownership.ts";

it("aborting one child cannot spend its sibling's recovery budget or cancel its continuation", async () =>
	verifyConcurrentChildren("abort"));

for (const errorMessage of [TERMINAL, RETRY]) {
	it(`does not commit stale ${errorMessage === TERMINAL ? "terminal" : "retry"} recovery after abort during confirmation`, async () =>
		verifyOwnership("abort", errorMessage));
}
