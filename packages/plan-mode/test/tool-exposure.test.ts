import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { classifyPlanModeTool } from "../src/tool-policy.js";
import {
  defaultPlanModeToolNames,
  filterAvailableSelectedToolNames,
  planModeToolSelection,
} from "../src/tool-selection.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";
import { nativeTool } from "./tool-exposure-support.js";

type Decision = { block?: boolean; reason?: string } | undefined;

async function fixture(tools: ToolInfo[], activeTools: string[], selected?: string[]) {
  const mock = createMockPi({ allTools: tools, activeTools });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, ...(selected ? { defaultPlanTools: selected } : {}) },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const resolve = () => mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx);
  const call = async (name: string, nested = false, input: unknown = {}): Promise<Decision> =>
    (await mock.events.get("tool_call")?.[0]?.(
      { toolName: name, input, ...(nested ? { parentToolCallId: "outer" } : {}) },
      context.ctx,
    )) as Decision;
  const close = () => mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, context.ctx);
  return { mock, context, resolve, call, close };
}

test("native extension registrations require opt-in without becoming blocked core tools", () => {
  for (const tool of [
    nativeTool("mcp__docs__read", "direct"),
    nativeTool("codemode", "model-only", "codemode"),
    nativeTool("tool_search", "model-only", "tool_search"),
    nativeTool("read_mcp_resource", "codemode"),
    nativeTool("research", "deferred", "research-owner"),
    nativeTool("read", "direct", "read-override"),
  ]) {
    assert.equal(classifyPlanModeTool(tool), "user-opt-in", tool.name);
    assert.deepEqual(defaultPlanModeToolNames([tool], undefined), [], tool.name);
  }
  for (const tool of [builtinTool("danger"), nativeTool("danger", "direct", "danger")]) {
    assert.equal(classifyPlanModeTool(tool as ToolInfo), "blocked");
  }
  assert.equal(classifyPlanModeTool(builtinTool("read") as ToolInfo), "read-only");
});

const cases = [
  ["direct", false, false, false],
  ["direct", false, true, false],
  ["direct", true, false, true],
  ["direct", true, true, true],
  ["model-only", false, false, false],
  ["model-only", false, true, false],
  ["model-only", true, false, true],
  ["model-only", true, true, false],
  ["codemode", false, false, false],
  ["codemode", false, true, true],
  ["codemode", true, false, true],
  ["codemode", true, true, true],
  ["deferred", false, false, false],
  ["deferred", false, true, true],
  ["deferred", true, false, true],
  ["deferred", true, true, true],
  ["hidden", false, false, false],
  ["hidden", false, true, false],
  ["hidden", true, false, false],
  ["hidden", true, true, false],
  [undefined, false, false, false],
  [undefined, false, true, false],
  [undefined, true, false, true],
  [undefined, true, true, true],
  ["unknown", true, false, false],
  ["unknown", true, true, false],
] as const;

for (const [exposure, active, nested, allowed] of cases) {
  test(`exposure ${exposure ?? "legacy"}: active=${active}, nested=${nested}`, async () => {
    const name = "research";
    const tool = { ...extensionTool(name), ...(exposure === undefined ? {} : { exposure }) } as ToolInfo;
    const f = await fixture([tool], active ? [name] : [], [name]);
    try {
      const selectable =
        exposure === "codemode" ||
        exposure === "deferred" ||
        (active && exposure !== "hidden" && exposure !== "unknown");
      assert.equal(!planModeToolSelection(tool, new Set(active ? [name] : []), true).disabled, selectable);
      assert.deepEqual(
        filterAvailableSelectedToolNames([name], [tool], new Set(active ? [name] : [])),
        selectable ? [name] : [],
      );
      await f.resolve();
      const result = await f.call(name, nested);
      assert.equal(result?.block !== true, allowed, result?.reason ?? "unexpected exposure decision");
    } finally {
      await f.close();
    }
  });
}

test("native MCP and orchestration require separate opt-in; annotations do not grant permission", async () => {
  const tools = [nativeTool("codemode", "model-only", "codemode"), nativeTool("mcp__docs__read", "codemode")];
  tools[1].annotations = { readOnlyHint: true, destructiveHint: false };
  for (const selected of [undefined, ["codemode"], ["mcp__docs__read"], ["codemode", "mcp__docs__read"]]) {
    const f = await fixture(tools, ["codemode"], selected);
    try {
      const active = f.mock.rawPi.getActiveTools();
      await f.resolve();
      assert.equal((await f.call("codemode"))?.block !== true, selected?.includes("codemode") === true);
      assert.equal(
        (await f.call("mcp__docs__read", true))?.block !== true,
        selected?.includes("mcp__docs__read") === true,
      );
      assert.deepEqual(f.mock.rawPi.getActiveTools(), active);
    } finally {
      await f.close();
    }
  }
});

test("callable admissions survive declaration and restoration but hidden calls fail closed", async () => {
  const tool = nativeTool("mcp__docs__read", "deferred");
  const f = await fixture([tool], [], [tool.name]);
  try {
    await f.resolve();
    assert.equal(await f.call(tool.name, true), undefined);
    f.mock.rawPi.setActiveTools([...f.mock.rawPi.getActiveTools(), tool.name]);
    assert.equal(await f.call(tool.name), undefined);
    const branch = f.mock.entries.map((entry) => ({ type: "custom", ...entry }));
    const restored = createMockContext({ sessionManager: { getBranch: () => branch, getEntries: () => branch } });
    await f.mock.events.get("session_start")?.[0]?.({ reason: "resume" }, restored.ctx);
    await f.mock.events.get("context")?.[0]?.({ messages: [] }, restored.ctx);
    const invoke = () =>
      f.mock.events.get("tool_call")?.[0]?.(
        { toolName: tool.name, input: {}, parentToolCallId: "outer" },
        restored.ctx,
      ) as Promise<Decision>;
    assert.equal(await invoke(), undefined);
    tool.exposure = "hidden";
    assert.match((await invoke())?.reason ?? "", /hidden/i);
    tool.exposure = "deferred";
    assert.equal(await invoke(), undefined);
  } finally {
    await f.close();
  }
});

test("late callable registration resolves before first context only, including after restoration", async () => {
  for (const late of [false, true]) {
    const tools: ToolInfo[] = [];
    const name = "mcp__docs__read";
    const f = await fixture(tools, [], [name]);
    try {
      if (late) await f.resolve();
      tools.push(nativeTool(name, "codemode"));
      await f.resolve();
      assert.equal((await f.call(name, true))?.block !== true, !late);
      const branch = f.mock.entries.map((entry) => ({ type: "custom", ...entry }));
      const restored = createMockContext({ sessionManager: { getBranch: () => branch, getEntries: () => branch } });
      await f.mock.events.get("session_start")?.[0]?.({ reason: "resume" }, restored.ctx);
      await f.mock.events.get("context")?.[0]?.({ messages: [] }, restored.ctx);
      const result = (await f.mock.events.get("tool_call")?.[0]?.(
        { toolName: name, input: {}, parentToolCallId: "outer" },
        restored.ctx,
      )) as Decision;
      assert.equal(result?.block !== true, !late);
      await f.mock.commands.get("plan")?.handler("exit", restored.ctx);
      await f.mock.commands.get("plan")?.handler("start", restored.ctx);
      await f.mock.events.get("context")?.[0]?.({ messages: [] }, restored.ctx);
      assert.equal(
        await f.mock.events.get("tool_call")?.[0]?.(
          { toolName: name, input: {}, parentToolCallId: "outer" },
          restored.ctx,
        ),
        undefined,
      );
    } finally {
      await f.close();
    }
  }
});

test("unavailable source metadata is denied without throwing or granting automatic permission", async () => {
  const name = "research";
  for (const tool of [{ name }, { name, sourceInfo: {} }]) {
    const f = await fixture([tool as ToolInfo], [name], [name]);
    try {
      await f.resolve();
      assert.deepEqual(defaultPlanModeToolNames([tool as ToolInfo], undefined), []);
      assert.equal(planModeToolSelection(tool as ToolInfo, new Set([name]), true).disabled, true);
      assert.match((await f.call(name, true))?.reason ?? "", /metadata is unavailable/);
    } finally {
      await f.close();
    }
  }
});

test("hidden-to-callable exposure only joins policy before the first context", async () => {
  for (const late of [false, true]) {
    const tool = nativeTool("mcp__docs__read", "hidden");
    const f = await fixture([tool], [], [tool.name]);
    try {
      if (late) await f.resolve();
      tool.exposure = "codemode";
      await f.resolve();
      assert.equal((await f.call(tool.name, true))?.block !== true, !late);
      if (late) assert.match((await f.call(tool.name, true))?.reason ?? "", /froze its tool policy/);
    } finally {
      await f.close();
    }
  }
});

test("withdrawn callable registrations fail closed even with stale active declarations", async () => {
  const tool = nativeTool("mcp__docs__read", "deferred");
  const tools = [tool];
  const f = await fixture(tools, [tool.name], [tool.name]);
  try {
    await f.resolve();
    assert.equal(await f.call(tool.name, true), undefined);
    tools.pop();
    assert.match((await f.call(tool.name, true))?.reason ?? "", /metadata is unavailable/);
  } finally {
    await f.close();
  }
});

test("nested calls retain mutation and limited-shell checks", async () => {
  const names = ["edit", "write", "update_plan", "bash", "powershell"];
  const f = await fixture(
    names.map((name) => ({ ...extensionTool(name), exposure: "codemode" }) as ToolInfo),
    [],
    names,
  );
  try {
    await f.resolve();
    for (const name of ["edit", "write", "update_plan"]) assert.equal((await f.call(name, true))?.block, true);
    assert.equal(await f.call("bash", true, { command: "git status --short" }), undefined);
    assert.equal((await f.call("bash", true, { command: "touch file" }))?.block, true);
    assert.equal(await f.call("powershell", true, { command: "Get-Location" }), undefined);
    assert.equal((await f.call("powershell", true, { command: "Remove-Item file" }))?.block, true);
  } finally {
    await f.close();
  }
});
