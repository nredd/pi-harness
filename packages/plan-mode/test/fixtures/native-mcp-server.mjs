import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Deterministic stdio MCP fixture: no network, credentials, or workspace access.
const names = ["direct", "callable", "deferred", "cd_deferred", "unselected", "hidden"];
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "plan-policy-fixture", version: "1" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = {
        tools: names.map((name) => ({
          name,
          description: `Constant result for ${name}`,
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        })),
      };
      break;
    case "tools/call":
      appendFileSync(process.argv[2], `${request.params.name}\n`);
      result = { content: [{ type: "text", text: `fixture:${request.params.name}` }] };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })}\n`,
      );
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
