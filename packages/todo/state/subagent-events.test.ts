import { describe, expect, it } from "vitest";
import * as todo from "../tool/types.ts";

// The same literals the real emitter test in packages/subagents asserts, so a rename on either side fails a suite.
describe("subagent survivor channels", () => {
	it("match pi-subagents' channel names", () => {
		expect(todo.SUBAGENT_ANNOUNCE_SURVIVORS_EVENT).toBe("subagents:announce_survivors");
		expect(todo.SUBAGENT_PARENT_SURVIVOR_EVENT).toBe("subagents:parent_survivor");
	});
});
