/** Native import recorder: first import of a child process; refuses any fork-only testing module. */
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";

/** Every specifier or file the child resolved or loaded, in order. */
export const imports = new Set();
const FORK_TESTING = /pi-(?:coding-agent|tui)\/(?:dist\/)?testing/;

/**
 * Record `specifier` and refuse a fork testing module.
 *
 * @param {string} specifier Import specifier or resolved path.
 * @throws {Error} `FORK_BOUNDARY: <specifier>` for a fork testing module.
 */
function check(specifier) {
	imports.add(specifier);
	if (FORK_TESTING.test(specifier)) throw new Error(`FORK_BOUNDARY: ${specifier}`);
}

if (globalThis.Bun) {
	Bun.plugin({
		name: "stack-headless-graph",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				check(args.path);
			});
			// Observe only the relevant ESM boundary, leaving third-party CommonJS loading native.
			build.onLoad(
				{ filter: /tests\/inprocess\/support\.ts$|tests\/lib\/src\/harness\.ts$|pi-(coding-agent|tui)\/dist\/.*\.js$/ },
				(args) => {
					check(args.path);
					return { contents: readFileSync(args.path, "utf8"), loader: args.path.endsWith(".ts") ? "ts" : "js" };
				},
			);
		},
	});
} else {
	nodeModule.registerHooks({
		resolve(specifier, context, next) {
			check(specifier);
			return next(specifier, context);
		},
	});
}
