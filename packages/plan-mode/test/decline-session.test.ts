import { fauxAssistantMessage, getMessageText } from "@earendil-works/pi-coding-agent/testing";
import { expect, test } from "vitest";
import { complete, deferred, GATE_ERROR, outcomes, QUESTION, SessionFixture, state, tool } from "./session-support.js";

test("ready-plan reply blocks completion with actionable headless guidance", async () => {
  const fixture = new SessionFixture();
  try {
    const harness = await fixture.create();
    // Supplying a UI, even in print mode, deliberately makes core's hasUI true.
    await harness.session.bindExtensions({ mode: "print" });
    harness.setResponses([
      complete("First"),
      complete("First"),
      fauxAssistantMessage("Restating the open threads."),
      tool("plan_mode_question", { questions: [QUESTION] }),
      complete("Second"),
      fauxAssistantMessage("OK"),
    ]);
    await harness.session.prompt("/plan start");
    await harness.session.prompt("plan it");
    await harness.session.prompt("no, change the scope");
    await harness.session.prompt("ask me first");
    const completions = outcomes(harness, "plan_mode_complete");
    expect(completions.map((outcome) => outcome.isError)).toEqual([false, true, true]);
    expect(getMessageText(completions[0]?.result)).toContain("**Proposed Plan**");
    const blocked = getMessageText(completions[1]?.result);
    for (const needle of [
      GATE_ERROR,
      "reproposal_confirmation mode",
      "canonical Re-propose now choice",
      "plain-text replies do not unblock",
      "/plan finalize",
      "ui_unavailable",
    ]) {
      expect(blocked).toContain(needle);
    }
    const questions = outcomes(harness, "plan_mode_question");
    expect(questions).toHaveLength(1);
    expect(getMessageText(questions[0]?.result)).toContain('"reason": "ui_unavailable"');
    expect(getMessageText(completions[2]?.result)).toContain(GATE_ERROR);
    expect(harness.getPendingResponseCount()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

test("finalize awaits its headless completion turn", async () => {
  const fixture = new SessionFixture();
  const release = deferred<void>();
  try {
    const harness = await fixture.create();
    const unsupported = async (): Promise<never> => {
      throw new Error("Unused host action");
    };
    await harness.session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => harness.session.waitForIdle(),
        newSession: unsupported,
        fork: unsupported,
        navigateTree: unsupported,
        switchSession: unsupported,
        reload: () => harness.session.reload(),
      },
    });
    harness.setResponses([complete("First"), complete("First"), fauxAssistantMessage("Restating the open threads.")]);
    await harness.session.prompt("/plan start");
    await harness.session.prompt("plan it");
    await harness.session.prompt("no, change the scope");
    expect(getMessageText(outcomes(harness, "plan_mode_complete")[1]?.result)).toContain(GATE_ERROR);
    const entered = deferred<void>();
    harness.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return complete("Final");
      },
    ]);
    let returned = false;
    const finalize = harness.session.prompt("/plan finalize").then(() => {
      returned = true;
    });
    await entered.promise;
    expect(returned).toBe(false);
    release.resolve();
    await finalize;
    const completions = outcomes(harness, "plan_mode_complete");
    expect(completions).toHaveLength(3);
    expect(completions[2]?.isError).toBe(false);
    expect(getMessageText(completions[2]?.result)).toContain("# Final");
    expect(state(harness).latestPlan).toContain("# Final");
    expect(harness.getPendingResponseCount()).toBe(0);
  } finally {
    release.resolve();
    fixture.cleanup();
  }
});
