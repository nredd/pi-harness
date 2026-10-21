#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url);
const files = ["extensions/computer-use.ts"];

// Every registered tool must have an object-typed root schema (function-call validators reject anyOf roots).
const registered = [];
const { default: register } = await import("../extensions/computer-use.ts");
register({ registerTool: (tool) => registered.push(tool), registerCommand() {}, on() {} });
for (const tool of registered) {
  if (tool.parameters?.type !== "object") { console.error(`Tool ${tool.name} root schema is not type:object`); process.exit(1); }
}
if (registered.length < 11) { console.error(`expected at least 11 tools, saw ${registered.length}`); process.exit(1); }
const failures = [];

for (const file of files) {
  const path = join(root.pathname, file);
  const source = readFileSync(path, "utf8");

  const checks = [
    {
      name: "Type.Tuple",
      pattern: /Type\.Tuple\s*\(/,
      message: "Type.Tuple emits array-form JSON Schema items, which some function-call validators reject.",
    },
    {
      name: "array-form items",
      pattern: /\bitems\s*:\s*\[/,
      message: "JSON Schema items must be an object or boolean for function-call compatibility.",
    },
    {
      name: "prefixItems",
      pattern: /\bprefixItems\b/,
      message: "Tuple-style prefixItems is not accepted by all function-call schema validators.",
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(source)) {
      failures.push(`${file}: ${check.name}: ${check.message}`);
    }
  }
}

if (failures.length) {
  console.error("Tool schema compatibility checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Tool schema compatibility checks passed.");
