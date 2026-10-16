import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.ts";
import { loadRuleDir, register } from "../../src/rules/index.ts";
import { INJECTED_ENTRY } from "../../src/rules/logic.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Result {
	content: { type: string; text: string }[];
}

let root: string;
let cwd: string;
let agent: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function rule(dir: string, name: string, paths: string, body = `${name} body`): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), `---\npaths: ${paths}\n---\n${body}\n`);
}

function setup(branch: unknown[] = []) {
	const handlers = new Map<string, Handler>();
	const appendEntry = vi.fn();
	register({ on: (e: string, h: Handler) => handlers.set(e, h), appendEntry } as never, defaultConfig());
	const ctx = { cwd, sessionManager: { getBranch: () => branch } };
	const fire = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
	const result = (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		fire("tool_result", {
			type: "tool_result",
			toolName,
			input,
			content: [{ type: "text", text: "orig" }],
			isError: false,
			...extra,
		}) as Result | undefined;
	return { appendEntry, fire, result };
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "kit-rules-"));
	cwd = path.join(root, "proj");
	agent = path.join(root, "agent");
	mkdirSync(cwd);
	process.env.PI_CODING_AGENT_DIR = agent;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("rules tool_result", () => {
	it("injects once on the first matching read, never on non-matching paths", () => {
		rule(path.join(cwd, ".pi", "rules"), "ts.md", "[src/**/*.ts]", "Use tabs");
		const t = setup();
		expect(t.result("read", { path: "README.md" })).toBeUndefined();
		const first = t.result("read", { path: "src/a.ts" });
		expect(first?.content[0]?.text).toBe("orig");
		expect(first?.content[1]?.text).toContain("Use tabs");
		expect(t.appendEntry).toHaveBeenCalledWith(INJECTED_ENTRY, { rule: "project:ts.md" });
		expect(t.result("read", { path: "src/b.ts" })).toBeUndefined();
		expect(t.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("covers edit and write, absolute paths, and skips other tools and errors", () => {
		rule(path.join(cwd, ".pi", "rules"), "a.md", "src/**");
		rule(path.join(cwd, ".pi", "rules"), "b.md", "lib/**");
		rule(path.join(cwd, ".pi", "rules"), "c.md", "docs/**");
		const t = setup();
		expect(t.result("edit", { path: path.join(cwd, "src", "x.ts") })).toBeDefined();
		expect(t.result("write", { path: "lib/y.ts" })).toBeDefined();
		expect(t.result("bash", { path: "docs/z.md" })).toBeUndefined();
		expect(t.result("read", { path: "docs/z.md" }, { isError: true })).toBeUndefined();
		expect(t.result("read", { path: "/etc/passwd" })).toBeUndefined();
		expect(t.result("read", { path: "../elsewhere/docs/z.md" })).toBeUndefined();
		expect(t.result("read", {})).toBeUndefined();
	});

	it("loads user rules from PI_CODING_AGENT_DIR and ignores files without paths", () => {
		rule(path.join(agent, "rules"), "u.md", "src/**", "user rule");
		mkdirSync(path.join(cwd, ".pi", "rules"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "rules", "plain.md"), "no frontmatter");
		const out = setup().result("read", { path: "src/a.ts" });
		expect(out?.content[1]?.text).toContain("user rule");
		expect(out?.content[1]?.text).not.toContain("no frontmatter");
	});

	it("rebuilds the injected set from the branch at session_start", () => {
		rule(path.join(cwd, ".pi", "rules"), "ts.md", "src/**");
		const probe = setup();
		const first = probe.result("read", { path: "src/a.ts" });
		expect(first).toBeDefined();
		const entry = { type: "custom", customType: INJECTED_ENTRY, data: { rule: "project:ts.md" } };
		const resumed = setup([entry]);
		resumed.fire("session_start", { reason: "resume" });
		expect(resumed.result("read", { path: "src/a.ts" })).toBeUndefined();
	});

	it("injects again after a compaction, but not when the rule text changes in the same context", () => {
		const dir = path.join(cwd, ".pi", "rules");
		rule(dir, "ts.md", "src/**", "v1");
		const t = setup();
		expect(t.result("read", { path: "src/a.ts" })).toBeDefined();
		expect(t.result("read", { path: "src/a.ts" })).toBeUndefined();
		rule(dir, "ts.md", "src/**", "v2");
		expect(t.result("read", { path: "src/a.ts" })).toBeUndefined();
		t.fire("session_compact");
		expect(t.result("read", { path: "src/a.ts" })?.content[1]?.text).toContain("v2");
	});

	it("caps rules per turn at 8 and carries the rest to the next turn", () => {
		const dir = path.join(cwd, ".pi", "rules");
		for (let i = 0; i < 10; i++) rule(dir, `r${i}.md`, "src/**");
		const t = setup();
		t.fire("turn_start");
		const first = t.result("read", { path: "src/a.ts" });
		expect(first?.content[1]?.text.match(/\[pi-session-kit rule:/g)).toHaveLength(8);
		expect(t.result("read", { path: "src/b.ts" })).toBeUndefined();
		t.fire("turn_start");
		const next = t.result("read", { path: "src/b.ts" });
		expect(next?.content[1]?.text.match(/\[pi-session-kit rule:/g)).toHaveLength(2);
	});

	it("truncates oversized rules with a notice", () => {
		rule(path.join(cwd, ".pi", "rules"), "big.md", "src/**", "x".repeat(10_000));
		const text = setup().result("read", { path: "src/a.ts" })?.content[1]?.text ?? "";
		expect(text).toContain("[rule truncated at 4096 bytes]");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
	});
});

describe("loadRuleDir", () => {
	it("returns nothing for a missing directory and sorts by name", () => {
		expect(loadRuleDir(path.join(root, "nope"), "user")).toEqual([]);
		const dir = path.join(root, "d");
		rule(dir, "b.md", "x");
		rule(dir, "a.md", "x");
		writeFileSync(path.join(dir, "c.txt"), "ignored");
		expect(loadRuleDir(dir, "user").map((r) => r.id)).toEqual(["user:a.md", "user:b.md"]);
	});
});
