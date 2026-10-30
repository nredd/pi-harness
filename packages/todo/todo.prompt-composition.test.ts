/**
 * Prompt-composition regression (#237) -- real Pi loader and AgentSession, no
 * mocked tool registration. The assertion is at the same seam agents receive.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHarness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url));
const OLD_GUIDANCE = /exactly one task in_progress|never batch completions/i;

describe("todo SDK-composed prompt", () => {
	let home: string;
	let previousXdgConfigHome: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "rpiv-todo-prompt-"));
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		mkdirSync(join(home, "cwd"));
		mkdirSync(join(home, "agent"));
	});

	afterEach(() => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("composes parallel ownership and immediate atomic completion guidance", async () => {
		const cwd = join(home, "cwd");
		const agentDir = join(home, "agent");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [PACKAGE_DIR],
		});
		await resourceLoader.reload();
		const harness = await createHarness({ cwd, resourceLoader });
		try {
			await harness.session.bindExtensions({ mode: "print" });
			const prompt = harness.session.systemPrompt;

			expect(harness.session.getActiveToolNames()).toContain("todo");
			expect(prompt).toContain("Multiple parallel tasks may be in_progress: use owner to identify each worker");
			expect(prompt).toContain("Mark each verified task completed IMMEDIATELY");
			expect(prompt).toContain("multiple independent results already verified together");
			expect(prompt).not.toMatch(OLD_GUIDANCE);
		} finally {
			harness.cleanup();
		}
	});
});
