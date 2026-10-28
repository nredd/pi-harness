import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.js";

// Diagnostic only: preserve the PR's exact provider, scope, and instrumentation defaults.
const output = process.env.PLAN_MODE_ATTRIBUTION_DIR;
if (!output || !isAbsolute(output)) throw new Error("Set PLAN_MODE_ATTRIBUTION_DIR to an absolute output directory");
mkdirSync(output, { recursive: true });
const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(resolve(root, "package.json"));
const provider = require.resolve("@vitest/coverage-istanbul");
const { createInstrumenter } = createRequire(provider)("@vitest/istanbul-lib-instrument");
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(
  resolve(output, "identity.json"),
  JSON.stringify(
    {
      root: realpathSync(root),
      provider: realpathSync(provider),
      node: process.version,
      hashes: Object.fromEntries(
        ["src/plan-mode.ts", "dist/index.ts", "vitest.config.ts"].map((path) => [path, digest(resolve(root, path))]),
      ),
    },
    null,
    2,
  ),
);

export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: [fileURLToPath(new URL("./coverage-attribution.setup.ts", import.meta.url))],
      coverage: {
        enabled: true,
        provider: "istanbul",
        include: ["src/plan-mode.ts"],
        reporter: ["json", "lcov"],
        reportsDirectory: output,
        clean: false,
        instrumenter(options) {
          const instrumenter = createInstrumenter({
            produceSourceMap: true,
            autoWrap: false,
            esModules: true,
            compact: false,
            ...options,
            ignoreLines: true,
          });
          const original = instrumenter.instrumentSync.bind(instrumenter);
          let invocation = 0;
          instrumenter.instrumentSync = (source: string, id: string, map: unknown) => {
            const code = original(source, id, map);
            if (id.split("?")[0]?.endsWith("/src/plan-mode.ts")) {
              const prefix = resolve(output, `instrument-${++invocation}`);
              writeFileSync(`${prefix}.input.js`, source);
              writeFileSync(`${prefix}.js`, code);
              writeFileSync(
                `${prefix}.json`,
                JSON.stringify(
                  {
                    id,
                    inputMap: map,
                    outputMap: instrumenter.lastSourceMap(),
                    coverage: instrumenter.lastFileCoverage(),
                  },
                  null,
                  2,
                ),
              );
            }
            return code;
          };
          return instrumenter;
        },
      },
    },
  }),
);
