// Disposable Node process: inject a Linux /proc enumeration failure into the real registry sampler.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const osShim = `export * from 'node:os'; export function platform() { return 'linux'; }`;
// 0.2.1 uses names-only readdir, not opendir's implicit per-entry lstat. This models a whole listing failure,
// not the removed mid-iteration PID-exit mechanism or the unknown errno of the historical incident.
const fsShim = `export * from 'node:fs/promises'; export async function readdir() { const error = new Error('injected listing failure'); error.code = 'EACCES'; throw error; }`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("/pi-resource-sampler/dist/")) {
			if (specifier === "node:os")
				return { url: `data:text/javascript,${encodeURIComponent(osShim)}`, shortCircuit: true };
			if (specifier === "node:fs/promises")
				return { url: `data:text/javascript,${encodeURIComponent(fsShim)}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { createResourceSampler } = await import("@nredd/pi-resource-sampler");
const { registerResourceTools } = await import(
	pathToFileURL(new URL("../src/resource/index.ts", import.meta.url).pathname)
);
const { createToolHost } = await import(pathToFileURL(new URL("./support.ts", import.meta.url).pathname));
const samples = [];
const mock = createToolHost();
registerResourceTools(mock.pi, {
	createSampler(options) {
		const sampler = createResourceSampler(options);
		return {
			async sample(signal) {
				const snapshot = await sampler.sample(signal);
				samples.push(snapshot);
				return snapshot;
			},
			dispose: () => sampler.dispose(),
		};
	},
});
const result = await mock.call("resource_snapshot", { interval_ms: 100, process_limit: 50 }, "/tmp");
process.stdout.write(
	JSON.stringify({
		samples: samples.map((sample) => ({ processes: sample.processes.length, coverage: sample.coverage })),
		result: result.structuredContent,
		text: mock.text(result),
	}),
);
