/** Identity-only fixture receipt. This does not attest the code loaded by an older live process. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadFork, resolveHost } from "./support.ts";
import { verifyInstalledPackage } from "./verification/core-artifacts.ts";
import { pinnedCoreTarball } from "./verification/core-pins.ts";

type Lock = { packages: Record<string, { resolved?: string; integrity?: string }> };

it("binds the fixture's core imports to the exact lockfile artifacts, not a same-version stale install", async () => {
	const root = new URL("../../", import.meta.url);
	const expected: Lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
	const installed: Lock = JSON.parse(readFileSync(new URL("node_modules/.package-lock.json", root), "utf8"));
	const receipts = [];
	for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
		const key = `node_modules/@earendil-works/${name}`;
		const wanted = expected.packages[key];
		const actual = installed.packages[key];
		expect(wanted?.integrity).toMatch(/^sha512-/);
		expect(wanted?.resolved).toMatch(/^https:\/\/github\.com\/nredd\/pi\/releases\/download\/v[\w.-]+\//);
		expect(actual?.integrity).toBe(wanted?.integrity);
		expect(actual?.resolved).toBe(wanted?.resolved);
		const entry = resolveHost(`@earendil-works/${name}`, new URL(import.meta.url));
		expect(entry).toBe(realpathSync(fileURLToPath(new URL(`${key}/dist/index.js`, root))));
		// Metadata and barrels cannot see a stale nested module: every packaged file must equal the tarball.
		const content = verifyInstalledPackage(
			realpathSync(fileURLToPath(new URL(key, root))),
			pinnedCoreTarball(name).tarball,
		);
		receipts.push({
			...content,
			package: `@earendil-works/${name}`,
			artifact: wanted?.resolved,
			integrity: wanted?.integrity,
			entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
		});
	}
	expect(typeof (await loadFork("rpiv-todo"))).toBe("function");
	const todo = ["index.ts", "plan-hooks.ts", "state/agents.ts", "state/monitors.ts"].map((file) => ({
		file: `packages/todo/${file}`,
		sha256: createHash("sha256")
			.update(readFileSync(new URL(`packages/todo/${file}`, root)))
			.digest("hex"),
	}));
	// Only fixed public package identities and hashes, never process paths or runtime config.
	console.info(JSON.stringify({ kind: "settlement-fixture-identity", receipts, todo }));
});
