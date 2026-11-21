import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, onTestFinished, test } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test.each([false, true])("check-ts preserves inherited fd precedence (inherited fd: %s)", (inherited) => {
	const fixture = makeTestTempDir("pi-check-ts-path-", onTestFinished);
	const bin = join(fixture, "bin");
	const home = join(fixture, "home");
	const tools = join(home, ".pi", "agent", "bin");
	mkdirSync(bin);
	if (inherited) writeFileSync(join(bin, "fd"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
	mkdirSync(tools, { recursive: true });
	writeFileSync(join(tools, "fd"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
	writeFileSync(join(bin, "node"), '#!/bin/sh\ntest "$1" = scripts/check-test-tempdirs.mjs\n', { mode: 0o755 });
	writeFileSync(join(bin, "npm"), '#!/bin/sh\ncommand -v fd\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
	const result = spawnSync("/usr/bin/make", ["check-ts", "WORKSPACES=tests/inprocess"], {
		cwd: root,
		env: { ...process.env, HOME: home, PATH: bin },
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain(join(inherited ? bin : tools, "fd"));
	expect(result.stdout).toContain("--workspace=tests/inprocess");
});
