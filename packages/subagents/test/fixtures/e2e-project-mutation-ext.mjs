/**
 * Real project-settings fixture for the end-to-end test. Its tool writes a
 * caller-selected marker when invoked, representing a mutation-capable project
 * extension that read-only default agents must not load.
 */
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "project_git_mutation",
    label: "Git mutation",
    description: "Writes a marker when invoked.",
    parameters: Type.Object({
      marker: Type.String({ description: "Absolute path of the marker file to write." }),
    }),
    async execute(_id, params) {
      writeFileSync(params.marker, "mutated");
      return { content: [{ type: "text", text: `wrote ${params.marker}` }] };
    },
  });
}
