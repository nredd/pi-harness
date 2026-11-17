/** Exercise the bundled module graph, not a text search over just the fixture's direct imports. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Follow owned helper modules while treating the public host packages as external SDK boundaries. */
async function fixtureGraph(name: string) {
	return build({
		entryPoints: [fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))],
		bundle: true,
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
					builder.onResolve({ filter: /^@earendil-works\/.*\/testing(?:\/|$)/ }, (args) => ({
						errors: [{ text: `fork-only testing export: ${args.path}` }],
					}));
					builder.onResolve({ filter: /^@nredd\/pi-test-lib\// }, (args) => ({
						path: require.resolve(args.path),
					}));
				},
			},
		],
	});
}

it("headless fixtures traverse real shared helpers without importing fork testing exports", async () => {
	const graph = await fixtureGraph("session");
	const inputs = Object.keys(graph.metafile.inputs);
	expect(inputs.some((path) => path.endsWith("tests/lib/src/harness.ts"))).toBe(true);
	expect(inputs.some((path) => path.endsWith("tests/lib/src/faux.ts"))).toBe(true);
	expect(inputs.some((path) => path.endsWith("fixtures/terminal.ts"))).toBe(false);
});

it("the same graph guard rejects the real terminal fixture's fork-only dependency", async () => {
	await expect(fixtureGraph("terminal")).rejects.toThrow(
		"fork-only testing export: @earendil-works/pi-coding-agent/testing/interactive",
	);
});
