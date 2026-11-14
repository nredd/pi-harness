/** Real core-session fixtures for the retired process-level Plan scenarios. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness, type HarnessOptions } from "@earendil-works/pi-coding-agent/testing";
import { toolCall } from "@nredd/pi-test-lib/faux";
import planMode from "../src/plan-mode.js";
import type { PlanModeState } from "../src/state.js";

export const GATE_ERROR = "plan_mode_complete is blocked: explicit permission to submit a proposal is required";
export const QUESTION = {
  id: "scope",
  header: "Scope",
  question: "How wide?",
  options: [
    { label: "Narrow", description: "Smallest diff." },
    { label: "Wide", description: "Everything." },
  ],
};
export const CONFIRMATION = {
  mode: "reproposal_confirmation",
  questions: [
    {
      id: "confirm",
      header: "Confirm",
      question: "Submit the revised plan?",
      options: [
        { label: "ignored", description: "The canonical mode replaces this." },
        { label: "also ignored", description: "The canonical mode replaces this." },
      ],
    },
  ],
};

/** Invoke the production factory with explicit settings, never the owner's config. */
export const planFactory: ExtensionFactory = (pi) =>
  planMode(pi, {
    readSettings: async () => ({ kind: "missing" }),
  });

/** Scratch directory kept alive across file-backed session replacement. */
export class SessionFixture {
  readonly root = mkdtempSync(join(tmpdir(), "plan-session-"));
  readonly sessions = join(this.root, "sessions");
  private harnesses: Harness[] = [];

  /** Load the real factory; callers bind the actual host mode and UI. */
  async create(options: HarnessOptions = {}): Promise<Harness> {
    const harness = await createHarness({
      cwd: this.root,
      extensionFactories: [planFactory],
      settings: { retry: { enabled: false } },
      ...options,
    });
    this.harnesses.push(harness);
    return harness;
  }

  /** Dispose all sessions before deleting caller-owned session files. */
  cleanup(): void {
    for (const harness of this.harnesses.reverse()) harness.cleanup();
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** One distinct one-bullet proposal. */
export function complete(title: string) {
  return toolCall("plan_mode_complete", { plan: `# ${title}\n\n- Do the ${title} thing.\n` });
}

/** Latest persisted Plan state, not a mirrored fixture state machine. */
export function state(harness: Harness): PlanModeState {
  const entry = harness.sessionManager
    .getBranch()
    .slice()
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
  if (entry?.type !== "custom") throw new Error("No persisted Plan state");
  return entry.data as PlanModeState;
}
