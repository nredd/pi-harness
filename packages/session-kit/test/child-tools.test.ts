/** Registry-level child isolation must survive scope resets and deferred promotion. */
import { describe, expect, it } from "vitest";
import { CHILD_ENTRY, isChildSession } from "../src/child.ts";
import { register as registerGoal } from "../src/goal/index.ts";
import { register as registerMonitor, TOOL_NAMES } from "../src/monitor/index.ts";
import { CONFIG, fakePi } from "./goal/fake-pi.ts";

const NAMES = ["goal_update", ...TOOL_NAMES];

describe("parent-only capabilities", () => {
	it("withdraws declarations before child tool scoping and rejects calls", async () => {
		const fake = fakePi();
		registerGoal(fake.pi, CONFIG);
		registerMonitor(fake.pi, CONFIG);
		// Names are unavailable during factory loading; pi-subagents names before binding.
		fake.state.sessionName = "general-purpose#deadbeef";
		await fake.emit("session_start");
		// Mirror child renarrow and an independent promoter ignoring the kit's active set.
		fake.pi.setActiveTools(["read", ...NAMES]);
		expect(fake.state.activeTools).toEqual(["read"]);
		fake.state.sessionName = "renamed child";
		for (const name of NAMES) {
			expect(fake.tools.get(name).exposure, name).toBe("hidden");
			const denied = await fake.emit("tool_call", { toolName: name });
			expect(denied).toEqual({ block: true, reason: `${name} is not available in subagents` });
			await expect(fake.tools.get(name).execute("id", {}, undefined, undefined, fake.ctx)).rejects.toThrow(
				`${name} is not available in subagents`,
			);
		}
		expect(await fake.emit("tool_call", { toolName: "read" })).toBeUndefined();
	});

	it("restores renamed child identity before goal/monitor rebuilds after reload", async () => {
		const child = fakePi({ sessionName: "general-purpose#deadbeef" });
		registerGoal(child.pi, CONFIG);
		registerMonitor(child.pi, CONFIG);
		await child.emit("session_start");
		expect(child.entries.filter((entry) => entry.customType === CHILD_ENTRY)).toHaveLength(1);
		child.state.sessionName = "renamed child";
		await child.emit("session_shutdown");
		const reloaded = fakePi({ sessionName: child.state.sessionName, entries: child.entries });
		registerGoal(reloaded.pi, CONFIG);
		registerMonitor(reloaded.pi, CONFIG);
		await reloaded.emit("session_start");
		expect(isChildSession(reloaded.pi)).toBe(true);
		expect(reloaded.commands.has("goal")).toBe(false);
		await reloaded.commands.get("monitor")?.("list", reloaded.ctx);
		expect(reloaded.notices.at(-1)?.message).toContain("not available");
		reloaded.pi.setActiveTools(["read", ...NAMES]);
		expect(reloaded.state.activeTools).toEqual(["read"]);
		for (const name of NAMES) {
			expect(reloaded.tools.get(name).exposure, name).toBe("hidden");
			expect(await reloaded.emit("tool_call", { toolName: name })).toEqual({
				block: true,
				reason: `${name} is not available in subagents`,
			});
			await expect(reloaded.tools.get(name).execute("id", {}, undefined, undefined, reloaded.ctx)).rejects.toThrow(
				`${name} is not available in subagents`,
			);
		}
		expect(reloaded.entries.filter((entry) => entry.customType === CHILD_ENTRY)).toHaveLength(1);
		await reloaded.settle();
		expect(reloaded.sent).toEqual([]);
	});

	it("clears identity when the runtime binds a replacement parent session", async () => {
		const fake = fakePi({ sessionName: "general-purpose#deadbeef" });
		registerGoal(fake.pi, CONFIG);
		await fake.emit("session_start");
		// Keep the inherited branch: a different session id must not inherit the marker.
		fake.state.sessionId = "replacement-parent";
		fake.state.sessionName = "parent";
		await fake.emit("session_start");
		expect(isChildSession(fake.pi)).toBe(false);
		expect(fake.tools.get("goal_update").exposure).not.toBe("hidden");
		expect(await fake.emit("tool_call", { toolName: "goal_update" })).toBeUndefined();
		await fake.commands.get("goal")?.("real parent objective", fake.ctx);
		await expect(
			fake.tools
				.get("goal_update")
				.execute("id", { status: "complete", evidence: "parent ran" }, undefined, undefined, fake.ctx),
		).resolves.toBeDefined();
		const fresh = fakePi();
		registerGoal(fresh.pi, CONFIG);
		await fresh.emit("session_start");
		expect(isChildSession(fresh.pi)).toBe(false);
		expect(fresh.tools.get("goal_update").exposure).not.toBe("hidden");
	});

	it("leaves parent capabilities available and never queries an unbound runtime", async () => {
		const fake = fakePi();
		fake.pi.getSessionName = () => {
			throw new Error("Extension runtime not initialized");
		};
		expect(() => registerGoal(fake.pi, CONFIG)).not.toThrow();
		fake.pi.getSessionName = () => undefined;
		await fake.emit("session_start");
		expect(fake.tools.get("goal_update").exposure).not.toBe("hidden");
		expect(await fake.emit("tool_call", { toolName: "goal_update" })).toBeUndefined();
	});
});
