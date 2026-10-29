import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { configFor, outcomes, ScenarioFixture, sessionFile, tool } from "./support.ts";

const RULE = "RULE-MARKER use tabs in TypeScript";
let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

/** A path-scoped project rule and both matching and nonmatching files. */
function files(): ScenarioFixture {
	const fixture = new ScenarioFixture();
	mkdirSync(join(fixture.root, ".pi", "rules"), { recursive: true });
	mkdirSync(join(fixture.root, "src"));
	writeFileSync(join(fixture.root, ".pi", "rules", "ts.md"), `---\npaths:\n  - src/**/*.ts\n---\n${RULE}\n`);
	for (const name of ["src/a.ts", "src/b.ts", "README.md"]) writeFileSync(join(fixture.root, name), "content\n");
	return fixture;
}

/** Rule-injection entries recorded on the session branch. */
function injectedRules(harness: Awaited<ReturnType<ScenarioFixture["start"]>>): unknown[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "session-kit:rule-injected" ? [entry.data] : [],
		);
}

it("matching rule injects once after unmatched read", async () => {
	fixture = files();
	const harness = await fixture.start(configFor("rules"));
	harness.setResponses([tool("read", { path: "README.md" }), fauxAssistantMessage("OK")]);
	await harness.session.prompt("unmatched");
	const [unmatched] = outcomes(harness, "read");
	expect(unmatched?.isError).toBe(false);
	expect(unmatched?.text).not.toContain(RULE);
	expect(injectedRules(harness)).toEqual([]);

	harness.setResponses([
		tool("read", { path: "src/a.ts" }),
		tool("read", { path: "src/b.ts" }),
		fauxAssistantMessage("OK"),
	]);
	await harness.session.prompt("matched");
	const results = outcomes(harness, "read");
	expect(results).toHaveLength(3);
	expect(results.every((result) => !result.isError)).toBe(true);
	expect(results[1]?.text).toContain(RULE);
	expect(results[2]?.text).not.toContain(RULE);
	expect(injectedRules(harness)).toEqual([{ rule: "project:ts.md" }]);
});

it("tree navigation rebuilds injected rules for the actual selected branch", async () => {
	fixture = files();
	const harness = await fixture.start(configFor("rules"));
	const root = harness.sessionManager.appendCustomEntry("fixture:branch-root", {});
	harness.setResponses([
		tool("read", { path: "src/a.ts" }),
		tool("read", { path: "src/b.ts" }),
		fauxAssistantMessage("OK"),
	]);
	await harness.session.prompt("first branch");
	expect(outcomes(harness, "read").map((result) => result.text.includes(RULE))).toEqual([true, false]);
	expect(injectedRules(harness)).toEqual([{ rule: "project:ts.md" }]);
	await harness.session.navigateTree(root, { summarize: false });
	expect(injectedRules(harness)).toEqual([]);
	harness.setResponses([tool("read", { path: "src/a.ts" }), fauxAssistantMessage("OK")]);
	await harness.session.prompt("new branch");
	expect(outcomes(harness, "read").at(-1)?.text).toContain(RULE);
	expect(injectedRules(harness)).toEqual([{ rule: "project:ts.md" }]);
});

it("file-backed restore remembers injected rules", async () => {
	fixture = files();
	const first = await fixture.start(configFor("rules"));
	first.setResponses([tool("read", { path: "src/a.ts" }), fauxAssistantMessage("OK")]);
	await first.session.prompt("go");
	expect(outcomes(first, "read")[0]?.text).toContain(RULE);
	const file = sessionFile(first);
	first.cleanup();
	const second = await fixture.start(configFor("rules"), { sessionManager: SessionManager.open(file) });
	second.setResponses([tool("read", { path: "src/b.ts" }), fauxAssistantMessage("OK")]);
	await second.session.prompt("again");
	expect(outcomes(second, "read").at(-1)?.text).not.toContain(RULE);
	expect(outcomes(second, "read").at(-1)?.isError).toBe(false);
});
