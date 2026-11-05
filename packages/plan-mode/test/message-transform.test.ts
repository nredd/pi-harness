import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractProposedPlan,
  findHistoryImplementationArtifact,
  latestAssistantStopReason,
  latestAssistantText,
  PLAN_HISTORY_IMPLEMENTATION_PROMPT,
  parseProposedPlan,
  stripPlanModeCompletionCallsFromMessage,
  stripProposedPlanBlocksFromMessage,
} from "../src/message-transform.js";
import { PLAN_MESSAGE_TYPE } from "../src/presentation.js";

const kickoff = { role: "user", content: PLAN_HISTORY_IMPLEMENTATION_PROMPT };
const completionCall = (id: string) => ({ type: "toolCall", id, name: "plan_mode_complete", arguments: {} });

test("a lone closing plan tag is malformed, not absent", () => {
  assert.deepEqual(parseProposedPlan("text\n</proposed_plan>"), { kind: "malformed" });
  assert.equal(extractProposedPlan("text\n</proposed_plan>"), undefined);
  assert.equal(extractProposedPlan("<proposed_plan>\n# Plan\n</proposed_plan>"), "# Plan");
});

test("assistant readers tolerate non-array transcripts and content-less messages", () => {
  assert.equal(latestAssistantText(undefined), "");
  assert.equal(latestAssistantText([{ role: "assistant" }]), "");
  assert.equal(latestAssistantStopReason({ role: "assistant", stopReason: "stop" }), undefined);
  assert.equal(latestAssistantStopReason([{ message: { role: "assistant", stopReason: "aborted" } }]), "aborted");
});

test("a completion result is paired with its call across unrelated assistant messages", () => {
  const messages = [
    { role: "assistant", content: [completionCall("call-1")] },
    { role: "assistant", content: "Thinking it over." },
    { role: "assistant", content: [completionCall("call-other")] },
    { role: "toolResult", toolName: "plan_mode_complete", toolCallId: "call-1" },
    kickoff,
  ];
  assert.deepEqual(findHistoryImplementationArtifact(messages), {
    messageIndex: 3,
    kind: "completion",
    toolCallId: "call-1",
    toolCallMessageIndex: 0,
  });
});

test("a completion result without a call id is skipped for an earlier presentation", () => {
  const messages = [
    { role: "custom", customType: PLAN_MESSAGE_TYPE, content: "# Plan" },
    { role: "toolResult", toolName: "plan_mode_complete" },
    kickoff,
  ];
  assert.deepEqual(findHistoryImplementationArtifact(messages), { messageIndex: 0, kind: "presentation" });
});

test("stripping completion calls leaves string assistant content untouched", () => {
  const message = { role: "assistant", content: "plain text" };
  assert.equal(stripPlanModeCompletionCallsFromMessage(message), message);
});

test("stripping plan blocks leaves non-text assistant content untouched", () => {
  const message = { role: "assistant", content: { kind: "opaque" } };
  assert.equal(stripProposedPlanBlocksFromMessage(message), message);
});
