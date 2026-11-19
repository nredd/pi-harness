/** Traverse real router fixtures and their shared helpers, not just their direct imports. */
import { globSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const testDir = fileURLToPath(new URL(".", import.meta.url));

/** Bundle owned modules while treating the public SDK and other dependencies as external. */
function testGraph(entryPoints: string[]) {
	return build({
		absWorkingDir: testDir,
		entryPoints,
		bundle: true,
		outdir: "unused",
		platform: "node",
		format: "esm",
		packages: "external",
		write: false,
		metafile: true,
		logLevel: "silent",
		plugins: [
			{
				name: "public-sdk-only",
				setup(builder) {
					builder.onResolve({ filter: /^@earendil-works\/pi-(coding-agent|tui)\/testing(?:\/|$)/ }, (args) => ({
						errors: [{ text: `fork-only testing export: ${args.path}` }],
					}));
					builder.onResolve({ filter: /^@nredd\/pi-test-lib\// }, (args) => ({ path: require.resolve(args.path) }));
				},
			},
		],
	});
}

it("router tests reach the real public SDK harness without fork testing exports", async () => {
	const { metafile } = await testGraph(globSync("**/*.test.ts", { cwd: testDir }).map((path) => `./${path}`));
	const inputs = Object.keys(metafile.inputs);
	expect(inputs).toContain("fixtures/router.ts");
	expect(inputs).toContain("fixtures/ownership.ts");
	expect(inputs.some((path) => path.endsWith("tests/lib/src/harness.ts"))).toBe(true);
	expect(inputs.some((path) => path.endsWith("tests/lib/src/resources.ts"))).toBe(true);
});

it("rejects the real router footer test's transitive fork interactive host", async () => {
	await expect(testGraph(["../../../tests/inprocess/footer-router.test.ts"])).rejects.toThrow(
		"fork-only testing export: @earendil-works/pi-coding-agent/testing/interactive",
	);
});
