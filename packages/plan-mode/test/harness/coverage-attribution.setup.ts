import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { afterAll } from "vitest";

// This setup is opt-in via coverage-attribution.config.ts, never the normal test config.
const output = process.env.PLAN_MODE_ATTRIBUTION_DIR;
if (!output || !isAbsolute(output)) throw new Error("Set PLAN_MODE_ATTRIBUTION_DIR to an absolute output directory");
afterAll(() => {
  writeFileSync(
    resolve(output, `runtime-${process.pid}.json`),
    JSON.stringify(Reflect.get(globalThis, "__VITEST_COVERAGE__"), null, 2),
  );
});
