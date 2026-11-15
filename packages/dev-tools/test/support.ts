/**
 * Tool host for dev-tools tests: the shared recording `ExtensionAPI` (`@nredd/pi-test-lib/pi`)
 * plus `call`, which validates arguments against the tool's TypeBox `parameters` and results
 * against its `outputSchema`, so a test cannot pass with arguments or structured content pi
 * itself would reject.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRecordingContext, createRecordingPi } from "@nredd/pi-test-lib/pi";
import type { TSchema } from "typebox";
import { Errors } from "typebox/value";

export type MockResult = {
	content: { text: string }[];
	structuredContent: unknown;
	isError: boolean;
	details?: unknown;
};

function schemaProblem(schema: TSchema, value: unknown): string | undefined {
	const first = [...Errors(schema, value)][0];
	return first ? `${first.instancePath || "/"}: ${first.message}` : undefined;
}

type SchemaTool = ToolDefinition & { outputSchema?: TSchema };

export function createToolHost() {
	const recording = createRecordingPi({ autoActivate: false });
	return Object.assign(recording, {
		async call(name: string, params: unknown, cwd: string): Promise<MockResult> {
			const tool = recording.tools.get(name) as SchemaTool | undefined;
			if (!tool) throw new Error(`tool ${name} not registered`);
			const bad = schemaProblem(tool.parameters as TSchema, params);
			if (bad) throw new Error(`${name} params rejected by schema ${bad}`);
			const result = (await tool.execute(
				"id",
				params,
				undefined,
				undefined,
				createRecordingContext({ cwd }).ctx,
			)) as unknown as MockResult;
			if (tool.outputSchema) {
				const badOut = schemaProblem(tool.outputSchema, result.structuredContent);
				if (badOut) throw new Error(`${name} structuredContent violates outputSchema ${badOut}`);
			}
			return result;
		},
		text(result: MockResult): string {
			return result.content.map((c) => c.text).join("\n");
		},
		toolCall(toolName: string, input: unknown) {
			const ctx = createRecordingContext().ctx;
			for (const hook of recording.handlers.get("tool_call") ?? []) {
				const decision = hook({ toolName, input }, ctx);
				if (decision) return decision;
			}
			return undefined;
		},
	});
}
