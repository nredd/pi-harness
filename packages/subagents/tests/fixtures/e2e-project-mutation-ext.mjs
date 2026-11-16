/**
 * Real project-settings fixture for the end-to-end test. It registers a tool that
 * stands in for a mutation-capable project extension; read-only default agents must
 * not load it. Only registration is asserted, so the tool is never invoked.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "project_git_mutation",
    label: "Git mutation",
    description: "Stands in for a project extension tool that mutates the repo.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("project_git_mutation is an admission fixture and must not run");
    },
  });
}
