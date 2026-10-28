import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask, formatWorkflowNotification, workflowResultText } from "../src/workflow/task.js";
import { WORKER_SOURCE } from "../src/workflow/worker-source.js";

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

/** Run the actual worker source with a local VM constructor, never a shared module mock. */
function workerWithScript(Script: typeof vm.Script, body: string): Promise<{
  type: string; message?: string; stack?: string; resultJson?: string;
}> {
  return new Promise(resolve => {
    vm.runInNewContext(WORKER_SOURCE, {
      require(id: string) {
        if (id === "node:vm") return { ...vm, Script };
        if (id === "node:worker_threads") return {
          parentPort: { on() {}, postMessage: resolve },
          workerData: { body, metaJson: "{}", itemCap: 4096, nestedCap: 256 },
        };
        throw new Error(`Unexpected worker import: ${id}`);
      },
      setTimeout,
      clearTimeout,
    });
  });
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
      const lines = result.errorStack!.split("\n");
      expect(lines[0]).toBe(nested ? "workflow:locations.js:1" : "workflow.js:1");
      expect(lines[1]).toBe(script.replace("export", "      "));
      if (process.versions.bun?.startsWith("1.3.")) {
        expect(lines[2]).not.toMatch(/^\s*\^/);
      } else {
        // Node and Bun 1.4 supply the semicolon's exact authored caret column.
        expect(lines[2]).toBe(`${" ".repeat(script.lastIndexOf(";"))}^`);
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
    expect(value.stack.split("\n")[1].trim()).toMatch(/^at .*\bworkflow:locations\.js:3:15\)?$/);
    expect(value.causeStack.split("\n")[1].trim()).toMatch(/^at .*\bworkflow:locations\.js:2:15\)?$/);
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
    const lines = result.errorStack!.split("\n");
    expect(lines[1].trim()).toMatch(/^at .*\bworkflow\.js:3:7\)?$/);
    const causeAt = lines.indexOf("Caused by: RangeError: inner");
    expect(causeAt).toBeGreaterThan(1);
    expect(lines[causeAt + 1].trim()).toMatch(/^at .*\bworkflow\.js:2:15\)?$/);
    const task = createWorkflowTask({ id: "wf_cause", script });
    completeWorkflowTask(task, result);
    expect(workflowResultText(task)).toBe(result.errorStack);
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

  it("keeps the formatter and its constructor in the script realm", async () => {
    const script = `${META}\nconst formatter = Error.prepareStackTrace;\nlet refused = false;\ntry { formatter.constructor("return 1")(); } catch (error) { refused = error instanceof EvalError; }\nreturn { native: formatter instanceof Function, refused };`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ native: true, refused: true });
  });

  it("does not map a real structured frame from an unrelated first-line file", async () => {
    const external = `globalThis.external = function external() { ${" ".repeat(9000)}return new TypeError("external"); };`;
    class ExternalScript extends vm.Script {
      override runInContext(context: vm.Context, options?: vm.RunningScriptOptions): unknown {
        new vm.Script(external, { filename: "unrelated.js" }).runInContext(context);
        return super.runInContext(context, options);
      }
    }
    const result = await workerWithScript(ExternalScript, "return external().stack;");
    expect(result.type).toBe("complete");
    const firstFrame = (JSON.parse(result.resultJson!) as string).split("\n")[1];
    const expected = `unrelated.js:1:${external.indexOf("new TypeError") + 1}`;
    expect(firstFrame.replace(/\)$/, "").slice(-expected.length)).toBe(expected);
  });

  it("retains SyntaxError diagnostics when the parser stack omits excerpt or caret lines", async () => {
    for (const excerpt of [false, true]) {
      class ShortStackScript extends vm.Script {
        constructor(code: string, options?: vm.ScriptOptions) {
          super("", options);
          const error = new SyntaxError("original parser failure");
          const prefix = code.slice(0, code.indexOf("return 1;"));
          error.stack = `workflow.js:1\n${excerpt ? prefix + "return 1;" : ""}`;
          throw error;
        }
      }
      const result = await workerWithScript(ShortStackScript, "return 1;");
      expect(result.type).toBe("error");
      expect(result.message).toBe("original parser failure");
      expect(result.stack).toBe(`workflow.js:1\n${excerpt ? "return 1;" : ""}`);
    }
  });

  it("retains the concise message before a custom captured stack and its cause in the LLM result", async () => {
    const captured = "captured elsewhere\n    at helper (unrelated.js:1:9000)";
    const script = `${META}\nconst cause = new Error("inner"); cause.stack = "Error: inner\\n    at cause (unrelated.js:1:8000)";\nconst error = new Error("outer", { cause }); error.stack = ${JSON.stringify(captured)}; throw error;`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("failed");
    const task = createWorkflowTask({ id: "wf_custom", script });
    completeWorkflowTask(task, result);
    const text = `outer\n${captured}\nCaused by: Error: inner\n    at cause (unrelated.js:1:8000)`;
    expect(workflowResultText(task)).toBe(text);
    expect(formatWorkflowNotification(task)).toContain(`<result>${text}</result>`);
    task.errorStack = `Error: outer\n${"x".repeat(20000)}`;
    expect(workflowResultText(task)).toHaveLength(16384);
    expect(workflowResultText(task).startsWith("Error: outer\n")).toBe(true);
    task.errorStack = "Captured outer context\n    at helper (unrelated.js:1:9000)";
    expect(workflowResultText(task)).toBe(`outer\n${task.errorStack}`);
    for (const heading of ["outer", "Error: outer", "TypeError: outer", "CustomError: outer"]) {
      task.errorStack = `${heading}\n    at helper (unrelated.js:1:9000)`;
      expect(workflowResultText(task)).toBe(task.errorStack);
    }
  });

  it("retains a distinct concise error when captured context merely contains a short message", async () => {
    for (const message of ["x", "outer"]) {
      const captured = `Captured ${message} context\n    at helper (unrelated.js:1:9000)`;
      const script = `${META}\nconst error = new Error(${JSON.stringify(message)}); error.stack = ${JSON.stringify(captured)}; throw error;`;
      const result = await runWorkflow({ script, host: hostFor(script) });
      expect(result.status).toBe("failed");
      expect(result.error).toBe(message);
      expect(result.errorStack).toBe(captured);
      const task = createWorkflowTask({ id: "wf_short_message", script });
      completeWorkflowTask(task, result);
      expect(workflowResultText(task)).toBe(`${message}\n${captured}`);
      expect(workflowResultText(task).split("\n")[0]).toBe(message);
      expect(task.errorStack).toBe(captured);
    }
  });

  it("bounds the combined worker message and captured stack result at 20481 characters", async () => {
    const script = `${META}\nconst error = new Error("m".repeat(20000)); error.stack = "s".repeat(20000); throw error;`;
    const result = await runWorkflow({ script, host: hostFor(script) });
    expect(result.status).toBe("failed");
    expect(result.error).toHaveLength(4096);
    expect(result.errorStack).toHaveLength(16384);
    const task = createWorkflowTask({ id: "wf_max_message", script });
    completeWorkflowTask(task, result);
    expect(workflowResultText(task)).toBe(`${"m".repeat(4096)}\n${"s".repeat(16384)}`);
    expect(workflowResultText(task)).toHaveLength(20481);
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
