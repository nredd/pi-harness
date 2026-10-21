import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHILD_ENTRY, isChildSession, isChildSessionName, registerChildIdentity } from "../src/child.ts";
import {
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_MAX_WIDGET_LINES,
	defaultConfig,
	isValidKeySpec,
	loadConfig,
	parseConfig,
	resolveCollapseKey,
} from "../src/config.ts";
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

describe("monitor widget config", () => {
	it("defaults to ctrl+shift+m and 12 lines", () => {
		expect(defaultConfig().monitor).toEqual({ collapseKey: "ctrl+shift+m", maxWidgetLines: 12 });
		expect(DEFAULT_COLLAPSE_KEY).toBe("ctrl+shift+m");
		expect(DEFAULT_MAX_WIDGET_LINES).toBe(12);
	});
	it("trims, lowercases and accepts a valid collapseKey, and `off`", () => {
		expect(resolveCollapseKey("  Alt+O ")).toBe("alt+o");
		expect(resolveCollapseKey("super+alt+f5")).toBe("super+alt+f5");
		expect(resolveCollapseKey("OFF")).toBe("off");
		expect(parseConfig({ monitor: { collapseKey: "alt+m" } }).monitor.collapseKey).toBe("alt+m");
	});
	it.each(["", "  ", "ctr+]", "ctrl+ctrl+m", "ctrl++m", "+m", "ctrl+", "ctrl+nope", "ctrl+shift+f13", 5, null, {}])(
		"falls back to the default for %j",
		(raw) => {
			expect(resolveCollapseKey(raw)).toBe(DEFAULT_COLLAPSE_KEY);
			expect(parseConfig({ monitor: { collapseKey: raw } }).monitor.collapseKey).toBe(DEFAULT_COLLAPSE_KEY);
		},
	);
	it("validates the KeyId grammar strictly", () => {
		expect(isValidKeySpec("ctrl+]")).toBe(true);
		expect(isValidKeySpec("f12")).toBe(true);
		expect(isValidKeySpec("ctrl+shift+m")).toBe(true);
		expect(isValidKeySpec("hyper+m")).toBe(false);
	});
	it("takes maxWidgetLines only as an integer >= 4", () => {
		expect(parseConfig({ monitor: { maxWidgetLines: 4 } }).monitor.maxWidgetLines).toBe(4);
		for (const bad of [3, 0, 7.5, "9", null])
			expect(parseConfig({ monitor: { maxWidgetLines: bad } }).monitor.maxWidgetLines).toBe(12);
	});
	it("keeps monitor.enabled independent of the widget keys", () => {
		const c = parseConfig({ monitor: { enabled: false, collapseKey: "alt+m" } });
		expect(c.features.monitor).toBe(false);
		expect(c.monitor.collapseKey).toBe("alt+m");
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
