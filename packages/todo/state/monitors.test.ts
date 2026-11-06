import { describe, expect, it } from "vitest";
// session-kit's own constants, imported from source so the two cannot drift unnoticed.
import { MONITOR_STARTED_EVENT, MONITOR_STOPPED_EVENT } from "../../session-kit/src/monitor/index.ts";
import * as todo from "../tool/types.ts";

describe("monitor lifecycle events", () => {
	it("match session-kit's channel names", () => {
		expect(todo.MONITOR_STARTED_EVENT).toBe(MONITOR_STARTED_EVENT);
		expect(todo.MONITOR_STOPPED_EVENT).toBe(MONITOR_STOPPED_EVENT);
		expect(todo.MONITOR_LIFECYCLE_EVENTS).toEqual([MONITOR_STARTED_EVENT, MONITOR_STOPPED_EVENT]);
	});
});
