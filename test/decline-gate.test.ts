import assert from "node:assert/strict";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { DECLINE_CONTRACT_MESSAGE_TYPE } from "../src/decline-contract.js";
import planMode from "../src/plan-mode.js";
import { restorePlanModeState } from "../src/state.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

const PLAN = "# Decline gate plan\n\n1. Do the thing.";
const QUESTION = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "How broad?",
      options: [
        { label: "Small", description: "Only the bug." },
        { label: "Broad", description: "Include cleanup." },
      ],
    },
  ],
};
const MISSING_SETTINGS = { readSettings: async () => ({ kind: "missing" as const }) };

type Execute = (...args: unknown[]) => Promise<{ details?: { cancelled?: boolean } }>;

interface Fixture {
  mock: ReturnType<typeof createMockPi>;
  ctx: ReturnType<typeof createMockContext>["ctx"];
  complete(): Promise<unknown>;
  ask(): Promise<{ details?: { cancelled?: boolean } }>;
  settle(): Promise<void>;
  input(text: string, source?: string): Promise<unknown>;
  state(): Record<string, unknown>;
  contract(): Promise<string | undefined>;
}

/** `readyChoice` picks what the TUI chooser does once a plan settles. */
async function fixture(readyChoice: "tui.select.cancel" | "stay" | "\u0003" = "stay"): Promise<Fixture> {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const questionTui = createTuiHarness({ width: 60, rows: 30 });
  let questionPending = false;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      if (questionPending) return questionTui.custom(factory as never);
      const harness = createCustomSelectorHarness(factory, 80);
      if (readyChoice === "stay") {
        for (let index = 0; index < 5; index += 1) harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
      } else harness.handleInput(readyChoice);
      return harness.resultPromise;
    },
  });
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const tool = (name: string) => mock.tools.find((candidate) => candidate.name === name)?.execute as Execute;
  return {
    mock,
    ctx: context.ctx,
    complete: () => tool("plan_mode_complete")("c", { plan: PLAN }, undefined, undefined, context.ctx),
    async ask() {
      questionPending = true;
      const running = tool("plan_mode_question")("q", QUESTION, undefined, undefined, context.ctx);
      await questionTui.waitForOpen();
      questionTui.setFocused(true);
      questionTui.press("tui.select.confirm");
      questionTui.press("tui.select.confirm");
      const result = await running;
      questionPending = false;
      return result;
    },
    async settle() {
      await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    },
    input: async (text, source = "interactive") => mock.events.get("input")?.[0]?.({ text, source }, context.ctx),
    state: () => mock.entries.at(-1)?.data as Record<string, unknown>,
    async contract() {
      const result = (await mock.events.get("context")?.[0]?.({ messages: [] }, context.ctx)) as {
        messages: Array<{ customType?: string; content?: string }>;
      };
      return result.messages.find((message) => message.customType === DECLINE_CONTRACT_MESSAGE_TYPE)?.content;
    },
  };
}

test("Stay and Escape on a ready plan count one decline and close the completion gate", async () => {
  for (const choice of ["stay", "tui.select.cancel"] as const) {
    const f = await fixture(choice);
    await f.complete();
    await f.settle();
    assert.equal(f.state().declinedPlans, 1, choice);
    assert.equal(f.state().declineGated, true, choice);
    assert.equal(f.state().enabled, true, choice);
    assert.equal(f.state().latestPlan, PLAN, choice);
  }
});

test("Ctrl+C closes the chooser without declining or discarding", async () => {
  const f = await fixture("\u0003");
  await f.complete();
  await f.settle();
  assert.equal(f.state().declinedPlans ?? 0, 0);
  assert.equal(f.state().declineGated ?? false, false);
  assert.equal(f.state().latestPlan, PLAN);
});

test("plan_mode_complete errors after a decline until a question is answered", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  await assert.rejects(f.complete(), /blocked.*declined/is);
  assert.equal(f.state().declineGated, true);

  const answered = await f.ask();
  assert.equal(answered.details?.cancelled, false);
  assert.equal(f.state().declineGated, false);
  assert.equal(f.state().declinedPlans, 1);
  await f.complete();
  assert.equal(f.state().latestPlan, PLAN);
});

test("a cancelled question does not lift the gate", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  const noUi = createMockContext({ mode: "rpc", hasUI: false });
  const ask = f.mock.tools.find((candidate) => candidate.name === "plan_mode_question")?.execute as Execute;
  const result = await ask("q", QUESTION, undefined, undefined, noUi.ctx);
  assert.equal(result.details?.cancelled, true);
  assert.equal(f.state().declineGated ?? true, true);
  await assert.rejects(f.complete(), /blocked/i);
});

test("/plan finalize lifts the gate without resetting the counter", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  await f.mock.commands.get("plan")?.handler("finalize", f.ctx);
  assert.equal(f.state().declineGated, false);
  assert.equal(f.state().declinedPlans, 1);
  await f.complete();
});

test("a reply while a plan awaits action counts once, even after Escape", async () => {
  const f = await fixture();
  await f.complete();
  await f.input("what about X?");
  assert.equal(f.state().declinedPlans, 1);
  assert.equal(f.state().declineGated, true);

  const stayed = await fixture("tui.select.cancel");
  await stayed.complete();
  await stayed.settle();
  await stayed.input("also Y");
  assert.equal(stayed.state().declinedPlans, 1);
});

test("extension prompts and replies without a ready plan do not decline", async () => {
  const f = await fixture();
  await f.input("early chat");
  await f.complete();
  await f.input("Finalize the current implementation plan now.", "extension");
  assert.equal(f.state().declinedPlans ?? 0, 0);
  assert.equal(f.state().declineGated ?? false, false);
});

test("a new proposal can be declined again and the counter accumulates", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  await f.ask();
  await f.mock.events.get("before_agent_start")?.[0]?.({ prompt: "p", systemPrompt: "s" }, f.ctx);
  await f.complete();
  await f.settle();
  assert.equal(f.state().declinedPlans, 2);
  assert.equal(f.state().declineGated, true);
});

test("the injected contract follows the decline count", async () => {
  const f = await fixture();
  assert.equal(await f.contract(), undefined);
  await f.complete();
  await f.settle();
  const once = await f.contract();
  assert.match(once ?? "", /PLAN DECLINED x1/);
  assert.match(once ?? "", /Restate what changed and what is still open/);
  assert.match(once ?? "", /Re-verify/);
  assert.match(once ?? "", /plan_mode_question tool at least once/);
  assert.match(once ?? "", /Never ask in assistant text/);
  assert.match(once ?? "", /ui_unavailable[\s\S]*\/plan finalize/);
  assert.doesNotMatch(once ?? "", /anything else before I re-propose/);

  await f.ask();
  await f.mock.events.get("before_agent_start")?.[0]?.({ prompt: "p", systemPrompt: "s" }, f.ctx);
  await f.complete();
  await f.settle();
  const twice = await f.contract();
  assert.match(twice ?? "", /PLAN DECLINED x2/);
  assert.match(twice ?? "", /resolved or open/);
  assert.match(twice ?? "", /plan_mode_question tool to ask "anything else before I re-propose/);
  assert.match(twice ?? "", /Never ask in assistant text/);
  assert.match(twice ?? "", /anything else before I re-propose\?/);
  assert.match(twice ?? "", /explicit go-ahead/);
});

test("exiting Plan mode resets the counter and gate for the next workflow", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  await f.mock.commands.get("plan")?.handler("exit", f.ctx);
  assert.equal(f.state().declinedPlans, 0);
  assert.equal(f.state().declineGated, false);
  await f.mock.commands.get("plan")?.handler("start", f.ctx);
  assert.equal(f.state().declinedPlans, 0);
  assert.equal(await f.contract(), undefined);
  await f.complete();
});

test("the decline state persists and restores with the rest of the Plan state", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  const restored = restorePlanModeState(
    [{ type: "custom", customType: "plan-mode-state", data: f.state() }],
    "plan-mode-state",
  );
  assert.equal(restored.declinedPlans, 1);
  assert.equal(restored.declineGated, true);
  assert.equal(restored.planDeclined, true);
  const disabled = restorePlanModeState(
    [{ type: "custom", customType: "plan-mode-state", data: { ...f.state(), enabled: false } }],
    "plan-mode-state",
  );
  assert.equal(disabled.declinedPlans, 0);
  assert.equal(disabled.declineGated, false);
});

test("the gate error names the tool and rejects plain-text answers", async () => {
  const f = await fixture();
  await f.complete();
  await f.settle();
  await assert.rejects(
    f.complete(),
    /plan_mode_question tool now[\s\S]*plain-text question or reply does not unblock[\s\S]*\/plan finalize/,
  );
});
