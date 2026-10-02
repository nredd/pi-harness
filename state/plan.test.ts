import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { applyPlanApproval, parsePlanItems, planTitle, selectOpenPlanItems, selectPlanProgress } from "./plan.js";
import type { TaskState } from "./state.js";

/** A synthetic plan shaped like a real approved one: context sections, labeled bullets, nested and numbered lists. */
const SAMPLE_PLAN = readFileSync(new URL("./fixtures/approved-plan.md", import.meta.url), "utf-8");
const HARNESS = "0. Harness verification: `widget-e2e` (built first)";

const SMALL_PLAN = `# Add widgets

## Work
- Add the \`alpha\` module
- Wire \`beta\` into the CLI
  - flag \`--beta\`

## Verification
- \`make test\` passes
`;

function empty(): TaskState {
	return { tasks: [], nextId: 1 };
}

describe("parsePlanItems — full plan", () => {
	const items = parsePlanItems(SAMPLE_PLAN);
	const groups = new Set(items.map((i) => i.group));

	it("yields the harness section's phase-2 work as its own items, verbatim", () => {
		const harness = items.filter((i) => i.group === HARNESS);
		const subjects = harness.map((i) => i.subject);
		expect(subjects).toContain("**Phase 2:** the remaining scenarios, alongside each fix below, test-first.");
		expect(subjects).toContain("**Integration scenarios** (headless runs with fake providers):");
		expect(subjects).toContain("**TUI scenarios:**");
		expect(subjects).toContain("**Bench scenarios** (stored baselines; fail on >20% regression, median of 5):");
		// Phase 1 is a separate item, so finishing it can't close the section.
		expect(subjects).toContain("**Phase 1 (day one):**");
		const tui = harness.find((i) => i.subject === "**TUI scenarios:**");
		expect(tui?.detail).toContain("- viewer wheel scrolling");
		expect(tui?.detail).toContain("- Esc on a ready plan stays in Plan mode");
	});

	it("skips context: Summary, Not adopted, Key findings, Assumptions", () => {
		expect(groups.has("Summary")).toBe(false);
		expect(groups.has("Key findings")).toBe(false);
		expect(groups.has("Assumptions/defaults")).toBe(false);
		const all = items.map((i) => `${i.subject}\n${i.detail ?? ""}`).join("\n");
		expect(all).not.toContain("Widget Durable (library)");
		expect(all).not.toContain("`turbo-cache`");
		expect(all).not.toContain("deployed `v1.7` vs pinned `v1.9`");
	});

	it("keeps every work section and the definition-of-done bullets as items", () => {
		expect([...groups]).toEqual([
			HARNESS,
			"1. Core: `release/v2.0.0` -> `v2.0.0-fork.1`",
			"2. `widget-plugin` -> `v0.4.0-fork.2`",
			"Verification (definition of done)",
		]);
		const done = items.filter((i) => i.group === "Verification (definition of done)").map((i) => i.subject);
		expect(done).toEqual([
			"`make verify` passes on this machine.",
			"`make verify-live` passes once.",
			"All repo gates are green; tags and branches are on origin.",
		]);
	});

	it("keeps a numbered sub-list inside its parent bullet", () => {
		const upstream = items.find((i) => i.subject.startsWith("**Upstream (draft PRs"));
		expect(upstream?.detail).toContain("1. the `Container` mouse alignment");
		expect(items.some((i) => i.subject === "the `Container` mouse alignment")).toBe(false);
	});

	it("titles the plan from its # heading", () => {
		expect(planTitle(SAMPLE_PLAN)).toBe("Widget service v2 upgrade, e2e harness, one-line rows");
	});
});

describe("parsePlanItems — edge cases", () => {
	it("turns a prose-only work section into one item named by its heading", () => {
		expect(parsePlanItems("# T\n\n## Migrate the DB\nRun the migration in prod.\n")).toEqual([
			{ group: "Migrate the DB", subject: "Migrate the DB" },
		]);
	});

	it("never starts an item inside fenced code", () => {
		const items = parsePlanItems("## Work\n- run it\n\n```sh\n- not a bullet\n```\n");
		expect(items.map((i) => i.subject)).toEqual(["run it"]);
	});

	it("skips a nested list under a skipped lead-in", () => {
		const items = parsePlanItems("## Work\nNot adopted:\n- foo\n  - bar\nDo:\n- real\n");
		expect(items.map((i) => i.subject)).toEqual(["real"]);
	});

	it("keeps bullets that sit directly under the title", () => {
		expect(parsePlanItems("# T\n- one\n- two\n").map((i) => [i.group, i.subject])).toEqual([
			["", "one"],
			["", "two"],
		]);
	});
});

describe("applyPlanApproval", () => {
	it("seeds verbatim plan items tagged source: plan", () => {
		const { state, changed } = applyPlanApproval(empty(), "p1", SMALL_PLAN);
		expect(changed).toBe(true);
		expect(state.plan).toEqual({ id: "p1", title: "Add widgets" });
		expect(state.tasks).toEqual([
			{ id: 1, subject: "Add the `alpha` module", status: "pending", source: "plan", planGroup: "Work" },
			{
				id: 2,
				subject: "Wire `beta` into the CLI",
				status: "pending",
				source: "plan",
				planGroup: "Work",
				planText: "- flag `--beta`",
			},
			{ id: 3, subject: "`make test` passes", status: "pending", source: "plan", planGroup: "Verification" },
		]);
		expect(state.nextId).toBe(4);
	});

	it("is a no-op for a re-announced plan id", () => {
		const first = applyPlanApproval(empty(), "p1", SMALL_PLAN).state;
		const again = applyPlanApproval(first, "p1", SMALL_PLAN);
		expect(again.changed).toBe(false);
		expect(again.state).toBe(first);
	});

	it("replaces the plan set on re-approval and leaves agent todos alone", () => {
		const seeded = applyPlanApproval(empty(), "p1", SMALL_PLAN).state;
		const agent: Task = { id: seeded.nextId, subject: "mine", status: "in_progress", blockedBy: [1, 2] };
		const withAgent: TaskState = { ...seeded, tasks: [...seeded.tasks, agent], nextId: seeded.nextId + 1 };
		// #1 was proven done; it survives the revision because its text is unchanged.
		withAgent.tasks[0] = { ...withAgent.tasks[0], status: "completed", evidence: "npm test: 3 passed" };

		const revised = "# Add widgets v2\n\n## Work\n- Add the `alpha` module\n- Ship `gamma`\n";
		const { state } = applyPlanApproval(withAgent, "p2", revised);
		expect(state.plan).toEqual({ id: "p2", title: "Add widgets v2" });
		const plan = state.tasks.filter((t) => t.source === "plan");
		expect(plan.map((t) => [t.id, t.subject, t.status, t.evidence])).toEqual([
			[5, "Add the `alpha` module", "completed", "npm test: 3 passed"],
			[6, "Ship `gamma`", "pending", undefined],
		]);
		expect(state.tasks.find((t) => t.id === 4)).toEqual({ id: 4, subject: "mine", status: "in_progress" });
	});

	it("reports open/total plan progress", () => {
		const { state } = applyPlanApproval(empty(), "p1", SMALL_PLAN);
		state.tasks[0] = { ...state.tasks[0], status: "completed", evidence: "x" };
		state.tasks[1] = { ...state.tasks[1], status: "deferred", reason: "later" };
		expect(selectPlanProgress(state)).toEqual({ open: 1, total: 3 });
		expect(selectOpenPlanItems(state).map((t) => t.id)).toEqual([3]);
		expect(selectPlanProgress(empty())).toBeUndefined();
	});
});
