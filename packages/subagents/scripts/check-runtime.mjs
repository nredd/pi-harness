#!/usr/bin/env node
// Fails when the committed `dist/` differs from a fresh build of `src/` (stale, missing or extra file).

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function snapshot(directory, prefix = "") {
  const files = new Map();
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) for (const [name, body] of await snapshot(directory, path)) files.set(name, body);
    else files.set(path, await readFile(join(directory, path), "utf8"));
  }
  return files;
}

// Same depth as `dist/`: chunk hashes and source map paths depend on the output location.
const fresh = await mkdtemp(join(root, ".pi-subagents-build-test-"));
try {
  await buildRuntime({ outputDirectory: fresh });
  const [expected, committed] = [await snapshot(fresh), await snapshot(join(root, "dist")).catch(() => new Map())];
  const problems = [
    ...[...expected.keys()].filter((name) => !committed.has(name)).map((name) => `missing: dist/${name}`),
    ...[...committed.keys()].filter((name) => !expected.has(name)).map((name) => `extra: dist/${name}`),
    ...[...expected].filter(([name, body]) => committed.has(name) && committed.get(name) !== body).map(([name]) => `stale: dist/${name}`),
  ];
  if (problems.length > 0) {
    console.error(`dist/ is out of date, run \`npm run build\`:\n${problems.join("\n")}`);
    process.exitCode = 1;
  }
} finally {
  await rm(fresh, { force: true, recursive: true });
}
