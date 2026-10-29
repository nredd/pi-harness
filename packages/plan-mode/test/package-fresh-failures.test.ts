import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { startFreshImplementationFromState, startFreshImplementationSession } from "../src/fresh-implementation.js";
import { createMockContext } from "./harness/support.js";

const request = {
  plan: "# Approved",
  source: "plan_mode_complete" as const,
  retention: "keep" as const,
  stateEntryType: "state",
  isCurrent: () => true,
};

function fixture(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    mode: "rpc",
    hasUI: true,
    model: { provider: "test", id: "plan" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    sessionManager: { getSessionFile: () => undefined },
    newSession: async () => ({ cancelled: false }),
    ...overrides,
  });
}

test("fresh replacement refuses print and JSON hosts", async () => {
  for (const mode of ["print", "json"]) {
    const context = fixture({ mode, newSession: async () => assert.fail("must not replace headless session") });
    await assert.rejects(startFreshImplementationSession(context.ctx, request), /unavailable in print\/JSON mode/);
  }
});

test("fresh state rejects missing plans before replacing a session", async () => {
  const context = fixture({ newSession: async () => assert.fail("must retain the current session") });
  assert.deepEqual(
    await startFreshImplementationFromState(context.ctx, {
      getState: () => ({ enabled: true, awaitingAction: false }),
      menuIsCurrent: () => true,
      retention: "keep",
      stateEntryType: "state",
    }),
    { kind: "rejected" },
  );
  assert.match(context.notifications.at(-1)?.message ?? "", /No completed plan/);
});

test("fresh preflight becomes stale while waiting for idle and handles registry failures", async () => {
  let current = true;
  const context = fixture({
    waitForIdle: async () => {
      current = false;
    },
  });
  assert.deepEqual(await startFreshImplementationSession(context.ctx, { ...request, isCurrent: () => current }), {
    kind: "stale",
  });
  let replacements = 0;
  const failing = fixture({
    modelRegistry: {
      find: () => {
        throw new Error("registry unavailable");
      },
    },
    newSession: async () => {
      replacements++;
      return { cancelled: false };
    },
  });
  assert.deepEqual(
    await startFreshImplementationSession(failing.ctx, {
      ...request,
      runtime: { model: { provider: "other", modelId: "target" } },
    }),
    { kind: "rejected" },
  );
  assert.match(failing.notifications.at(-1)?.message ?? "", /registry unavailable/);
  const unauthenticated = fixture({
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw new Error("auth offline");
      },
    },
  });
  assert.deepEqual(await startFreshImplementationSession(unauthenticated.ctx, request), { kind: "rejected" });
  assert.match(unauthenticated.notifications.at(-1)?.message ?? "", /auth offline/);
  assert.equal(replacements, 0);
});

test("fresh replacement errors and cancellation preserve the source plan", async () => {
  for (const cancelled of [false, true]) {
    const context = fixture({
      newSession: async () => {
        if (!cancelled) throw new Error("replacement failed");
        return { cancelled: true };
      },
    });
    assert.deepEqual(await startFreshImplementationSession(context.ctx, request), {
      kind: cancelled ? "cancelled" : "rejected",
    });
    assert.match(
      context.notifications.at(-1)?.message ?? "",
      cancelled ? /cancelled.*plan remains/ : /replacement failed.*source plan remains/,
    );
  }
});

test("fresh setup persistence failure offers editor recovery without submitting a prompt", async () => {
  const replacement = fixture();
  let submissions = 0;
  const context = fixture({
    newSession: async (options: NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>) => {
      await options.setup?.({
        appendCustomMessageEntry() {
          throw new Error("destination disk full");
        },
      } as never);
      await options.withSession?.({
        ui: (replacement.ctx as ExtensionCommandContext).ui,
        sendUserMessage: async () => {
          submissions++;
        },
      } as never);
      return { cancelled: false };
    },
  });
  assert.deepEqual(await startFreshImplementationSession(context.ctx, request), { kind: "partial" });
  assert.equal(submissions, 0);
  assert.match(replacement.editorText, /# Approved/);
  assert.match(replacement.notifications.at(-1)?.message ?? "", /destination disk full.*request is in the editor/);
});
