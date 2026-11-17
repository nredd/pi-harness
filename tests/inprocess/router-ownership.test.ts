/** Concurrent child selection and cancellation ownership through real children. */
import { it } from "vitest";
import { verifyConcurrentChildren } from "./fixtures/router-ownership.ts";

it.each(["pin", "abort"] as const)(
	"a child's %s invalidates only its recovery while its sibling uses shared exhaustion",
	async (change) => verifyConcurrentChildren(change),
);
