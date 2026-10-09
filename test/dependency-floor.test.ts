import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "vitest";

const { minVersion, gte } = createRequire(import.meta.url)("semver") as {
  minVersion(range: string): { version: string } | null;
  gte(version: string, minimum: string): boolean;
};

test("Plan mode's Kit floor excludes releases without custom-editor questionnaire support", () => {
  const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
  const range = manifest.dependencies["@narumitw/pi-tui-kit"];
  const minimum = minVersion(range);
  assert.ok(minimum, `Expected a valid Kit dependency range, received ${range}`);
  assert.ok(
    gte(minimum.version, "0.65.2"),
    `Kit range ${range} permits a release predating questionnaire editor support`,
  );
});
