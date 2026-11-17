// `managed_browser_profile` opt-in: only the user-global file may set it (#674).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { loadComputerUseConfig } from "../src/config.ts";

let root: string;
let savedAgentDir: string | undefined;
const cwd = () => path.join(root, "project");
const writeJson = (file: string, value: unknown) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
};
const userFile = () => path.join(root, "agent", "extensions", "pi-computer-use.json");
const projectFile = () => path.join(cwd(), ".pi", "computer-use.json");

beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	root = mkdtempSync(path.join(os.tmpdir(), "cu-profile-config-"));
	mkdirSync(cwd(), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(root, { recursive: true, force: true });
	loadComputerUseConfig(path.join(os.tmpdir(), "cu-profile-config-reset"));
});

test("only user-global config can opt into a persistent credential-bearing profile", () => {
	writeJson(projectFile(), { managed_browser_profile: "/repo-controlled" });
	assert.equal(loadComputerUseConfig(cwd()).config.managed_browser_profile, null);
	for (const value of [null, 42, "", "   "]) {
		writeJson(userFile(), { managed_browser_profile: value });
		assert.equal(loadComputerUseConfig(cwd()).config.managed_browser_profile, null);
	}
	writeJson(userFile(), { computer_use: { managed_browser_profile: " ~/dedicated-profile " } });
	assert.equal(loadComputerUseConfig(cwd()).config.managed_browser_profile, "~/dedicated-profile");
	writeJson(projectFile(), { computer_use: { managed_browser_profile: "/repo-controlled" } });
	assert.equal(loadComputerUseConfig(cwd()).config.managed_browser_profile, "~/dedicated-profile");
});
