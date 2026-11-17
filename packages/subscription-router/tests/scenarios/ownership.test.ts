/** Selection guards supported by the currently released host contract. */
import { it } from "vitest";
import { RETRY, TERMINAL, verifyOwnership } from "../fixtures/ownership.ts";

for (const errorMessage of [TERMINAL, RETRY]) {
	it.each(["pin", "other-profile", "away-and-back", "shutdown"] as const)(
		`does not commit stale ${errorMessage === TERMINAL ? "terminal" : "retry"} recovery after %s during confirmation`,
		async (change) => verifyOwnership(change, errorMessage),
	);
}
