import assert from "node:assert/strict";
import * as kit from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import { askPlanModeQuestions } from "../src/question-tool.js";
import { createMockContext } from "./harness/support.js";

vi.mock("@narumitw/pi-tui-kit", { spy: true });

const question = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  options: [{ label: "Small" }, { label: "Broad" }],
};

/** Treat Kit as an external adapter: malformed output must not become a domain answer. */
test("question adapter rejects incomplete, unknown, and inconsistent Kit answers", async () => {
  const context = createMockContext({ hasUI: true });
  const selected = { questionId: "0", answer: "Small", wasCustom: false, optionIndex: 1 };
  const cases = [
    { answers: [], error: /incomplete answer set/ },
    { answers: [{ ...selected, questionId: "99" }], error: /unknown question/ },
    { answers: [{ ...selected, wasCustom: true }], error: /custom answer with an option index/ },
    { answers: [{ ...selected, optionIndex: 9 }], error: /invalid selected option/ },
  ];
  try {
    for (const scenario of cases) {
      vi.spyOn(kit, "runQuestionnaire").mockResolvedValue({ kind: "submitted", answers: scenario.answers });
      await assert.rejects(askPlanModeQuestions([question], context.ctx), scenario.error);
      vi.restoreAllMocks();
    }
  } finally {
    vi.restoreAllMocks();
  }
});
