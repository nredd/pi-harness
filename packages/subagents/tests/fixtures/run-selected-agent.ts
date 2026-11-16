/** Test-only direct-runner adapter: production selection/admission belongs to AgentManager. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RunOptions, runAgent as runAdmittedAgent } from "../../src/agent-runner.ts";
import { getAgentConfig } from "../../src/agent-types.ts";
import { admitModelSelection, selectModel } from "../../src/model-selection.ts";
import { describeBlock } from "../../src/quota-admission.ts";

/** Prepare the same selection a manager supplies, without mocking the selector. */
export async function runAgent(ctx: ExtensionContext, type: string, prompt: string, options: Omit<RunOptions, "modelSelection"> & Partial<Pick<RunOptions, "modelSelection">>) {
  const selection = options.modelSelection ?? selectModel({
    agentType: type, definitionModel: getAgentConfig(type)?.model, paramModel: options.model,
    parentModel: ctx.model, registry: ctx.modelRegistry, cwd: options.configCwd ?? options.cwd ?? ctx.cwd,
  });
  if (typeof selection === "string") throw new Error(selection);
  const block = await admitModelSelection(selection, ctx.modelRegistry, options.pi.events);
  if (block) throw new Error(describeBlock(block));
  return runAdmittedAgent(ctx, type, prompt, { ...options, modelSelection: selection });
}
