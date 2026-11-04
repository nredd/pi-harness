/**
 * plan-mode-contract.test.ts -- #437: what the query and handshake contract with
 * pi-plan-mode does with every kind of answer, including none. Mock-free, so it
 * also runs under `bun test` with the session scenarios.
 */
import { describe, expect, it } from "vitest";
import {
  answerPlanGateQueries,
  PLAN_MODE_GATE_QUERY,
  PLAN_MODE_SILENT_ERROR,
  PLAN_MODE_STATE_QUERY,
  type PlanToolPolicy,
  planGateReason,
  queryPlanPolicy,
} from "../src/plan-mode-children.js";

const BLOCK_WRITE: PlanToolPolicy = ({ toolName }) => (toolName === "write" ? "Plan blocks write" : undefined);
const FAIL_CLOSED_BASH = "Plan mode is active and sent no tool policy this subagent understands, so 'bash' is blocked.";

type Handler = (data: unknown) => void;

/** A synchronous bus like `pi.events`, whose pi-plan-mode answers state queries with `answer()`. */
function planBus(answer: () => unknown) {
  const handlers = new Map<string, Handler[]>();
  const events = {
    on(channel: string, handler: Handler) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
  events.on(PLAN_MODE_STATE_QUERY, (data) => {
    const state = answer();
    if (state !== undefined) (data as { reply: (state: unknown) => void }).reply(state);
  });
  return events;
}

/** What pi-plan-mode's handshake hears back on `events`. */
function askGate(events: ReturnType<typeof planBus>): unknown[] {
  const replies: unknown[] = [];
  events.emit(PLAN_MODE_GATE_QUERY, { version: 1, reply: (gate: unknown) => replies.push(gate) });
  return replies;
}

const call = (toolName: string) => ({ toolName, input: {}, cwd: "/repo", tool: undefined });

describe("queryPlanPolicy", () => {
  it("is undefined without a bus, without an answer, or when nobody is planning", () => {
    expect(queryPlanPolicy(undefined)).toBeUndefined();
    expect(queryPlanPolicy(planBus(() => undefined))).toBeUndefined();
    expect(queryPlanPolicy(planBus(() => ({ version: 1, active: false })))).toBeUndefined();
    expect(queryPlanPolicy(planBus(() => null))).toBeUndefined();
  });

  it("returns the planner's policy", () => {
    const policy = queryPlanPolicy(planBus(() => ({ version: 1, active: true, evaluate: BLOCK_WRITE })));
    expect(policy?.(call("write"))).toBe("Plan blocks write");
    expect(policy?.(call("read"))).toBeUndefined();
  });

  it("fails closed on an active answer it cannot use", () => {
    for (const answer of [{ version: 1, active: true }, { version: 2, active: true, evaluate: () => undefined }]) {
      const policy = queryPlanPolicy(planBus(() => answer));
      expect(policy?.(call("read"))).toBeUndefined();
      expect(policy?.(call("bash"))).toBe(FAIL_CLOSED_BASH);
    }
  });

  it("combines several active answers so any refusal wins", () => {
    const blockBash: PlanToolPolicy = ({ toolName }) => (toolName === "bash" ? "no bash" : undefined);
    const events = {
      emit: (_channel: string, data: unknown) => {
        const { reply } = data as { reply: (state: unknown) => void };
        reply({ version: 1, active: true, evaluate: BLOCK_WRITE });
        reply({ version: 1, active: true, evaluate: blockBash });
      },
    };
    const policy = queryPlanPolicy(events);
    expect(policy?.(call("write"))).toBe("Plan blocks write");
    expect(policy?.(call("bash"))).toBe("no bash");
    expect(policy?.(call("read"))).toBeUndefined();
  });

  it("refuses a spawn and restricts a resume once Plan mode has shown itself and then goes silent", () => {
    let answering = true;
    const events = planBus(() => (answering ? { version: 1, active: false } : undefined));
    answerPlanGateQueries(events);
    expect(askGate(events)).toEqual([{ version: 1, gate: "@nredd/pi-subagents" }]);

    // Plan mode answers: nobody is planning, nothing changes.
    expect(queryPlanPolicy(events)).toBeUndefined();

    // Plan mode is installed but its answer is gone (a throw swallowed by the bus, a stale build).
    answering = false;
    expect(() => queryPlanPolicy(events)).toThrow(PLAN_MODE_SILENT_ERROR);
    const policy = queryPlanPolicy(events, "restrict");
    expect(policy?.(call("ls"))).toBeUndefined();
    expect(policy?.(call("bash"))).toBe(FAIL_CLOSED_BASH);
  });

  it("stays open when Plan mode never showed itself on this bus", () => {
    const events = planBus(() => undefined);
    answerPlanGateQueries(events);
    expect(queryPlanPolicy(events)).toBeUndefined();
    expect(queryPlanPolicy(events, "restrict")).toBeUndefined();
  });

  it("ignores a gate query without a reply callback, but still records Plan mode", () => {
    const events = planBus(() => undefined);
    answerPlanGateQueries(events);
    events.emit(PLAN_MODE_GATE_QUERY, undefined);
    expect(() => queryPlanPolicy(events)).toThrow(PLAN_MODE_SILENT_ERROR);
  });
});

describe("planGateReason", () => {
  const tools = () => [{ name: "write", sourceInfo: { source: "builtin" } }] as never;

  it("asks the policy with the child's own tool metadata, except for exempt or ungated calls", () => {
    const seen: unknown[] = [];
    const policy: PlanToolPolicy = (c) => {
      seen.push(c.tool);
      return "no";
    };
    const gate = { policy };
    expect(planGateReason(gate, { toolName: "write", input: {}, cwd: "/r" }, tools, new Set())).toBe("no");
    expect(seen).toEqual([{ name: "write", sourceInfo: { source: "builtin" } }]);
    expect(planGateReason(gate, { toolName: "Agent", input: {}, cwd: "/r" }, tools, new Set(["Agent"]))).toBeUndefined();
    expect(planGateReason({}, { toolName: "write", input: {}, cwd: "/r" }, tools, new Set())).toBeUndefined();
    expect(planGateReason(undefined, { toolName: "write", input: {}, cwd: "/r" }, tools, new Set())).toBeUndefined();
  });
});
