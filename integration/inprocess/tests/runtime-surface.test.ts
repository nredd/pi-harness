/** Always-on counterpart of dotfiles' skipped selected-SDK surface proof. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("Explore and architect fixtures enforce exact SDK tool surfaces and directory-entry admission", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-surface-"));
	const prefix = fileURLToPath(new URL("../../../", import.meta.url));
	const agent = join(root, "agent");
	mkdirSync(join(agent, "agents"), { recursive: true });
	try {
		for (const name of ["Explore", "architect"]) {
			cpSync(new URL(`./fixtures/agents/${name}.md`, import.meta.url), join(agent, `agents/${name}.md`));
		}
		writeFileSync(
			join(agent, "web-search.json"),
			JSON.stringify({
				toolActivation: "eager",
				allowBrowserCookies: false,
				autoOpenBrowser: false,
			}),
		);
		expect(() =>
			execFileSync(
				process.execPath,
				[
					fileURLToPath(new URL("./fixtures/runtime-surface-proof.mjs", import.meta.url)),
					root,
					prefix,
					join(prefix, "packages/subagents"),
				],
				{
					cwd: root,
					env: {
						...process.env,
						HOME: root,
						PI_CODING_AGENT_DIR: agent,
						XDG_CONFIG_HOME: join(root, ".config"),
						XDG_STATE_HOME: join(root, "state"),
						PI_WEB_ACCESS_CACHE_ROOT: join(root, "web-cache"),
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			),
		).not.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 40_000);
