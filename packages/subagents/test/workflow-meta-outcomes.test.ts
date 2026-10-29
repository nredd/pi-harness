/** Metadata diagnostics and scanner delimiters, through the public parser. */
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { extractMeta, workflowCallName } from "../src/workflow/meta.js";

describe("workflow metadata outcomes", () => {
  it.each([null, 7, []])("rejects a non-object returned by the VM collaborator (%j)", value => {
    const evaluate = vi.spyOn(Script.prototype, "runInContext").mockReturnValueOnce(value);
    try {
      expect(() => extractMeta("export const meta = {name: 'valid', description: 'd'}")).toThrow("`meta` must be an object literal.");
      expect(evaluate).toHaveBeenCalledOnce();
    } finally { evaluate.mockRestore(); }
    expect(extractMeta("export const meta = {name: 'valid', description: 'd'}").meta.name).toBe("valid");
  });
  it.each([
    ["[null]", "`meta.phases[0]` must be an object with a `title`."],
    ["[[]]", "`meta.phases[0]` must be an object with a `title`."],
    ["[7]", "`meta.phases[0]` must be an object with a `title`."],
    ["[{title: 'Scan', detail: 7}]", "`meta.phases[0].detail` must be a string."],
    ["[{title: 'Scan', model: false}]", "`meta.phases[0].model` must be a string."],
  ])("rejects malformed phases %s with actionable field-specific guidance", (phases, message) => {
    expect(() => extractMeta(`export const meta = {name: 'wf', description: 'd', phases: ${phases}}`)).toThrow(message);
  });

  it("does not mistake regex braces or division for the end of the metadata object", () => {
    const source = "export const meta = {name: 'regex-fixture', ignored: /}\\/}/, ratio: 8 / 2, description: 'after delimiters'};\nthrow new Error('body must not execute');";
    const parsed = extractMeta(source);
    expect(parsed.meta).toEqual({ name: "regex-fixture", description: "after delimiters" });
    expect(parsed.body).toBe(source.replace("export", "      "));
  });

  it.each([
    [{ scriptPath: "/tmp/saved/review.js" }, "review.js"],
    [{ script: "", scriptPath: "C:\\saved\\review.js", name: "ignored" }, "review.js"],
    [{ name: "saved-review" }, "saved-review"],
    [{ name: "" }, "workflow"],
    [{}, "workflow"],
  ])("labels a path-only or named call %j without evaluating a script", (args, label) => {
    expect(workflowCallName(args)).toBe(label);
  });

  it("caches both valid names and the invalid-script fallback without borrowing another script's label", () => {
    const valid = "export const meta = {name: 'cached-real-name', description: 'd'}";
    const invalid = "export const meta = {name: 7, description: 'd'}";
    expect(workflowCallName({ script: valid })).toBe("cached-real-name");
    expect(workflowCallName({ script: valid })).toBe("cached-real-name");
    expect(workflowCallName({ script: invalid })).toBe("workflow");
    expect(workflowCallName({ script: invalid })).toBe("workflow");
  });
});
