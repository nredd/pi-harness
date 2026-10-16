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

describe("parsePlanItems — context labels", () => {
	const LABELS = [
		"Decisions",
		"Scope",
		"Diagnosis so far",
		"Current state",
		"Constraints",
		"Defaults",
		"Goals",
		"Success criteria",
		"Intent",
		"Compatibility",
		"Rationale",
		"Approved approach",
	];
	for (const label of LABELS) {
		it(`skips a '${label}' section but keeps the work sections`, () => {
			const items = parsePlanItems(`# T\n\n## ${label}\n- not work\n\n## Work\n- do it\n`);
			expect(items.map((i) => i.subject)).toEqual(["do it"]);
		});
	}

	it("skips a 'Decisions:' lead-in list", () => {
		const items = parsePlanItems("# T\n\n## Work\nDecisions:\n- not work\n\n## More\n- do it\n");
		expect(items.map((i) => i.subject)).toEqual(["do it"]);
	});

	it("does not skip sections that merely start with the same letters", () => {
		const items = parsePlanItems("# T\n\n## Scoped changes\n- do it\n");
		expect(items.map((i) => i.subject)).toEqual(["do it"]);
	});
});

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
			{
				group: "Migrate the DB",
				subject: "Migrate the DB",
				detail: "Run the migration in prod.",
				identity: { version: 1, headingPath: ["Migrate the DB"], workBody: "Run the migration in prod." },
			},
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

describe("plan reconciliation", () => {
	it("preserves a versioned full-path identity and verbatim prose-only work body", () => {
		const [{ identity, detail, group, subject }] = parsePlanItems(
			"# Release\n## Platform\n### Migration\nMove traffic after the canary.\nKeep the rollback window open.\n",
		);
		expect({ identity, detail, group, subject }).toEqual({
			identity: {
				version: 1,
				headingPath: ["Platform", "Migration"],
				workBody: "Move traffic after the canary.\nKeep the rollback window open.",
			},
			detail: "Move traffic after the canary.\nKeep the rollback window open.",
			group: "Migration",
			subject: "Migration",
		});
	});

	it("projects section prose alongside bullets and invalidates their carry when it changes", () => {
		const first = applyPlanApproval(
			empty(),
			"p1",
			"# Plan\n## Migration\nMigrate database A.\n- Verify migration\n",
		).state;
		first.tasks.find((task) => task.subject === "Verify migration")!.status = "completed";
		first.tasks.find((task) => task.subject === "Verify migration")!.evidence = "verified A";
		const { state } = applyPlanApproval(
			first,
			"p2",
			"# Plan\n## Migration\nMigrate database B.\n- Verify migration\n",
		);
		expect(state.tasks.map((task) => [task.subject, task.status, task.evidence])).toEqual([
			["Migration", "pending", undefined],
			["Verify migration", "pending", undefined],
		]);
	});

	it("does not carry a status when prose-only work changes", () => {
		const first = applyPlanApproval(empty(), "p1", "# Plan\n## Migration\nMigrate database A.\n").state;
		first.tasks[0] = { ...first.tasks[0], status: "completed", evidence: "A migrated" };
		const { state } = applyPlanApproval(first, "p2", "# Plan\n## Migration\nMigrate database B.\n");
		expect(state.tasks[0].status).toBe("pending");
		expect(state.tasks[0].evidence).toBeUndefined();
	});

	it("carries unchanged work once and records its prior plan provenance", () => {
		const first = applyPlanApproval(empty(), "p1", "# Plan\n## Work\n- Ship it\n").state;
		first.tasks[0] = { ...first.tasks[0], status: "completed", evidence: "tests pass" };
		const { state } = applyPlanApproval(first, "p2", "# Plan\n## Work\n- Ship it\n");
		expect(state.tasks[0]).toMatchObject({
			status: "completed",
			evidence: "tests pass",
			planProvenance: { planId: "p1", taskId: 1 },
		});
	});

	it("uses the full heading path to carry repeated labels independently", () => {
		const plan = "# Plan\n## Backend\n### Tests\n- Add tests\n## Frontend\n### Tests\n- Add tests\n";
		const first = applyPlanApproval(empty(), "p1", plan).state;
		first.tasks[0] = { ...first.tasks[0], status: "in_progress" };
		first.tasks[1] = { ...first.tasks[1], status: "deferred", reason: "frontend unavailable" };
		const { state } = applyPlanApproval(first, "p2", plan);
		expect(state.tasks.map((task) => [task.status, task.reason, task.planProvenance])).toEqual([
			["pending", undefined, undefined],
			["deferred", "frontend unavailable", { planId: "p1", taskId: 2 }],
		]);
	});

	it("restarts duplicate identities pending rather than guessing which prior task matches", () => {
		const first = applyPlanApproval(empty(), "p1", "# Plan\n## Work\n- Ship it\n- Ship it\n").state;
		first.tasks[1] = { ...first.tasks[1], status: "completed", evidence: "second only" };
		const { state } = applyPlanApproval(first, "p2", "# Plan\n## Work\n- Ship it\n- Ship it\n");
		expect(state.tasks.map((task) => [task.status, task.evidence, task.planProvenance])).toEqual([
			["pending", undefined, undefined],
			["pending", undefined, undefined],
		]);
	});

	it("does not carry legacy plan tasks without a versioned identity", () => {
		const legacy: TaskState = {
			tasks: [
				{ id: 1, subject: "Ship it", status: "completed", source: "plan", planGroup: "Work", evidence: "old" },
			],
			nextId: 2,
			plan: { id: "p1", title: "Plan" },
		};
		const { state } = applyPlanApproval(legacy, "p2", "# Plan\n## Work\n- Ship it\n");
		expect(state.tasks[0]).toMatchObject({ status: "pending" });
		expect(state.tasks[0].evidence).toBeUndefined();
	});

	it("keeps prose-only work without a title heading", () => {
		expect(parsePlanItems("## Migration\nRun the migration.\n")).toEqual([
			{
				group: "Migration",
				subject: "Migration",
				detail: "Run the migration.",
				identity: { version: 1, headingPath: ["Migration"], workBody: "Run the migration." },
			},
		]);
	});

	it("tracks indented closing fences and keeps prose-attached commands in the identity", () => {
		const items = parsePlanItems("## Migration\nRun migration:\n  ~~~~sql\n  - example only\n  ~~~~\n");
		expect(items).toMatchObject([
			{
				subject: "Migration",
				identity: {
					workBody: "Run migration:\n  ~~~~sql\n  - example only\n  ~~~~",
				},
			},
		]);
	});

	it("treats root four-space backticks as code, not a fence", () => {
		const items = parsePlanItems("## Work\n    ```\n    example\n- Real task\n");
		expect(items.map((item) => item.subject)).toEqual(["Real task"]);
	});

	it("does not turn an indented fenced example into a task", () => {
		const items = parsePlanItems("## Work\n    ~~~~markdown\n    - example only\n    ~~~~\n- Real task\n");
		expect(items.map((item) => item.subject)).toEqual(["Real task"]);
	});

	it("keeps a leading fenced command once later prose makes the section work", () => {
		const [item] = parsePlanItems("## Migration\n```sql\nALTER TABLE widgets;\n```\nRun the migration.\n");
		expect(item.identity.workBody).toBe("```sql\nALTER TABLE widgets;\n```\nRun the migration.");
	});

	it("does not close a root fence with four-space indented backticks", () => {
		const items = parsePlanItems("## Work\n```markdown\n    ```\n- example only\n```\n- Real task\n");
		expect(items.map((item) => item.subject)).toEqual(["Real task"]);
	});

	it("retains code-only work sections and invalidates evidence when commands change", () => {
		const first = applyPlanApproval(empty(), "p1", "## Migration\n```sql\nMIGRATE A;\n```\n").state;
		expect(first.tasks).toHaveLength(1);
		first.tasks[0] = { ...first.tasks[0], status: "completed", evidence: "A migrated" };
		const changed = applyPlanApproval(first, "p2", "## Migration\n```sql\nMIGRATE B;\n```\n").state;
		expect(changed.tasks[0].status).toBe("pending");
	});

	it("retains colon-ended work context and leading commands in bullet identity", () => {
		for (const context of ["Migrate database A:", "```sql\nMIGRATE A;\n```\n"]) {
			const plan = `## Migration\n${context}\n- Verify migration\n`;
			const first = applyPlanApproval(empty(), "p1", plan).state;
			const task = first.tasks.find((item) => item.subject === "Verify migration")!;
			task.status = "completed";
			task.evidence = "A verified";
			const changed = applyPlanApproval(first, "p2", plan.replace(" A", " B")).state;
			expect(changed.tasks.find((item) => item.subject === "Verify migration")?.status).toBe("pending");
		}
	});

	it("invalidates descendant evidence when enclosing work prose changes", () => {
		const plan = "# Plan\n## Migration\nMigrate database A.\n### Verification\n- Check the migrated database\n";
		const first = applyPlanApproval(empty(), "p1", plan).state;
		const verification = first.tasks.find((task) => task.subject === "Check the migrated database")!;
		verification.status = "completed";
		verification.evidence = "A checked";
		const revised = applyPlanApproval(first, "p2", plan.replace("database A", "database B")).state;
		expect(revised.tasks.find((task) => task.subject === verification.subject)?.status).toBe("pending");
	});

	it("ends a nested fence with its list container", () => {
		const items = parsePlanItems("## Work\n- Task\n  ```markdown\n  - example\n- Next\n");
		expect(items.map((item) => item.subject)).toEqual(["Task", "Next"]);
	});

	it("checks nested closing-fence indentation relative to the list content", () => {
		const items = parsePlanItems("## Work\n- Task\n  ```markdown\n      ```\n  - example\n  ```\n- Next\n");
		expect(items.map((item) => item.subject)).toEqual(["Task", "Next"]);
		expect(items[0].identity.workBody).toContain("  - example\n  ```");
	});

	it("tracks fence characters and opening run length", () => {
		const items = parsePlanItems("# Plan\n## Work\n~~~~markdown\n```\n- example only\n```\n~~~~\n- Real task\n");
		expect(items.map((item) => item.subject)).toEqual(["Real task"]);
	});
});

describe("applyPlanApproval", () => {
	it("seeds verbatim plan items tagged source: plan", () => {
		const { state, changed } = applyPlanApproval(empty(), "p1", SMALL_PLAN);
		expect(changed).toBe(true);
		expect(state.plan).toEqual({ id: "p1", title: "Add widgets" });
		expect(state.tasks).toMatchObject([
			{
				id: 1,
				subject: "Add the `alpha` module",
				status: "pending",
				source: "plan",
				planGroup: "Work",
				planIdentity: { version: 1, headingPath: ["Work"], workBody: "Add the `alpha` module" },
			},
			{
				id: 2,
				subject: "Wire `beta` into the CLI",
				status: "pending",
				source: "plan",
				planGroup: "Work",
				planText: "- flag `--beta`",
				planIdentity: {
					version: 1,
					headingPath: ["Work"],
					workBody: "Wire `beta` into the CLI\n  - flag `--beta`",
				},
			},
			{
				id: 3,
				subject: "`make test` passes",
				status: "pending",
				source: "plan",
				planGroup: "Verification",
				planIdentity: { version: 1, headingPath: ["Verification"], workBody: "`make test` passes" },
			},
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
