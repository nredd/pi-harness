import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createChildToolPolicy } from "../src/child-policy.js";
import planMode from "../src/plan-mode.js";
import * as toolPolicy from "../src/tool-policy.js";
import { builtinTool, createPlanContext, createPlanPi } from "./support.js";

// Every decision still comes from the real `decideBlockedCommand`; only the lazy explainer is
// replaced by one that throws, to prove the message path can never turn a block into a throw or an allow.
const explainerFailure = vi.hoisted(() => ({ armed: false }));
vi.mock("../src/tool-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tool-policy.js")>();
  return {
    ...actual,
    decideBlockedCommand: (...args: Parameters<typeof actual.decideBlockedCommand>) => {
      const decision = actual.decideBlockedCommand(...args);
      if (!explainerFailure.armed || decision === undefined) return decision;
      return {
        ...decision,
        explain: () => {
          throw new TypeError("explainer exploded");
        },
      };
    },
  };
});

afterEach(() => {
  explainerFailure.armed = false;
});

const GENERIC = (segment: string) =>
  `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${segment}\nOffending token: ${segment} (outside the reviewed inspection policy)`;

const BLOCKED = ["ls; rm -rf x", "ls | python3 \\ ; ls", "cat f | sh \\ | cat", "cat x > f", "echo 'oops"];
const settings = { safeSubcommands: {}, trustedDirectories: [] };

test("a throwing explainer still blocks through the child policy, with the generic message", () => {
  explainerFailure.armed = true;
  const evaluate = createChildToolPolicy({ selected: new Map(), settings, homeDir: "/home/user" });
  const tool = builtinTool("bash") as ToolInfo;
  const segments = ["rm -rf x", "python3 \\", "sh \\", "cat x > f", "echo 'oops"];
  for (const [index, command] of BLOCKED.entries()) {
    const reason = evaluate({ toolName: "bash", input: { command }, cwd: "/repo", tool });
    assert.equal(reason, GENERIC(command === "echo 'oops" ? command : (segments[index] as string)), command);
  }
  assert.equal(evaluate({ toolName: "bash", input: { command: "git status" }, cwd: "/repo", tool }), undefined);
});

test("a throwing explainer still blocks in the main session's tool_call gate", async () => {
  explainerFailure.armed = true;
  const mock = createPlanPi({
    activeTools: ["read", "bash"],
    allTools: [builtinTool("read"), builtinTool("bash")],
  });
  planMode(mock.pi);
  const context = createPlanContext();
  await mock.handlers.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const hook = mock.handlers.get("tool_call")?.[0];
  for (const command of BLOCKED) {
    const result = (await hook?.({ toolName: "bash", input: { command } }, context.ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /Offending token: .* \(outside the reviewed inspection policy\)/, command);
  }
  assert.equal(await hook?.({ toolName: "bash", input: { command: "git status" } }, context.ctx), undefined);
});

test("the decision never consults the explainer; explainDecision degrades to the generic reason", () => {
  assert.equal(toolPolicy.isSafeCommand("ls | wc -l"), true);
  assert.equal(toolPolicy.isSafeCommand("ls | python3 \\ ; ls"), false);
  assert.equal(toolPolicy.findBlockedCommandSegment("cat f | sh \\ | cat"), "sh \\");
  const throwing = {
    segment: "rm x",
    explain: () => {
      throw new TypeError("explainer exploded");
    },
  };
  assert.deepEqual(toolPolicy.explainDecision(throwing), {
    token: "rm x",
    reason: "outside the reviewed inspection policy",
  });
});
