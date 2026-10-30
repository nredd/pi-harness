/**
 * workflow-examples.test.ts — the shipped example workflows, actually run.
 *
 * `docs/workflows.md` links every file in `examples/workflows/` as a recipe, so
 * a broken one is documentation that lies. Nothing else guards them: `biome.json`
 * scopes linting to `src/**` and `test/**`, and `tsconfig.json` compiles only
 * `src/**`, so these files are neither linted nor typechecked. This suite is it.
 *
 * Three tiers, cheapest first:
 *
 *   1. Structural, glob-driven — every `.js` under the directory really is a
 *      workflow. Glob-driven so a newly added example is covered without anyone
 *      remembering to edit this file.
 *   2. Execution — every example runs to completion against a stub host. This is
 *      the tier that earns its keep: it catches determinism violations, unknown
 *      `agent()` option keys (rejected by name at the call), cap violations,
 *      schema payloads the runtime rejects, and typos in the globals.
 *
 *      It does NOT catch a dropped `await`. The un-awaited-launch check fires on
 *      launches still outstanding when the script ends, and this stub answers
 *      instantly, so an orphaned agent has always settled by then. That check is
 *      covered against a controllable host in `test/workflow-borrowed.test.ts`
 *      ("unawaited launches"); it is not this suite's job.
 *   3. Value — the examples with a stable return shape get an explicit
 *      assertion, including `agentCount`, so a change to an example's fan-out
 *      has to be acknowledged rather than sliding through.
 *
 * The stub returns arbitrary text, so nothing here asserts on prose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoverageMap } from "@vitest/istanbul-lib-coverage";
import { createInstrumenter } from "@vitest/istanbul-lib-instrument";
import { describe, expect, it } from "vitest";
import { extractMeta, hasMetaDeclaration, WorkflowMetaError } from "../src/workflow/meta.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowHost,
  type WorkflowSpawnRequest,
} from "../src/workflow/runtime.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../examples/workflows", import.meta.url));
const LIB_DIR = join(EXAMPLES_DIR, "lib");

/** Top-level examples — `lib/` holds nested children, run through their parents. */
const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter(name => name.endsWith(".js"))
  .sort();

const childFiles = readdirSync(LIB_DIR)
  .filter(name => name.endsWith(".js"))
  .sort();

const readExample = (dir: string, name: string) => readFileSync(join(dir, name), "utf-8");
const instrumenter = createInstrumenter({ coverageGlobalScope: "globalThis", coverageGlobalScopeFunc: false });
const workflowCoverage = createCoverageMap({});
// Vitest 5 uses a separate host-side store; VM instrumentation retains Istanbul's default.
const coverageGlobal = globalThis as typeof globalThis & { __VITEST_COVERAGE__?: unknown };
const workflowSourcePaths = new Map(
  [
    ...exampleFiles.map(name => [readExample(EXAMPLES_DIR, name), join(EXAMPLES_DIR, name)] as const),
    ...childFiles.map(name => [readExample(LIB_DIR, name), join(LIB_DIR, name)] as const),
  ],
);

const transformScriptBody: NonNullable<RunWorkflowOptions["transformScriptBody"]> = ({ script, body }) => {
  const path = workflowSourcePaths.get(script);
  if (path === undefined) throw new Error("Workflow coverage transform received an unknown source.");
  return instrumenter.instrumentSync(body, path);
};

function collectCoverage(coverage: unknown): void {
  workflowCoverage.merge(coverage as never);
  // Do not add example records to the primary src-only report when this suite runs there.
  if (process.env.PI_WORKFLOW_EXAMPLE_COVERAGE === "1") {
    const map = createCoverageMap(coverageGlobal.__VITEST_COVERAGE__ as never);
    map.merge(coverage as never);
    coverageGlobal.__VITEST_COVERAGE__ = map.toJSON();
  }
}

/**
 * Args for examples that need them. An example not listed here runs with
 * `args: undefined`, which every one of them must tolerate — that is the point
 * of the `args?.x ?? default` idiom they all use.
 */
const SAMPLE_ARGS: Record<string, unknown> = {
  "fan-out-audit.js": { root: "src/routes/" },
  "compose.js": { root: "src/" },
};

/**
 * A host that answers every spawn plausibly and deterministically.
 *
 * Replies are keyed off the `label`, exactly as
 * `test/workflow-claude-code-compat.test.ts` does, rather than off the schema:
 * `request.schema` reaches the host already COMPILED, so sniffing it for
 * property names silently matches nothing and every schema-bearing call ends up
 * `null`. Labels are stable and are what the examples name their calls by.
 *
 * The payloads still have to satisfy the real schemas — the runtime validates
 * them — so a wrong shape here fails the example rather than passing quietly.
 */
function stubHost(options: { failsFor?: string[]; gateFailsFor?: string[]; failsLoadingWorkflow?: string[] } = {}): {
  host: WorkflowHost;
  spawns: WorkflowSpawnRequest[];
  resumes: string[];
} {
  const spawns: WorkflowSpawnRequest[] = [];
  const resumes: string[] = [];
  /** agentId → label, so `runGate` can tell which child it is gating. */
  const labels = new Map<string, string>();

  const host: WorkflowHost = {
    async spawnAgent(request) {
      spawns.push(request);
      labels.set(request.agentId, request.label);
      const label = request.label;
      if (options.failsFor?.includes(label)) {
        return { ok: false, error: `${label} failed`, outputTokens: 10 };
      }

      // Only a call that ASKED for a schema gets JSON. Keying on the label
      // alone would hand fan-out-audit's un-schema'd `verify:<file>` calls a
      // JSON blob, since structured-findings labels its verifiers the same way.
      if (request.schema !== undefined) {
        // structured-findings: one finding per dimension.
        if (label.startsWith("review:")) {
          return {
            ok: true,
            text: JSON.stringify({ findings: [{ title: `${label} finding`, file: "a.ts", severity: "low" }] }),
            outputTokens: 10,
          };
        }
        // structured-findings: every finding holds up.
        if (label.startsWith("verify:")) {
          return { ok: true, text: JSON.stringify({ isReal: true, why: "reproduced" }), outputTokens: 10 };
        }
        // lib/count-child.js
        if (label === "scan") {
          return { ok: true, text: JSON.stringify({ files: ["a.ts", "b.ts"] }), outputTokens: 10 };
        }
        // Deliberately invalid: a new schema-bearing example with an unhandled
        // label fails validation here rather than passing on an empty object.
        return { ok: true, text: "{}", outputTokens: 10 };
      }

      // fan-out-audit: drives the fan-out width, so keep it small and stable.
      if (label === "discover") {
        return { ok: true, text: "src/routes/a.ts\nsrc/routes/b.ts", outputTokens: 10 };
      }
      return { ok: true, text: `ok:${label}`, outputTokens: 10 };
    },
    abortAgent() {},
    async resumeAgent(_agentId, prompt) {
      resumes.push(prompt);
      return { ok: true, text: `resumed:${prompt.slice(0, 20)}`, outputTokens: 10 };
    },
    // Required, not optional: the runtime FAILS a gate it cannot run rather than
    // skipping it, so a host without this would fail every gated example.
    //
    // A rejected gate is reported HERE rather than as a failed spawn: a child
    // whose spawn failed is not offered as a resume target, so failing the spawn
    // would make gated-fix's whole reason for existing untestable.
    async runGate(command, gate) {
      const label = labels.get(gate.agentId) ?? "";
      if (options.gateFailsFor?.includes(label)) {
        return { ok: false, output: `${command}: 1 failing` };
      }
      return { ok: true, output: `${command}: ok` };
    },
    loadWorkflow(ref) {
      // WorkflowScriptRef is { name?, scriptPath? } — never a bare string.
      const name = ref.name;
      if (name === undefined) return { ok: false, message: "only `name` refs are stubbed" };
      if (options.failsLoadingWorkflow?.includes(name)) {
        return { ok: false, message: `cannot load child workflow "${name}"` };
      }
      const file = childFiles.find(child => child === `${name}.js`);
      if (file === undefined) return { ok: false, message: `no child workflow "${name}"` };
      return { ok: true, script: readExample(LIB_DIR, file) };
    },
  };
  return { host, spawns, resumes };
}

const runExample = (name: string, host: WorkflowHost) =>
  runWorkflow({
    script: readExample(EXAMPLES_DIR, name),
    host,
    args: SAMPLE_ARGS[name],
    onScriptCoverage: collectCoverage,
    transformScriptBody,
  });

describe("shipped example workflows", () => {
  it("ships at least the examples the guide links", () => {
    // docs/workflows.md has a row per file; a deletion should break this first.
    expect(exampleFiles).toEqual([
      "compose.js",
      "fan-out-audit.js",
      "gated-fix.js",
      "review-panel.js",
      "structured-findings.js",
    ]);
    expect(childFiles).toEqual(["count-child.js"]);
  });

  // Tier 1 — glob-driven, so a new example is covered the moment it lands.
  describe.each([...exampleFiles.map(n => [EXAMPLES_DIR, n] as const), ...childFiles.map(n => [LIB_DIR, n] as const)])(
    "%s/%s",
    (dir, name) => {
      it("is recognisable as a workflow and declares a usable meta block", () => {
        const source = readExample(dir, name);
        // The same test `saved.ts` applies before it will resolve a file.
        expect(hasMetaDeclaration(source)).toBe(true);

        // extractMeta throws WorkflowMetaError rather than returning a union,
        // so a bad `meta` surfaces as the parser's own message.
        const { meta } = extractMeta(source);
        expect(meta.name).toBeTruthy();
        expect(meta.description).toBeTruthy();
      });
    },
  );

  // Tier 2 — the one that actually catches things.
  describe.each(exampleFiles)("%s", name => {
    it("runs to completion against a stub host", async () => {
      const { host } = stubHost();
      const result = await runExample(name, host);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    });

    it("tolerates being run with no args at all", async () => {
      // Every example documents `args?.x ?? default`; this is what pins it.
      const { host } = stubHost();
      const result = await runWorkflow({
        script: readExample(EXAMPLES_DIR, name),
        host,
        onScriptCoverage: collectCoverage,
        transformScriptBody,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    });
  });

  // Tier 3 — explicit values, including the fan-out width.
  describe("returned values", () => {
    it("fan-out-audit returns one verified finding per discovered file", async () => {
      const { host } = stubHost();
      const result = await runExample("fan-out-audit.js", host);

      // 1 discovery + 2 files x (audit + verify).
      expect(result.agentCount).toBe(5);
      expect(result.value).toEqual(["ok:verify:src/routes/a.ts", "ok:verify:src/routes/b.ts"]);
    });

    it("structured-findings returns validated objects, not prose", async () => {
      const { host } = stubHost();
      const result = await runExample("structured-findings.js", host);

      // 2 dimensions x (1 review + 1 finding verified).
      expect(result.agentCount).toBe(4);
      expect(result.value).toMatchObject({ confirmed: 2 });
    });

    it("review-panel synthesizes once, after every lens", async () => {
      const { host, spawns } = stubHost();
      const result = await runExample("review-panel.js", host);

      expect(result.agentCount).toBe(4); // 3 lenses + 1 synthesis
      expect(result.value).toMatchObject({ reviewed: 3 });
      // The cheap/expensive split is the point of the example.
      expect(spawns.filter(s => s.effort === "low")).toHaveLength(3);
      expect(spawns.find(s => s.label === "synthesize")?.effort).toBe("high");
    });

    it("compose runs its nested child and reports what it counted", async () => {
      const { host } = stubHost();
      const result = await runExample("compose.js", host);

      // The child's agent counts toward the parent run — they share the counter.
      expect(result.agentCount).toBe(2);
      expect(result.value).toMatchObject({ ok: true, count: 2 });
    });

    it("compose reports discovery failure instead of treating it as zero files", async () => {
      const { host, spawns } = stubHost({ failsFor: ["scan"] });
      const result = await runExample("compose.js", host);

      expect(result.value).toEqual({
        ok: false,
        reason: "The file-discovery agent returned no result.",
      });
      expect(result.agentCount).toBe(1);
      expect(spawns.map(spawn => spawn.label)).toEqual(["scan"]);
    });

    it("compose returns a nested-workflow load failure", async () => {
      const { host, spawns } = stubHost({ failsLoadingWorkflow: ["count-child"] });
      const result = await runExample("compose.js", host);

      expect(result.value).toEqual({
        ok: false,
        reason: 'workflow("count-child"): cannot load child workflow "count-child"',
      });
      expect(result.agentCount).toBe(0);
      expect(spawns).toEqual([]);
    });

    it("review-panel returns a null verdict when every reviewer fails", async () => {
      const { host, spawns } = stubHost({
        failsFor: ["review:correctness", "review:security", "review:performance"],
      });
      const result = await runExample("review-panel.js", host);

      expect(result.value).toEqual({ reviewed: 0, verdict: null });
      expect(result.agentCount).toBe(3);
      expect(spawns.map(spawn => spawn.label)).toEqual(["review:correctness", "review:security", "review:performance"]);
    });

    it("gated-fix passes straight through when the gate is happy", async () => {
      const { host, spawns } = stubHost();
      const result = await runExample("gated-fix.js", host);

      expect(result.agentCount).toBe(1);
      expect(result.value).toMatchObject({ passed: true });
      expect(spawns[0]?.gate).toBe("npm test");
    });

    it("gated-fix resumes the same child when the gate rejects the work", async () => {
      // The branch the example exists to demonstrate: fail the first gate only.
      const { host, spawns, resumes } = stubHost({ gateFailsFor: ["fix"] });
      const result = await runExample("gated-fix.js", host);

      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ passed: true });
      // fix (gated, fails) → resume → verify (gated, passes).
      expect(spawns.map(s => s.label)).toEqual(["fix", "verify"]);
      expect(resumes).toEqual([
        "Run `npm test` yourself and inspect its diagnostics. Fix the cause, then stop.",
      ]);
      expect(result.agentCount).toBe(3);
    });
  });

  it("collects counters from every executed workflow VM", () => {
    const collected = workflowCoverage.toJSON();
    const expected = [
      ...exampleFiles.map(name => join(EXAMPLES_DIR, name)),
      ...childFiles.map(name => join(LIB_DIR, name)),
    ].sort();

    const exampleCoverage = Object.fromEntries(
      expected.map(path => [path, collected[path]]),
    ) as Record<
      string,
      { s: Record<string, number>; statementMap: Record<string, { start: { line: number } }> }
    >;

    if (process.env.PI_WORKFLOW_EXAMPLE_COVERAGE !== "1") {
      const primary = createCoverageMap(coverageGlobal.__VITEST_COVERAGE__ as never);
      expect(primary.files().filter(path => expected.includes(path))).toEqual([]);
    }
    expect(Object.keys(exampleCoverage).sort()).toEqual(expected);
    for (const [source, path] of workflowSourcePaths) {
      const metaStartLine = source.slice(0, source.indexOf("export const meta")).split("\n").length;
      const metaEndLine = source.slice(0, extractMeta(source).metaEnd).split("\n").length;
      const file = exampleCoverage[path];
      expect(file, `${path} worker VM must return coverage`).toBeDefined();
      if (file === undefined) continue;
      expect(Object.values(file.s).some(hit => hit > 0), `${path} must execute instrumented source`).toBe(true);
      const metaStatement = Object.entries(file.statementMap).find(
        ([, location]) => location.start.line >= metaStartLine && location.start.line <= metaEndLine,
      );
      expect(metaStatement, `${path} metadata initializer must be instrumented`).toBeDefined();
      expect(file.s[metaStatement?.[0] ?? ""], `${path} metadata initializer must execute`).toBeGreaterThan(0);
    }
  });

  it("does not inspect workflow coverage without an explicit collector", async () => {
    const { host } = stubHost();
    const result = await runWorkflow({
      script: [
        "export const meta = { name: 'coverage-isolation', description: 'assert the default path' };",
        // Node's contextified global can swallow a throwing getter. An uncloneable
        // return value detects both the getter read and accidental postMessage transport.
        "Object.defineProperty(globalThis, '__coverage__', { get() { return () => 'must not transport coverage'; } });",
        "return 1;",
      ].join("\n"),
      host,
    });

    expect(result).toMatchObject({ status: "completed", value: 1 });
  });

  // A negative case, rather than shipping a deliberately broken file.
  it("a file with no meta declaration is not treated as a workflow", () => {
    // `const meta` without `export` is the near-miss worth pinning: it reads
    // like a workflow and is not one.
    const notAWorkflow = "const meta = { name: 'x' };\nreturn 1;\n";

    expect(hasMetaDeclaration(notAWorkflow)).toBe(false);
    expect(() => extractMeta(notAWorkflow)).toThrow(WorkflowMetaError);
  });
});
