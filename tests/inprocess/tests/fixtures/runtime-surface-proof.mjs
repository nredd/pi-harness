/** Run the real SDK in a fresh process, shared by owned and released-prefix compatibility probes. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, prefix, subagents] = process.argv.slice(2);
const modules = join(prefix, "node_modules");
const require = createRequire(import.meta.url);
const { createJiti } = require(join(modules, "jiti"));
const jiti = createJiti(import.meta.url);
const { registerFauxProvider } = await import(
	pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/compat.js")).href
);
const { loadCustomAgents } = jiti(join(subagents, "src/custom-agents.ts"));
const { registerAgents } = jiti(join(subagents, "src/agent-types.ts"));
const { selectModel } = jiti(join(subagents, "src/model-selection.ts"));
const { runAgent } = jiti(join(subagents, "src/agent-runner.ts"));
const agent = join(root, "agent");
const project = join(root, "project");
const globalExtension = join(root, "global-mutator.mjs");
const projectExtension = join(root, "project-mutator.mjs");
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
mkdirSync(join(project, ".pi"), { recursive: true });
const mutator = (name) => `
  import { writeFileSync } from 'node:fs';
  export default (pi) => pi.registerTool({
    name: '${name}', label: '${name}', description: 'writes a marker when invoked',
    parameters: { type: 'object', properties: {} },
    async execute() { writeFileSync(${JSON.stringify(join(root, `${name}.marker`))}, 'mutated'); return { content: [] }; },
  });
`;
writeFileSync(globalExtension, mutator("global_file_writer"));
writeFileSync(projectExtension, mutator("project_git_mutator"));
json(join(agent, "settings.json"), { extensions: [globalExtension] });
json(join(project, ".pi/settings.json"), { extensions: [projectExtension] });

// Exercise real web registration through the directory entry that historically failed package admission.
const webPackage = join(root, "web-package");
mkdirSync(join(webPackage, "dist"), { recursive: true });
json(join(webPackage, "package.json"), { name: "pi-web-access", type: "module", pi: { extensions: ["./dist"] } });
writeFileSync(
	join(webPackage, "dist/index.js"),
	`
  import web from ${JSON.stringify(join(modules, "pi-web-access/dist/index.js"))};
  export default async (pi) => {
    await web(pi);
    pi.registerTool({ name: 'future_web_writer', label: 'future writer', description: 'denial control',
      parameters: { type: 'object', properties: {} }, async execute() { throw new Error('must not run'); } });
  };
`,
);
const devPackage = join(root, "dev-package");
mkdirSync(join(devPackage, "src"), { recursive: true });
json(join(devPackage, "package.json"), {
	name: "@example/pi-dev-tools",
	type: "module",
	pi: { extensions: ["./src/index.js"] },
});
writeFileSync(
	join(devPackage, "src/index.js"),
	`
  export default (pi) => {
    for (const name of ['git_log', 'git_diff', 'git_show', 'git_status', 'ssh_exec', 'git_commit']) {
      pi.registerTool({ name, label: name, description: 'synthetic Git/SSH admission fixture',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: name }], details: undefined }; } });
    }
  };
`,
);
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200000 }] });
const model = faux.getModel();
const modelRegistry = {
	find: () => model,
	getAll: () => [model],
	getAvailable: () => [model],
	hasConfiguredAuth: () => true,
	isUsingOAuth: () => false,
	getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
	registerProvider: () => {},
	unregisterProvider: () => {},
};
const ctx = { cwd: project, getSystemPrompt: () => "PARENT", isProjectTrusted: () => true, model, modelRegistry };
const sessions = [];
/** Inspect the real child session, even when its un-scripted faux turn fails. */
async function active(config, type = "Explore") {
	registerAgents(new Map([[type, config]]));
	const selection = selectModel({
		agentType: type,
		definitionModel: config.model,
		paramModel: model,
		parentModel: model,
		registry: modelRegistry,
		cwd: project,
	});
	assert.notEqual(typeof selection, "string");
	let session;
	try {
		await runAgent(ctx, type, "go", {
			pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) },
			modelSelection: selection,
			onSessionCreated: (created) => {
				session = created;
				sessions.push(created);
			},
		});
	} catch {
		// No model/network work is required: creation of the actual SDK session is the seam.
	}
	assert.ok(session, "the real SDK must create a child session");
	return { active: session.getActiveToolNames(), registered: session.getAllTools().map((tool) => tool.name), session };
}
try {
	const explore = loadCustomAgents(project, true, { projectTrusted: true }).get("Explore");
	assert.ok(explore, "the Explore-shaped artifact must load");
	const enabled = await active({ ...explore, extensions: true });
	assert.ok(enabled.active.includes("global_file_writer"));
	assert.ok(enabled.active.includes("project_git_mutator"));
	const restricted = await active(explore);
	assert.deepEqual(restricted.active, ["read", "grep", "find", "ls"]);
	for (const forbidden of ["bash", "global_file_writer", "project_git_mutator"]) {
		assert.ok(!restricted.active.includes(forbidden), `${forbidden} must not be active`);
		assert.ok(!restricted.registered.includes(forbidden), `${forbidden} must not register`);
	}
	for (const workMachine of [false, true]) {
		json(join(agent, "settings.json"), { packages: [webPackage, devPackage], extensions: [globalExtension] });
		// Both rendered profiles have the same scope policy; routing is deliberately absent in this faux proof.
		json(join(agent, "subagents.json"), {
			maxSubagentDepth: 2,
			scopeModels: true,
			strictAgentFiles: true,
			packageAgents: false,
			workflowsEnabled: true,
		});
		const architect = loadCustomAgents(project, true, { projectTrusted: true }).get("architect");
		assert.ok(architect);
		const actual = await active(architect, "architect");
		const expected = [
			"read",
			"grep",
			"find",
			"git_log",
			"git_diff",
			"git_show",
			"git_status",
			"web_search",
			"fetch_content",
			"get_search_content",
			"source_check",
		];
		assert.deepEqual(
			actual.active.filter((name) => name !== "SubagentWorkflow").sort(),
			expected.sort(),
			`architect web surface: work=${workMachine}`,
		);
		const gate = (name) =>
			actual.session.agent.beforeToolCall(
				{ toolCall: { name, arguments: {}, id: "scope-proof" } },
				new AbortController().signal,
			);
		assert.equal((await gate("SubagentWorkflow"))?.block, true);
		const missing = await active({ ...architect, extensions: ["pi-dev-tools"] }, "architect");
		assert.ok(!missing.active.includes("web_search"), "negative control must reproduce the missing web extension");
		for (const name of [
			"bash",
			"edit",
			"write",
			"Agent",
			"ssh_exec",
			"git_commit",
			"future_web_writer",
			"global_file_writer",
			"project_git_mutator",
		]) {
			assert.ok(!actual.active.includes(name), `${name} must not be active`);
			assert.equal((await gate(name))?.block, true, `${name} must be denied at call time`);
		}
		for (const name of ["web_search", "fetch_content", "get_search_content", "source_check"])
			assert.ok(!(await gate(name))?.block, `${name} must be admitted at call time`);
		const result = await actual.session
			.getToolDefinition("get_search_content")
			.execute("missing", { responseId: "nonexistent-fixture" }, new AbortController().signal);
		assert.match(JSON.stringify(result), /not found|expired|No .*found/i);
	}
} finally {
	for (const session of sessions) session.dispose();
	faux.unregister();
}
