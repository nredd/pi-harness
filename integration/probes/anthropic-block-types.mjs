/**
 * Offline Anthropic classification probe. Pass one or more built pi-ai package roots.
 * No credentials, network, real signatures, or tool execution. This is synthetic
 * input, not a reconstruction of the original incident's unavailable wire trace.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("Usage: node probes/anthropic-block-types.mjs <built-pi-ai-root> [...]");
  process.exitCode = 2;
}
for (const root of roots) {
  const { stream } = await import(pathToFileURL(resolve(root, "dist/api/anthropic-messages.js")).href);
  const { getModel, normalizeContext } = await import(pathToFileURL(resolve(root, "dist/compat.js")).href);
  for (const secondType of ["text", "thinking"]) {
    const events = [];
    const add = (type, fields = {}) => events.push({ type, ...fields });
    add("message_start", {
      message: { id: "msg_probe", usage: { input_tokens: 1, output_tokens: 0 } },
    });
    for (const [index, type, content] of [
      [0, "thinking", "Private planning."],
      [1, secondType, "I will leave those packages untouched."],
    ]) {
      add("content_block_start", {
        index,
        content_block: type === "text" ? { type, text: "" } : { type, thinking: "", signature: "" },
      });
      add("content_block_delta", {
        index,
        delta: type === "text" ? { type: "text_delta", text: content } : { type: "thinking_delta", thinking: content },
      });
      if (type === "thinking") {
        add("content_block_delta", {
          index, delta: { type: "signature_delta", signature: "synthetic-test-signature" },
        });
      }
      add("content_block_stop", { index });
    }
    add("content_block_start", {
      index: 2, content_block: { type: "tool_use", id: "tool_probe", name: "noop", input: {} },
    });
    add("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{}" } });
    add("content_block_stop", { index: 2 });
    add("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } });
    add("message_stop");
    const response = new Response(
      events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const client = { beta: { messages: { create: () => ({ asResponse: async () => response }) } } };
    const providerTypes = [];
    const result = await stream(
      getModel("anthropic", "claude-haiku-4-5"),
      normalizeContext({ messages: [{ role: "user", content: "Report progress before the tool.", timestamp: 1 }] }),
      {
        client,
        onProviderStreamEvent: event => {
          if (event.type === "content_block_start") providerTypes.push(event.content_block.type);
        },
      },
    ).result();
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    assert.deepEqual(providerTypes, ["thinking", secondType, "tool_use"]);
    assert.deepEqual(result.content.map(b => b.type), ["thinking", secondType, "toolCall"]);
    assert.equal(result.content[1][secondType === "text" ? "text" : "thinking"], "I will leave those packages untouched.");
    console.log(`${resolve(root)}: wire ${secondType} -> normalized ${result.content[1].type}: PASS`);
  }
}
