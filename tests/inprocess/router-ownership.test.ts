/** Concurrent child selection ownership on the released host. */
import { it } from "vitest";
import { verifyConcurrentChildren } from "./fixtures/router-ownership.ts";

it("a child's manual pin invalidates only its recovery while its sibling uses shared exhaustion", async () =>
	verifyConcurrentChildren("pin"));
