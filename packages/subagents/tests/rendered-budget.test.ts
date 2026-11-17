/** Runtime assertions migrated from dotfiles' skipped published-runtime compatibility checks. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertWithinBudgetDepth,
	budgetUsage,
	releaseBudget,
	resetBudgetForTests,
	setBudgetPolicy,
	tryAcquireBudget,
} from "../src/process-budget.ts";
import { loadBudgetPolicy, loadSettings } from "../src/settings.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/rendered-budget.json", import.meta.url), "utf8"));

// Both profiles render the same policy; an enterprise manifest changes only model selection.
afterEach(() => {
	resetBudgetForTests();
	vi.unstubAllEnvs();
});

for (const workMachine of [false, true]) {
	for (const enterprise of [false, true]) {
		it(`rendered budget admits 12 parents and 2 reviewers: work=${workMachine}, enterprise=${enterprise}`, () => {
			const agent = mkdtempSync(join(tmpdir(), "pi-rendered-budget-"));
			vi.stubEnv("PI_CODING_AGENT_DIR", agent);
			try {
				const { agentModels, ...policySettings } = fixture;
				writeFileSync(
					join(agent, "subagents.json"),
					JSON.stringify(enterprise ? policySettings : { ...policySettings, agentModels }),
				);
				if (enterprise) {
					writeFileSync(
						join(agent, "enterprise.local.json"),
						JSON.stringify({
							version: 1,
							subagents: { modelAliases: { "claude-haiku-4-5": ["example/model"] } },
						}),
						{ mode: 0o600 },
					);
				}
				const policy = loadBudgetPolicy();
				expect(policy).toEqual({ maxActive: 14, nestedReserve: 2, maxDepth: 2 });
				const loaded = loadSettings(agent);
				expect(loaded.maxSubagentDepth).toBe(2);
				if (enterprise) expect(loaded.modelAliases?.["claude-haiku-4-5"]).toEqual(["example/model"]);
				else expect(loaded.agentModels?.["code-reviewer"]).toBe("@review");
				setBudgetPolicy(policy);
				const parents = Array.from({ length: 12 }, () => tryAcquireBudget(1));
				expect(parents.every(Boolean)).toBe(true);
				expect(tryAcquireBudget(1)).toBeUndefined();
				const children = [tryAcquireBudget(2), tryAcquireBudget(2)];
				expect(children.every(Boolean)).toBe(true);
				expect(tryAcquireBudget(2)).toBeUndefined();
				expect(() => assertWithinBudgetDepth(3)).toThrow();
				expect(budgetUsage().active).toBe(14);
				for (const lease of [...parents, ...children]) {
					if (lease) releaseBudget(lease);
				}
				expect(budgetUsage().active).toBe(0);
			} finally {
				rmSync(agent, { recursive: true, force: true });
			}
		});
	}
}
