/** Traverse the real module graph of the headless stale-ctx and restart tests, not just their direct imports. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const testDir = fileURLToPath(new URL(".", import.meta.url));

/** Headless tests that once imported the fork's `/testing` root and now use the shared public-SDK harness (#916). */
const HEADLESS = [
	"./restart-lifecycle-diagnosis.test.ts",
	"./stale-ctx-captured.test.ts",
	"./stale-ctx-recovery.test.ts",
];

/**
 * Bundle owned modules while treating the public SDK and other dependencies as external. `lazyTerminal`
 * keeps `scenario-session.ts`'s on-demand interactive import external: `scenario-session-headless.test.ts`
 * already proves a headless run never evaluates it, so this graph checks every other edge.
 */
function testGraph(entryPoints: string[], lazyTerminal = false) {
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
					if (lazyTerminal) {
						builder.onResolve({ filter: /^\.\/scenario-terminal\.ts$/ }, (args) => ({
							path: args.path,
							external: true,
						}));
					}
					builder.onResolve({ filter: /^@earendil-works\/pi-(coding-agent|tui)\/testing(?:\/|$)/ }, (args) => ({
						errors: [{ text: `fork-only testing export: ${args.path}` }],
					}));
					builder.onResolve({ filter: /^@nredd\/pi-test-lib\// }, (args) => ({ path: require.resolve(args.path) }));
				},
			},
		],
	});
}

it("headless stale-ctx and restart tests reach the shared public-SDK harness without fork testing exports", async () => {
	const { metafile } = await testGraph(HEADLESS, true);
	const inputs = Object.keys(metafile.inputs);
	for (const entry of HEADLESS) expect(inputs).toContain(entry.slice(2));
	expect(inputs).toContain("fixtures/scenario-session.ts");
	expect(inputs.some((path) => path.endsWith("tests/lib/src/harness.ts"))).toBe(true);
	expect(inputs.some((path) => path.endsWith("scenario-terminal.ts"))).toBe(false);
});

it("the same graph guard rejects the real terminal fixture's fork-only dependency", async () => {
	await expect(testGraph(["./fixtures/scenario-terminal.ts"])).rejects.toThrow(
		"fork-only testing export: @earendil-works/pi-coding-agent/testing/interactive",
	);
});
