import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask, formatWorkflowNotification } from "../src/workflow/task.js";

const META = 'export const meta = { name: "locations", description: "stack regression" };';

/** Exercise the real worker, VM and nested source-loading bridge without agents. */
function hostFor(script: string): WorkflowHost {
  return {
    async spawnAgent() { return { ok: true, text: "unused" }; },
    abortAgent() {},
    loadWorkflow() { return { ok: true, script }; },
  };
}

/** Location of the authored constructor expression, including metadata whitespace. */
function location(script: string, filename: string): string {
  const before = script.slice(0, script.indexOf("new TypeError"));
  const lines = before.split(/\r\n|[\n\r\u2028\u2029]/);
  return `${filename}:${lines.length}:${lines.at(-1)!.length + 1}`;
}

const sources = [
  `${META} const error = new TypeError("authored"); return error.stack;`,
  `${META}\n\nconst error = new TypeError("authored");\nreturn error.stack;`,
  `// leading comment\n\n${META}\n/* comment */\nconst error = new TypeError("authored");\nreturn error.stack;`,
  `${META}\r\n\r\nconst error = new TypeError("authored");\r\nreturn error.stack;`,
  'export const meta = {\n name: "locations",\n description: "multiline"\n};\nconst error = new TypeError("authored");\nreturn error.stack;',
];

describe("authored workflow source locations", () => {
  for (const [index, script] of sources.entries()) {
    for (const nested of [false, true]) {
      it(`preserves exact file, line and column for fixture ${index}, nested=${nested}`, async () => {
        const result = await runWorkflow({
          script: nested ? `${META}\nreturn await workflow("locations");` : script,
          host: hostFor(script),
        });
        expect(result.status).toBe("completed");
        const expected = location(script, nested ? "workflow:locations.js" : "workflow.js");
        const frame = String(result.value).split("\n")[1].replace(/\)$/, "");
        expect(frame.slice(-expected.length)).toBe(expected);
        // A shifted source line MUST NOT be accepted by this assertion.
        const [file, line, column] = expected.split(/:(?=\d+(?::\d+)?$)/);
        expect(frame.endsWith(`${file}:${Number(line) + 1}:${column}`)).toBe(false);
      });
    }
  }

  it("maps asynchronous callback and caller frames without replacing the error", async () => {
    const script = `${META}\nasync function fail() {\n  await Promise.resolve();\n  throw new TypeError("callback");\n}\ntry { await fail(); } catch (error) { return error.stack; }`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("completed");
    expect(String(result.value).split("\n")[1]).toContain("workflow.js:4:9");
  });

  for (const nested of [false, true]) {
    it(`keeps parser excerpts in authored coordinates, nested=${nested}`, async () => {
      const script = `${META} return (;`;
      const result = await runWorkflow({
        script: nested ? `${META}\nreturn await workflow("locations");` : script,
        host: hostFor(script),
      });
      expect(result.status).toBe("failed");
      const task = createWorkflowTask({ id: "wf_parse", script });
      completeWorkflowTask(task, result);
      const notification = formatWorkflowNotification(task);
      expect(notification).toContain(nested ? "workflow:locations.js:1" : "workflow.js:1");
      expect(notification).not.toContain("const Date =");
      expect(notification).not.toContain("(async (agent,");
      expect(notification).toContain("SyntaxError");
      if (process.versions.bun?.startsWith("1.3.")) {
        const lines = result.errorStack!.split("\n");
        expect(lines[0]).toBe(nested ? "workflow:locations.js:1" : "workflow.js:1");
        expect(lines[1]).toBe(script.replace("export", "      "));
        expect(lines[2]).not.toMatch(/^\s*\^/);
      }
    });
  }

  it("keeps error identity, subclass, cause and captured stacks across nested rejection", async () => {
    const child = `${META}\nconst cause = new Error("cause");\nconst error = new TypeError("authored", { cause });\nglobalThis.original = error;\nthrow error;`;
    const parent = `${META}\ntry { await workflow("locations"); } catch (error) {\nreturn { same: error === globalThis.original, typed: error instanceof TypeError, cause: error.cause.message, causeStack: error.cause.stack, stack: error.stack };\n}`;
    const result = await runWorkflow({ script: parent, host: hostFor(child) });
    expect(result.status).toBe("completed");
    expect(result.value).toMatchObject({ same: true, typed: true, cause: "cause" });
    const value = result.value as { stack: string; causeStack: string };
    expect(value.stack.split("\n")[1]).toContain("workflow:locations.js:3:15");
    expect(value.causeStack.split("\n")[1]).toContain("workflow:locations.js:2:15");
  });

  it("leaves message text and explicitly captured unrelated stacks untouched", async () => {
    const captured = "CustomError: workflow.js:1:9000\n    at helper (unrelated.js:1:9000)";
    const script = `${META}\nconst error = new Error("workflow.js:1:9000");\nerror.stack = ${JSON.stringify(captured)};\nthrow error;`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.error).toBe("workflow.js:1:9000");
    expect(result.errorStack).toBe(captured);
  });

  it("transports authored cause stacks without replacing the outer mapped stack", async () => {
    const script = `${META}\nconst cause = new RangeError("inner");\nthrow new TypeError("outer", { cause });`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.error).toBe("outer");
    expect(result.errorStack).toContain("workflow.js:3:7");
    expect(result.errorStack).toContain("Caused by: RangeError: inner");
    expect(result.errorStack).toContain("workflow.js:2:15");
  });

  it("bounds oversized diagnostics and terminates cyclic causes", async () => {
    const script = `${META}\nconst error = new Error("x".repeat(20000)); error.cause = error; throw error;`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("failed");
    expect(result.error).toHaveLength(4096);
    expect(result.errorStack).toHaveLength(16384);
    const cyclic = `${META}\nconst error = new Error("cycle"); error.cause = error; throw error;`;
    const cycle = await runWorkflow({ script: cyclic, host: hostFor(cyclic) });
    expect(cycle.errorStack).toContain("Error: cycle");
    expect(cycle.errorStack).not.toContain("Caused by:");
  });

  it("settles non-Error throws and unreadable diagnostic getters", async () => {
    const cases = [
      ['throw "plain";', "plain"],
      ["throw null;", "null"],
      ['const error = new Error("stackless"); error.stack = undefined; throw error;', "stackless"],
      ['throw { get message() { throw 1; } };', "Workflow threw an unreadable error."],
      ['throw { message: "bad stack", get stack() { throw 1; } };', "bad stack"],
      ['const error = new Error("bad cause"); Object.defineProperty(error, "cause", { get() { throw 1; } }); throw error;', "bad cause"],
    ];
    for (const [body, message] of cases) {
      const script = `${META}\n${body}`;
      const result = await runWorkflow({ script, host: hostFor(script) });
      expect(result.status).toBe("failed");
      expect(result.error).toBe(message);
      if (message === "bad cause") expect(result.errorStack).toContain("workflow.js:2:");
    }
  });

  it("delivers authored failure stacks to the completion notification", async () => {
    const script = `${META}\n\nthrow new TypeError("authored");`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("authored");
    const task = createWorkflowTask({ id: "wf_locations", script });
    completeWorkflowTask(task, result);
    expect(formatWorkflowNotification(task)).toContain("workflow.js:3:7");
  });
});
