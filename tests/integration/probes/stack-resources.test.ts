import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import stackResourcesProbe from "./stack-resources.ts";

type Handler = (event: unknown, ctx: { cwd: string; isProjectTrusted(): boolean }) => Promise<void>;

const ENV = ["HARNESS_RESOURCE_REPORT", "HARNESS_PRESET_ROOT", "PI_CODING_AGENT_DIR", "PI_OFFLINE"] as const;
const saved = new Map(ENV.map((name) => [name, process.env[name]]));
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "stack-resources-probe-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

/** Write `files` (path relative to `root` -> content) into the disposable tree. */
function tree(files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

/** Register the probe against a recording API whose registry holds `tools`; return the hook. */
function hook(tools: string[]): () => Promise<void> {
	const handlers = new Map<string, Handler>();
	stackResourcesProbe({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		getAllTools: () =>
			tools.map((name) => ({ name, parameters: { type: "object", title: name } }) as unknown as ToolInfo),
	} as unknown as ExtensionAPI);
	const handler = handlers.get("before_agent_start");
	assert.ok(handler);
	const ctx = { cwd: join(root, "project"), isProjectTrusted: () => true };
	return () => handler({}, ctx);
}

/** A preset package plus an outside package, enabled through trusted project settings. */
function stack(packages: unknown[]): void {
	tree({
		"preset/extensions/probe.ts": "export default () => {};\n",
		"preset/skills/review/SKILL.md": "---\nname: review\ndescription: Review.\n---\nReview.\n",
		"preset/prompts/ship.md": "Ship it.\n",
		"preset/themes/night.json": "{}\n",
		"outside/extensions/stray.ts": "export default () => {};\n",
		"project/.pi/settings.json": JSON.stringify({ packages }),
	});
	process.env.HARNESS_PRESET_ROOT = join(root, "preset");
	process.env.HARNESS_RESOURCE_REPORT = join(root, "report.json");
}

test("reports the enabled preset resources relative to the preset and the Agent schema", async () => {
	stack([{ source: join(root, "preset"), themes: [] }, join(root, "outside")]);
	await hook(["read", "Agent"])();
	assert.deepEqual(JSON.parse(readFileSync(join(root, "report.json"), "utf8")), {
		resources: {
			extensions: ["extensions/probe.ts"],
			skills: ["skills/review/SKILL.md"],
			prompts: ["prompts/ship.md"],
			themes: [],
		},
		agentParameters: { type: "object", title: "Agent" },
	});
});

test("refuses to install a missing package source", async () => {
	stack(["npm:@nredd/stack-resources-probe-missing"]);
	await assert.rejects(hook(["Agent"])(), /refuses missing source: npm:@nredd\/stack-resources-probe-missing/);
});

test("refuses to report without the Agent tool registered", async () => {
	stack([join(root, "preset")]);
	await assert.rejects(hook(["read"])(), /cannot find the registered Agent tool/);
	assert.throws(() => readFileSync(join(root, "report.json")), { code: "ENOENT" });
});

test("requires both the report and preset paths", async () => {
	stack([join(root, "preset")]);
	for (const name of ["HARNESS_RESOURCE_REPORT", "HARNESS_PRESET_ROOT"] as const) {
		const value = process.env[name];
		delete process.env[name];
		await assert.rejects(hook(["Agent"])(), /requires explicit report and preset paths/);
		process.env[name] = value;
	}
});
