import { describe, expect, it, vi } from "vitest";
import { SubagentTracker } from "../../src/goal/subagents.ts";
import { FakeBus } from "./fake-pi.ts";

describe("SubagentTracker", () => {
	it("counts an agent from created/started until completed", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:started", { id: "a" });
		expect(tracker.runningCount()).toBe(1);
		bus.emit("subagents:completed", { id: "a" });
		expect(tracker.busy()).toBe(0);
	});
	it("holds a finished background agent as unannounced until its notice", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:created", { id: "a", isBackground: true });
		bus.emit("subagents:started", { id: "a" });
		bus.emit("subagents:completed", { id: "a" });
		expect(tracker.runningCount()).toBe(0);
		expect(tracker.busy()).toBe(1);
		tracker.announced();
		expect(tracker.busy()).toBe(0);
	});
	it("does not wait for a queued background agent stopped before it starts", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:created", { id: "queued", isBackground: true });
		expect(tracker.busy()).toBe(1);
		bus.emit("subagents:failed", { id: "queued", status: "stopped" });
		expect(tracker.busy()).toBe(0);
	});
	it("still waits for a started background agent stopped after handoff", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:started", { id: "a" });
		bus.emit("subagents:created", { id: "a", isBackground: true });
		bus.emit("subagents:failed", { id: "a", status: "stopped" });
		expect(tracker.busy()).toBe(1);
		tracker.announced();
		expect(tracker.busy()).toBe(0);
	});
	it("clears started state before the same id is queued and stopped again", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:created", { id: "a", isBackground: true });
		bus.emit("subagents:started", { id: "a" });
		bus.emit("subagents:completed", { id: "a" });
		tracker.announced();
		bus.emit("subagents:created", { id: "a", isBackground: true });
		bus.emit("subagents:failed", { id: "a", status: "stopped" });
		expect(tracker.busy()).toBe(0);
	});
	it("retains a background failure without a stopped status for notice delivery", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:created", { id: "a", isBackground: true });
		bus.emit("subagents:failed", { id: "a", status: "error" });
		expect(tracker.busy()).toBe(1);
	});
	it("never waits for a foreground agent's notice (it has none)", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:created", { id: "fg", isBackground: false });
		bus.emit("subagents:started", { id: "fg" });
		bus.emit("subagents:failed", { id: "fg" });
		expect(tracker.busy()).toBe(0);
	});
	it("fires onIdle only when the last agent finishes", () => {
		const bus = new FakeBus();
		const idle = vi.fn();
		const tracker = new SubagentTracker(idle);
		tracker.attach(bus);
		bus.emit("subagents:started", { id: "a" });
		bus.emit("subagents:started", { id: "b" });
		bus.emit("subagents:completed", { id: "a" });
		expect(idle).not.toHaveBeenCalled();
		bus.emit("subagents:failed", { id: "b" });
		expect(idle).toHaveBeenCalledOnce();
	});
	it("ignores payloads without an id and unsubscribes on dispose", () => {
		const bus = new FakeBus();
		const tracker = new SubagentTracker();
		tracker.attach(bus);
		bus.emit("subagents:started", {});
		bus.emit("subagents:started", null);
		bus.emit("subagents:created", { isBackground: true });
		bus.emit("subagents:completed", { id: 7 });
		expect(tracker.busy()).toBe(0);
		bus.emit("subagents:started", { id: "a" });
		tracker.dispose();
		expect(tracker.busy()).toBe(0);
		expect(bus.listenerCount()).toBe(0);
	});
});
