import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestUiContext, fauxAssistantMessage, getMessageText } from "@earendil-works/pi-coding-agent/testing";
import { expect, test } from "vitest";
import { CONFIRMATION, complete, GATE_ERROR, outcomes, SessionFixture, state, tool } from "./session-support.js";

/** Persist a decline through real input, then reopen its actual JSONL through a fresh factory. */
async function restoredConfirmation(fixture: SessionFixture, answer: "Re-propose now" | "Not yet" | undefined) {
  const original = await fixture.create({ sessionManager: SessionManager.create(fixture.root, fixture.sessions) });
  await original.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
  original.setResponses([complete("First"), fauxAssistantMessage("declined")]);
  await original.session.prompt("/plan start");
  await original.session.prompt("propose");
  await original.session.prompt("no");
  expect(state(original).declinedPlans).toBe(1);
  expect(state(original).reproposalReview).toBe("required");
  const file = original.sessionManager.getSessionFile();
  if (!file) throw new Error("Expected a file-backed decline");
  expect(existsSync(file)).toBe(true);
  original.cleanup();
  const harness = await fixture.create({ sessionManager: SessionManager.open(file) });
  const requests: Array<{ title: string; options: string[] }> = [];
  await harness.session.bindExtensions({
    mode: "rpc",
    uiContext: createTestUiContext({
      async select(title, options) {
        requests.push({ title, options: [...options] });
        if (title === "Proposed plan ready") return "Stay in Plan mode";
        return answer === undefined ? undefined : options.find((option) => option.includes(answer));
      },
    }),
  });
  expect(state(harness).reproposalReview).toBe("required");
  harness.setResponses([
    tool("plan_mode_question", CONFIRMATION),
    complete("Replacement"),
    ...(answer === "Re-propose now" ? [] : [fauxAssistantMessage("Blocked.")]),
  ]);
  await harness.session.prompt("ask before replacing");
  const questions = requests.filter((request) => request.title !== "Proposed plan ready");
  expect(questions).toHaveLength(1);
  expect(questions[0]?.options).toHaveLength(3);
  expect(questions[0]?.options[0]).toMatch(/^1\. Re-propose now/);
  expect(questions[0]?.options[1]).toMatch(/^2\. Not yet/);
  expect(harness.getPendingResponseCount()).toBe(0);
  return harness;
}

test("canonical affirmative permits one completion after restore", async () => {
  const fixture = new SessionFixture();
  try {
    const harness = await restoredConfirmation(fixture, "Re-propose now");
    const completions = outcomes(harness, "plan_mode_complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.isError).toBe(false);
    const questions = outcomes(harness, "plan_mode_question");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.isError).toBe(false);
    expect(JSON.stringify(questions[0]?.result)).toContain("reproposal_confirmation");
    expect(JSON.stringify(harness.events)).not.toContain(GATE_ERROR);
    expect(state(harness).declinedPlans).toBe(2);
    expect(state(harness).reproposalReview).toBe("required");
    // Permission is consumed: another unsolicited completion cannot reuse the affirmative answer.
    harness.setResponses([complete("Unauthorized"), fauxAssistantMessage("Blocked.")]);
    await harness.session.prompt("keep thinking");
    const next = outcomes(harness, "plan_mode_complete");
    expect(next).toHaveLength(2);
    expect(next[1]?.isError).toBe(true);
    expect(getMessageText(next[1]?.result)).toContain(GATE_ERROR);
  } finally {
    fixture.cleanup();
  }
});

for (const answer of ["Not yet", undefined] as const) {
  test(`nonaffirmative and cancellation preserve the restored gate (${answer ?? "cancelled"})`, async () => {
    const fixture = new SessionFixture();
    try {
      const harness = await restoredConfirmation(fixture, answer);
      const completions = outcomes(harness, "plan_mode_complete");
      expect(completions).toHaveLength(1);
      expect(completions[0]?.isError).toBe(true);
      expect(getMessageText(completions[0]?.result)).toContain(GATE_ERROR);
      expect(state(harness).reproposalReview).toBe("required");
    } finally {
      fixture.cleanup();
    }
  });
}
