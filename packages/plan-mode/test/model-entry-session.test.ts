import {
  createTestUiContext,
  fauxAssistantMessage,
  fauxToolCall,
  getMessageText,
} from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { settled, toolCall } from "@nredd/pi-test-lib/faux";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { MODE_CONTRACT_MESSAGE_TYPE } from "../src/mode-contract.js";
import { planFactory, SessionFixture, state } from "./session-support.js";

for (const mode of ["tui", "rpc"] as const) {
  test(`model entry confirms in ${mode}, terminates, and plans only after settlement`, async () => {
    const fixture = new SessionFixture();
    try {
      const harness = await fixture.create();
      const confirms: string[] = [];
      await harness.session.bindExtensions({
        mode,
        uiContext: createTestUiContext({
          async confirm(title, message) {
            confirms.push(`${title} ${message}`);
            return true;
          },
        }),
      });
      const planned = deferred<void>();
      let planningContext = "";
      harness.setResponses([
        toolCall("plan_mode_enter", { reason: "Multi-file migration" }),
        (context) => {
          planningContext = JSON.stringify(context.messages);
          planned.resolve();
          return fauxAssistantMessage("Planning only.");
        },
      ]);
      const tools = harness.session.getActiveToolNames();
      await harness.session.prompt("Original migration request");
      await planned.promise;
      await harness.session.waitForIdle();
      expect(planningContext).toContain("Original migration request");
      expect(
        harness.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "custom_message" && entry.customType === MODE_CONTRACT_MESSAGE_TYPE),
      ).toHaveLength(1);
      expect(confirms).toEqual(["Enter Plan mode? Plan mode requested: Multi-file migration"]);
      expect(harness.session.getActiveToolNames()).toEqual(tools);
      expect(settled(harness, "plan_mode_enter")[0]?.result.terminate).toBe(true);
      expect(state(harness).enabled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
}

test("declining entry continues Normal without a contract or state mutation", async () => {
  const fixture = new SessionFixture();
  try {
    const harness = await fixture.create();
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: createTestUiContext({ confirm: async () => false }),
    });
    harness.setResponses([
      toolCall("plan_mode_enter", { reason: "Scope" }),
      fauxAssistantMessage("Continue normally."),
    ]);
    await harness.session.prompt("Do work");
    expect(getMessageText(settled(harness, "plan_mode_enter")[0]?.result)).toContain("declined");
    expect(harness.getPendingResponseCount()).toBe(0);
    expect(
      harness.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === MODE_CONTRACT_MESSAGE_TYPE),
    ).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} refuses entry before confirmation or mutation`, async () => {
    const fixture = new SessionFixture();
    try {
      const harness = await fixture.create();
      await harness.session.bindExtensions({
        mode,
        uiContext: createTestUiContext({
          confirm: async () => {
            throw new Error("Unexpected dialog");
          },
        }),
      });
      harness.setResponses([toolCall("plan_mode_enter", { reason: "Scope" }), fauxAssistantMessage("No entry.")]);
      await harness.session.prompt("Do work");
      expect(getMessageText(settled(harness, "plan_mode_enter")[0]?.result)).toContain("unsupported");
      expect(
        harness.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === "plan-mode-state"),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
}

test("a real abort at before-settle prevents confirmed entry after the final assistant", async () => {
  const fixture = new SessionFixture();
  try {
    let abortedAtBoundary = false;
    const settlements: boolean[] = [];
    const harness = await fixture.create({
      extensionFactories: [
        planFactory,
        (pi) => {
          pi.on("agent_before_settle", () => {
            if (!abortedAtBoundary) {
              abortedAtBoundary = true;
              void harness.session.abort();
            }
          });
          pi.on("agent_settled", (event) => {
            settlements.push(event.aborted);
          });
        },
      ],
    });
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: createTestUiContext({ confirm: async () => true }),
    });
    harness.setResponses([
      toolCall("plan_mode_enter", { reason: "Scope" }),
      fauxAssistantMessage("Unauthorized stale planning."),
    ]);
    const tools = harness.session.getActiveToolNames();
    await harness.session.prompt("Original migration request");
    expect(settlements).toContain(true);
    expect(
      harness.session.messages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
    ).not.toContain("aborted");
    expect(
      harness.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom_message" && entry.customType === MODE_CONTRACT_MESSAGE_TYPE),
    ).toBe(false);
    expect(harness.session.getActiveToolNames()).toEqual(tools);
    expect(harness.getPendingResponseCount()).toBe(1);
  } finally {
    fixture.cleanup();
  }
});

for (const queue of ["followUp", "steer"] as const) {
  test(`real ${queue} drains a superseding request before settlement without a new agent start`, async () => {
    const fixture = new SessionFixture();
    try {
      const trace: string[] = [];
      const harness = await fixture.create({
        extensionFactories: [
          planFactory,
          (pi) => {
            pi.on("before_agent_start", () => {
              trace.push("before_agent_start");
            });
            pi.on("tool_result", async (event) => {
              if (event.toolName === "plan_mode_enter") {
                trace.push("entry confirmed");
                await harness.session[queue]("Instead, inspect the tests");
              }
            });
            pi.on("input", (event) => {
              trace.push(`input:${event.text}`);
            });
            pi.on("message_start", (event) => {
              if (event.message.role === "user") trace.push(`user:${getMessageText(event.message)}`);
            });
            pi.on("agent_settled", (_event, ctx) => {
              trace.push(`settled:pending=${ctx.hasPendingMessages()}`);
            });
          },
        ],
      });
      await harness.session.bindExtensions({
        mode: "rpc",
        uiContext: createTestUiContext({ confirm: async () => true }),
      });
      harness.setResponses([
        toolCall("plan_mode_enter", { reason: "Scope" }),
        fauxAssistantMessage("Inspected the tests."),
        fauxAssistantMessage("Unauthorized original replay."),
      ]);
      await harness.session.prompt("Original migration request");
      expect(trace).toContain("user:Instead, inspect the tests");
      expect(trace).toEqual([
        "input:Original migration request",
        "before_agent_start",
        "user:Original migration request",
        "entry confirmed",
        "input:Instead, inspect the tests",
        "user:Instead, inspect the tests",
        "settled:pending=false",
      ]);
      expect(trace.at(-1)).toBe("settled:pending=false");
      expect(
        harness.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom_message" && entry.customType === MODE_CONTRACT_MESSAGE_TYPE),
      ).toBe(false);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
}

test("parallel siblings keep Normal policy until the entire run settles", async () => {
  const fixture = new SessionFixture();
  try {
    const siblingDone = deferred<void>();
    const planned = deferred<void>();
    let ran = false;
    const harness = await fixture.create({
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "normal_mutation",
            label: "Normal mutation",
            description: "Synthetic mutation",
            parameters: Type.Object({}),
            async execute() {
              ran = true;
              siblingDone.resolve();
              return { content: [{ type: "text", text: "ran" }], details: undefined };
            },
          });
        },
        planFactory,
      ],
    });
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: createTestUiContext({
        confirm: async () => {
          await siblingDone.promise;
          return true;
        },
      }),
    });
    harness.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("plan_mode_enter", { reason: "Scope" }), fauxToolCall("normal_mutation", {})],
        { stopReason: "toolUse" },
      ),
      () => {
        expect(ran).toBe(true);
        expect(
          harness.sessionManager
            .getBranch()
            .some((entry) => entry.type === "custom_message" && entry.customType === MODE_CONTRACT_MESSAGE_TYPE),
        ).toBe(false);
        return fauxAssistantMessage("Normal batch complete.");
      },
      () => {
        expect(state(harness).enabled).toBe(true);
        planned.resolve();
        return fauxAssistantMessage("Now planning.");
      },
    ]);
    await harness.session.prompt("Original batch");
    await planned.promise;
    await harness.session.waitForIdle();
    expect(settled(harness, "normal_mutation")[0]?.isError).toBe(false);
  } finally {
    fixture.cleanup();
  }
});
