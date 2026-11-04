import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

test("registered tool schemas stay function-call compatible", async () => {
  const root = new URL("..", import.meta.url);
  const files = ["extensions/computer-use.ts"];

  // Every registered tool must have an object-typed root schema (function-call validators reject anyOf roots).
  const registered = [];
  const { default: register } = await import("../extensions/computer-use.ts");
  register({ registerTool: (tool) => registered.push(tool), registerCommand() {}, on() {} });
  for (const tool of registered) {
    if (tool.parameters?.type !== "object") throw new Error(`Tool ${tool.name} root schema is not type:object`);
  }
  if (registered.length < 11) throw new Error(`expected at least 11 tools, saw ${registered.length}`);
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
    throw new Error(`Tool schema compatibility checks failed:\n\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }

  console.log("Tool schema compatibility checks passed.");
});
