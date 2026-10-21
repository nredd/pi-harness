import assert from "node:assert/strict";
import { test } from "vitest";
import { FINALIZE_PLAN_PROMPT } from "../src/finalization-request.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

/**
 * A pi whose `sendUserMessage` starts a run a little later, like core: the run's
 * `agent_start` fires after several awaits, and the session stays busy until `finish()`.
 */
function setup(mode: string | undefined, options: { startsRun?: boolean } = {}) {
  const mock = createMockPi({ activeTools: ["read"] });
  let busy = false;
  let finish: () => void = () => undefined;
  const idle = { waits: 0 };
  const context = createMockContext({
    mode,
    isIdle: () => !busy,
    waitForIdle: async () => {
      idle.waits += 1;
      if (!busy) return;
      await new Promise<void>((resolve) => {
        finish = () => {
          busy = false;
          resolve();
        };
      });
    },
  });
  const send = mock.rawPi.sendUserMessage.bind(mock.rawPi);
  mock.rawPi.sendUserMessage = (text, messageOptions) => {
    send(text, messageOptions);
    if (options.startsRun === false) return;
    setTimeout(() => {
      busy = true;
      for (const handler of mock.events.get("agent_start") ?? []) void handler({}, context.ctx);
    }, 5);
  };
  planMode(mock.pi, { headlessTurnStartTimeoutMs: 50 });
  const plan = (args: string) => mock.commands.get("plan")?.handler(args, context.ctx) as Promise<void>;
  return { mock, context, plan, idle, finish: () => finish() };
}

/** Resolves to whether `promise` settled within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

for (const mode of ["print", "json"]) {
  test(`${mode} mode: /plan finalize returns only after its finalize turn settles`, async () => {
    const { mock, plan, idle, finish } = setup(mode);
    await plan("start");
    const finalize = plan("finalize");

    assert.equal(await settlesWithin(finalize, 30), false, "returned while the finalize turn was still running");
    assert.equal(mock.sentUserMessages.at(-1)?.text, FINALIZE_PLAN_PROMPT);
    assert.equal(idle.waits, 1);

    finish();
    await finalize;
  });
}

test("headless: /plan <prompt> also waits for its turn", async () => {
  const { plan, finish } = setup("json");
  const prompt = plan("design it");
  assert.equal(await settlesWithin(prompt, 30), false);
  finish();
  await prompt;
});

test("headless: a sent message that never starts a run stops waiting after the start timeout", async () => {
  const { plan, idle } = setup("json", { startsRun: false });
  await plan("start");
  await plan("finalize");
  assert.equal(idle.waits, 0);
});

test("headless: commands that send nothing return at once", async () => {
  const { plan, idle } = setup("json");
  await plan("start");
  await plan("show");
  assert.equal(idle.waits, 0);
});

test("TUI and RPC: /plan finalize returns without waiting for the turn", async () => {
  for (const mode of ["tui", "rpc", undefined]) {
    const { plan, idle } = setup(mode);
    await plan("start");
    assert.equal(await settlesWithin(plan("finalize"), 30), true, `mode ${mode}`);
    assert.equal(idle.waits, 0);
  }
});
