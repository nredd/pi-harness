import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("check-ts adds the account tool directory without replacing the inherited PATH", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-check-ts-path-"));
	try {
		const bin = join(fixture, "bin");
		const home = join(fixture, "home");
		const tools = join(home, ".pi", "agent", "bin");
		mkdirSync(bin);
		mkdirSync(tools, { recursive: true });
		writeFileSync(join(tools, "fd"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
		writeFileSync(join(bin, "npm"), '#!/bin/sh\ncommand -v fd\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
		const result = spawnSync("/usr/bin/make", ["check-ts", "WORKSPACES=integration/inprocess"], {
			cwd: root,
			env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(join(tools, "fd"));
		expect(result.stdout).toContain("--workspace=integration/inprocess");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
