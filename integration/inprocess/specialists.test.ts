/** Real pi-subagents enforces the unmodified preset package's specialist frontmatter. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	agentStack,
	ask,
	call,
	closeAgentStack,
	GIT_READS,
	listTools,
	MUTATIONS,
	READS,
	report,
	WEB,
} from "./agents-support.ts";
import { isolateResearchPackages, isolateStackHome, loadThirdParty } from "./support.ts";

const SURFACES: Record<string, { required: string[]; forbidden: string[] }> = {
	"code-reviewer": { required: [...READS, ...GIT_READS], forbidden: [...MUTATIONS, ...WEB] },
	architect: { required: [...READS, ...GIT_READS], forbidden: [...MUTATIONS, ...WEB] },
	critic: { required: [...READS, ...GIT_READS, "py_test", "cargo_test"], forbidden: [...MUTATIONS, ...WEB] },
	researcher: { required: [...READS, ...WEB], forbidden: [...MUTATIONS, ...GIT_READS] },
	verifier: {
		required: [...READS, "bash", "git_status", "git_log", "git_diff"],
		forbidden: MUTATIONS.filter((t) => t !== "bash"),
	},
	debugger: {
		required: [...READS, "edit", "write", "bash"],
		forbidden: ["git_commit", "git_worktree_remove", "git_worktree_prune", "memory_write", "scratchpad"],
	},
};
let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;
let restoreDependencies: () => void;
let fetchCalls = 0;
beforeAll(async () => {
	home = await isolateStackHome();
	restoreDependencies = isolateResearchPackages(home.root);
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		fetchCalls++;
		throw new Error("Specialist scope tests must not access the network");
	});
	h = await agentStack(home.root, {
		factories: [await loadThirdParty("web"), await loadThirdParty("memory")],
		packages: ["pi-web-access", "pi-memory"].map((name) =>
			fileURLToPath(new URL("./", import.meta.resolve(`${name}/package.json`))),
		),
	});
});
afterAll(async () => {
	try {
		if (h) await closeAgentStack(h);
		expect(fetchCalls).toBe(0);
	} finally {
		vi.restoreAllMocks();
		restoreDependencies?.();
		await home.cleanup();
	}
});

it("real packages register the capabilities excluded from specialists without external work", () => {
	const registered = h.session.getAllTools().map((tool) => tool.name);
	for (const name of [...WEB, "memory_write", "scratchpad"]) expect(registered).toContain(name);
	expect(readFileSync(join(home.root, "memory/qmd-calls"), "utf8")).toContain("collection list");
	expect(fetchCalls).toBe(0);
});

it.each(Object.keys(SURFACES))("specialists expose their declared surfaces: %s", async (type) => {
	const answer = await ask(h, type, [listTools]);
	expect(answer.startsWith("TOOLS "), answer).toBe(true);
	const offered = answer.slice(6).trim().split(",");
	const surface = SURFACES[type];
	if (!surface) throw new Error(`Missing surface ${type}`);
	for (const tool of surface.required) expect(offered, `${type} missing ${tool}`).toContain(tool);
	for (const tool of surface.forbidden) expect(offered, `${type} offered ${tool}`).not.toContain(tool);
});

it.each(["architect", "critic", "researcher"])("read-only specialists reject explicit writes: %s", async (type) => {
	const path = join(home.root, "protected.txt");
	const original = "MUST NOT CHANGE\n";
	writeFileSync(path, original);
	const answer = await ask(h, type, [call("write", { path, content: "CORRUPTED\n" }), report]);
	expect(answer).toContain("Tool write not found");
	expect(readFileSync(path, "utf8")).toBe(original);
});

it("debugger excludes commit despite always-active defaults", async () => {
	const answer = await ask(h, "debugger", [
		call("git_commit", { subject: "Sneak", paths: ["x"], push: false }),
		report,
	]);
	expect(answer).toContain("Tool git_commit not found");
});
