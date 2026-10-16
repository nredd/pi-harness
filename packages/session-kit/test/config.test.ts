import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHILD_ENTRY, isChildSession, isChildSessionName, registerChildIdentity } from "../src/child.ts";
import { defaultConfig, loadConfig, parseConfig } from "../src/config.ts";
import { fakePi } from "./goal/fake-pi.ts";

describe("parseConfig", () => {
	it("defaults every feature on", () => {
		expect(Object.values(defaultConfig().features).every(Boolean)).toBe(true);
	});
	it("honours per-feature enabled and titles.model, ignoring junk", () => {
		const c = parseConfig({ goal: { enabled: false }, loop: { enabled: "no" }, titles: { model: "a/b" }, extra: 1 });
		expect(c.features.goal).toBe(false);
		expect(c.features.loop).toBe(true);
		expect(c.titleModel).toBe("a/b");
	});
	it("rejects a titles.model without a provider", () => {
		expect(parseConfig({ titles: { model: "nope" } }).titleModel).toBeUndefined();
	});
	it("returns defaults for non-objects and a missing file", () => {
		expect(parseConfig(null)).toEqual(defaultConfig());
		expect(loadConfig("/nonexistent/pi-session-kit.json")).toEqual(defaultConfig());
	});
});

describe("isChildSessionName", () => {
	it("matches pi-subagents child names only", () => {
		expect(isChildSessionName("Explore#1a2b3c4d")).toBe(true);
		expect(isChildSessionName("fix the #bug")).toBe(false);
		expect(isChildSessionName(undefined)).toBe(false);
	});
});

describe("child identity", () => {
	it("does not infer child identity from a Plan fresh-session parent link or another session's marker", async () => {
		const fake = fakePi({ sessionName: "Plan fresh session" });
		fake.ctx.sessionManager.getHeader = () => ({ parentSession: "/sessions/parent.jsonl" });
		fake.entries.push(
			{ type: "custom", customType: CHILD_ENTRY, data: { version: 1, sessionId: "another-child" } },
			{ type: "custom", customType: CHILD_ENTRY, data: null },
			{ type: "custom", customType: CHILD_ENTRY, data: { version: 2, sessionId: fake.state.sessionId } },
		);
		registerChildIdentity(fake.pi);
		registerChildIdentity(fake.pi);
		expect(fake.handlers.get("session_start")).toHaveLength(1);
		await fake.emit("session_start");
		expect(isChildSession(fake.pi)).toBe(false);
		expect(fake.entries).toHaveLength(3);
	});
});

describe("loadConfig failure paths", () => {
	it("reports invalid JSON on stderr and falls back to defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "kit-config-"));
		const path = join(dir, "pi-session-kit.json");
		writeFileSync(path, "{ not json");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(loadConfig(path)).toEqual(defaultConfig());
		expect(err).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
		err.mockRestore();
	});
	it("reports an unreadable path (a directory) and falls back to defaults", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(loadConfig(mkdtempSync(join(tmpdir(), "kit-config-")))).toEqual(defaultConfig());
		expect(err).toHaveBeenCalledWith(expect.stringContaining("cannot read"));
		err.mockRestore();
	});
});
