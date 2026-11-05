/** Real core sessions: the user edits a ready plan through the RPC editor dialog. */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestUiContext, fauxAssistantMessage, getUserTexts } from "@earendil-works/pi-coding-agent/testing";
import { expect, test } from "vitest";
import { formatTransferredPlanPrompt } from "../src/fresh-implementation.js";
import { PLAN_APPROVED_EVENT, type PlanApprovedPayload } from "../src/plan-approval.js";
import { PLAN_EDIT_MESSAGE_TYPE, PLAN_EDIT_SOURCE } from "../src/plan-edit.js";
import { PLAN_MESSAGE_TYPE } from "../src/presentation.js";
import { complete, deferred, planFactory, SessionFixture, state } from "./session-support.js";

const EDITED = "# First\n\n- Do the edited thing.";
const EDIT_MARKER = "[PLAN EDITED BY USER]";

function persistedStates(harness: { sessionManager: SessionManager }) {
  return harness.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === "plan-mode-state" ? [entry.data as ReturnType<typeof state>] : [],
    );
}

test("Edit then Implement here: kickoff, approval and one model-visible diff carry the edited plan", async () => {
  const fixture = new SessionFixture();
  const approvals: PlanApprovedPayload[] = [];
  const implemented = deferred<string>();
  try {
    const harness = await fixture.create({
      sessionManager: SessionManager.create(fixture.root, fixture.sessions),
      extensionFactories: [
        planFactory,
        (pi) => {
          pi.events.on(PLAN_APPROVED_EVENT, (payload) => approvals.push(payload as PlanApprovedPayload));
        },
      ],
    });
    const prefills: string[] = [];
    let readyMenus = 0;
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: createTestUiContext({
        async select(title) {
          if (!title.startsWith("Proposed plan ready")) return undefined;
          readyMenus += 1;
          return readyMenus === 1 ? "Edit plan…" : "Implement here";
        },
        async editor(_title, prefill) {
          prefills.push(prefill ?? "");
          return `\n${EDITED}\n`;
        },
      }),
    });
    harness.setResponses([
      complete("First"),
      (context) => {
        implemented.resolve(JSON.stringify(context.messages));
        return fauxAssistantMessage("Implemented.");
      },
    ]);
    await harness.session.prompt("/plan start");
    await harness.session.prompt("plan it");
    const modelContext = await implemented.promise;
    await harness.session.waitForIdle();

    expect(prefills).toEqual(["# First\n\n- Do the First thing."]);
    expect(readyMenus).toBe(2);
    expect(getUserTexts(harness).at(-1)).toBe(formatTransferredPlanPrompt(EDITED, false));
    expect(modelContext.split(EDIT_MARKER)).toHaveLength(2);
    expect(modelContext).toContain("-- Do the First thing.");
    expect(modelContext).toContain("+- Do the edited thing.");
    expect(approvals.map((approval) => approval.plan)).toEqual([EDITED]);

    const editMessages = harness.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === PLAN_EDIT_MESSAGE_TYPE);
    expect(editMessages).toHaveLength(1);
    const edited = persistedStates(harness).find((entry) => entry.latestPlanSource === PLAN_EDIT_SOURCE);
    expect(edited).toMatchObject({ enabled: true, awaitingAction: true, latestPlan: EDITED, declinedPlans: 0 });
    expect(edited?.reproposalReview).toBeUndefined();
    expect(state(harness).enabled).toBe(false);
    expect(harness.getPendingResponseCount()).toBe(0);
  } finally {
    implemented.resolve("");
    fixture.cleanup();
  }
});

test("An edited ready plan survives resume and /plan show displays it", async () => {
  const fixture = new SessionFixture();
  try {
    const original = await fixture.create({ sessionManager: SessionManager.create(fixture.root, fixture.sessions) });
    let readyMenus = 0;
    await original.session.bindExtensions({
      mode: "rpc",
      uiContext: createTestUiContext({
        async select(title) {
          if (!title.startsWith("Proposed plan ready")) return undefined;
          readyMenus += 1;
          return readyMenus === 1 ? "Edit plan…" : undefined;
        },
        editor: async () => EDITED,
      }),
    });
    original.setResponses([complete("First")]);
    await original.session.prompt("/plan start");
    await original.session.prompt("plan it");
    await original.session.waitForIdle();
    expect(readyMenus).toBe(2);
    expect(state(original)).toMatchObject({ latestPlan: EDITED, latestPlanSource: PLAN_EDIT_SOURCE });
    const file = original.sessionManager.getSessionFile();
    if (!file) throw new Error("Expected a file-backed session");
    original.cleanup();

    const resumed = await fixture.create({ sessionManager: SessionManager.open(file) });
    await resumed.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
    await resumed.session.prompt("/plan show");
    const shown = resumed.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom_message" && entry.customType === PLAN_MESSAGE_TYPE)
      .at(-1);
    expect(shown?.type === "custom_message" ? shown.details : undefined).toMatchObject({
      title: "Proposed Plan",
      plan: EDITED,
    });
  } finally {
    fixture.cleanup();
  }
});
