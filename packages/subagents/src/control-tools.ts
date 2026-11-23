import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortable } from "./abortable.ts";
import { type AgentManager, describeEvicted, type EvictedNote, isTopLevelAgent } from "./agent-manager.ts";
import { type AgentRef, agentNotFound, type SurvivorReach } from "./agent-ref.ts";
import { getAgentConversation, SUBAGENT_TOOL_NAMES, steerAgent } from "./agent-runner.ts";
import type { Clock } from "./clock.ts";
import { NOTIFICATION_HOLD_MS } from "./completion-outbox.ts";
import { listRunningDetached } from "./detached-results.ts";
import { errorMessage } from "./error-message.ts";
import { modelSelectionNote } from "./model-selection.ts";
import { planSteerBlocked, planSteerRefusal } from "./plan-mode-children.ts";
import { getStatusNote, partialOutputSuffix } from "./status-note.ts";
import type { AgentRecord } from "./types.ts";
import { formatCost, formatDuration, getDisplayName } from "./ui/agent-widget.ts";
import { getLifetimeCost, getSessionContextPercent } from "./usage.ts";
import type { WorkflowTask } from "./workflow/task.ts";

/** A workflow run a stop can still reach: running or paused, not already told to stop. */
export const isLiveWorkflow = (task: WorkflowTask) =>
	(task.status === "running" || task.status === "paused") && !task.abortController.signal.aborted;

export function createStopActions(
	manager: AgentManager,
	getCtx: () => ExtensionContext | undefined,
	getWorkflowTasks: () => ReadonlyMap<string, WorkflowTask>,
) {
	/** Survivors of a session switch, still running in the orphaned manager (#330). */
	const runningSurvivors = () => listRunningDetached(getCtx()?.sessionManager?.getSessionFile?.());

	/**
	 * Agents a stop can reach: this session's own running or queued top-level
	 * agents, then survivors. Never a nested or workflow child: those belong to
	 * their owner, which stops them with itself (#446's ownership invariant).
	 */
	function stoppableAgents(): AgentRecord[] {
		const own = manager
			.listAgents()
			.filter((r) => isTopLevelAgent(r) && (r.status === "running" || r.status === "queued"));
		return [
			...own,
			...runningSurvivors()
				.map((d) => d.record)
				.filter((r) => r.status === "running"),
		];
	}

	/** Stop one top-level agent through the manager that owns it, this one or an orphan's. */
	function stopAgent(record: AgentRecord, by?: AgentRecord["stoppedBy"]): boolean {
		if (manager.getRecord(record.id) === record) return manager.abort(record.id, by);
		return !!runningSurvivors()
			.find((d) => d.record === record)
			?.abort(by);
	}

	/** What a stop that matched nothing lists instead: everything still running or queued. */
	function describeStoppable(): string {
		const lines = [
			...stoppableAgents().map((r) => `- ${r.id} @${r.alias ?? r.handle} (${r.status}): ${r.description}`),
			...[...getWorkflowTasks().values()]
				.filter(isLiveWorkflow)
				.map((t) => `- ${t.id} workflow "${t.meta!.name}" (${t.status})`),
		];
		return lines.length > 0 ? `Running or queued:\n${lines.join("\n")}` : "Nothing is running or queued.";
	}

	/**
	 * Stop every running or queued top-level agent, survivor, and workflow run
	 * (whose agents stop with it). A scheduled job that has not fired is not
	 * running, so it is untouched. The human-side stop: records stay unmarked.
	 */
	function stopAllRunning(): { agents: number; workflows: number } {
		const runs = [...getWorkflowTasks().values()].filter(isLiveWorkflow);
		for (const task of runs) task.abortController.abort();
		return { agents: stoppableAgents().filter((record) => stopAgent(record)).length, workflows: runs.length };
	}

	return { stoppableAgents, stopAgent, describeStoppable, stopAllRunning };
}

// A queued result wait must observe completion before its held notification
// can fire, so successful waits can still suppress that redundant nudge.
const QUEUE_WAIT_POLL_MS = Math.floor(NOTIFICATION_HOLD_MS / 4);

interface ControlToolDeps {
	pi: ExtensionAPI;
	clock: Clock;
	/** Mark a settled result read: no completion notice, no failure badge. */
	markRead: (record: AgentRecord) => void;
	resolveSessionRef: (input: string, reach: SurvivorReach) => AgentRef;
	isShowCostEnabled: () => boolean;
	formatLifetimeTokens: (record: AgentRecord) => string;
	textResult: (message: string) => AgentToolResult;
	errorResult: (message: string) => AgentToolResult;
	stopActions: Pick<ReturnType<typeof createStopActions>, "stopAgent" | "describeStoppable">;
	registerToolReportingUsage: ExtensionAPI["registerTool"];
	agentTool: {
		execute(
			toolCallId: string,
			params: { resume: string; prompt: string; description: string; subagent_type: string; run_in_background: true },
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionToolContext,
		): Promise<AgentToolResult>;
	};
}

/** Register controls in their existing order, using the same usage wrapper as Agent. */
export function registerControlTools(deps: ControlToolDeps): void {
	const {
		pi,
		clock,
		markRead,
		resolveSessionRef,
		isShowCostEnabled,
		formatLifetimeTokens,
		textResult,
		errorResult,
		agentTool,
		registerToolReportingUsage,
		stopActions: { stopAgent, describeStoppable },
	} = deps;

	// ---- get_subagent_result tool ----

	registerToolReportingUsage(
		defineTool({
			name: SUBAGENT_TOOL_NAMES.GET_RESULT,
			label: "Get Agent Result",
			description:
				"Check status and retrieve a background agent's full result: use it while the agent runs, or when its completion notification says the result was truncated. Use the agent ID returned by Agent.",
			promptSnippet: "Check status and retrieve results from a background agent",
			parameters: Type.Object({
				agent_id: Type.String({
					description:
						"The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description: "If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				// A read reaches every survivor in the process, not only this session's.
				const ref = resolveSessionRef(params.agent_id, "process");
				if (ref.state === "saved" && ref.note) {
					const { note } = ref;
					const diagnostic = agentNotFound(note.id, note, true);
					if (note.fromSavedSession && (note.status === "running" || note.reopenRefusal))
						return errorResult(diagnostic);
					return textResult(diagnostic);
				}
				// A workflow run or its child, a tombstone with no note, or nothing at all.
				if (ref.state !== "live" && ref.state !== "queued" && ref.state !== "retained")
					return errorResult(agentNotFound(params.agent_id));
				const { record } = ref;

				// Wait for completion if requested. Cancellation stops only this tool
				// call; the background agent keeps running and remains unconsumed so its
				// completion notification can still be delivered.
				// Queued agents have no promise yet (it's created when the queue starts
				// them), so poll until they leave the queue, then await like a running one.
				if (params.wait && (record.status === "running" || record.status === "queued")) {
					while (record.status === "queued") {
						await abortable(
							record.startGate ?? new Promise<void>((resolve) => clock.setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
							signal,
						);
					}
					if (record.promise) await abortable(record.promise, signal);
				}

				const displayName = getDisplayName(record.type);
				const duration = formatDuration(record.startedAt, record.completedAt, clock.now());
				const tokens = formatLifetimeTokens(record);
				const contextPercent = getSessionContextPercent(record.session);
				const statsParts = [`Tool uses: ${record.toolUses}`];
				if (tokens) statsParts.push(tokens);
				if (isShowCostEnabled()) {
					const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
					if (costText) statsParts.push(`Cost: ${costText}`);
				}
				if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
				if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
				statsParts.push(`Duration: ${duration}`);

				let output =
					`Agent: ${record.id}\n` +
					`Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status, record.stoppedBy)} | ${statsParts.join(" | ")}\n` +
					`Description: ${record.description}\n` +
					(modelSelectionNote(record) ? `${modelSelectionNote(record)}\n` : "") +
					`\n`;

				if (record.status === "running") {
					output += "Agent is still running. Use wait: true or check back later.";
				} else if (record.status === "error") {
					output += `Error: ${record.error}${partialOutputSuffix(record)}`;
				} else {
					output += record.result?.trim() || "No output.";
				}

				// Mark result as consumed — suppresses the completion notification
				if (record.status !== "running" && record.status !== "queued") markRead(record);

				// Verbose: include full conversation
				if (params.verbose && record.session) {
					const conversation = getAgentConversation(record.session);
					if (conversation) {
						output += `\n\n--- Agent Conversation ---\n${conversation}`;
					}
				}

				return textResult(output);
			},
		}),
	);

	// ---- steer_subagent tool ----

	registerToolReportingUsage(
		defineTool({
			name: SUBAGENT_TOOL_NAMES.STEER,
			label: "Steer Agent",
			description:
				"Send a message to an agent. A running agent is interrupted after its current tool execution and the message is injected into its conversation, " +
				"allowing you to redirect its work mid-run. A queued agent gets the message when it starts. A finished agent is resumed in the background " +
				"with its full history and the message as its next prompt, exactly like Agent's resume; you will be notified when it completes. " +
				"A saved conversation can also reopen after a process restart. A live stopped record is not resumed. To end an agent's run, use stop_subagent: a steer is read only after its current tool call, and the agent may ignore it.",
			promptSnippet: "Send a message to a background agent: steer it mid-run, or resume it once finished",
			parameters: Type.Object({
				agent_id: Type.String({
					description:
						"The agent ID to message. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
				}),
				message: Type.String({
					description: "The message to send. This will appear as a user message in the agent's conversation.",
				}),
			}),
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				// An evicted id that was reopened answers as the record it continues under (#330).
				const ref = resolveSessionRef(params.agent_id, "session");
				/**
				 * Finished: continue it, as Claude Code's SendMessage does. An evicted
				 * record is known only by its note; Agent's resume reopens its session
				 * from disk or explains why it cannot.
				 */
				const resumeFinished = (finished: AgentRecord | EvictedNote, historical: boolean) => {
					if (finished.status === "stopped" && !historical) {
						return errorResult(
							`Agent "${finished.id}" was stopped (status: stopped). steer_subagent does not resume a stopped agent.`,
						);
					}
					// The Agent tool's own resume path, not a copy: same reopen, turn
					// budget, transcript and result. `subagent_type` is the record's own,
					// so its frontmatter governs as it does for an `@handle` resume. A
					// reopened id is passed as asked, so the result says what it continues as.
					return agentTool.execute(
						toolCallId,
						{
							resume: ref.latest === ref.requested ? finished.id : ref.requested,
							prompt: params.message,
							description: finished.description,
							subagent_type: finished.type,
							run_in_background: true,
						},
						signal,
						onUpdate,
						ctx,
					);
				};
				if (ref.state === "retained") return resumeFinished(ref.record, false);
				if (ref.state === "saved" && ref.note) return resumeFinished(ref.note, !!ref.note.fromSavedSession);
				// A workflow run or its child, a tombstone with no note, or nothing at all.
				if (ref.state !== "live" && ref.state !== "queued") return errorResult(agentNotFound(params.agent_id));
				const { record } = ref;
				// Running or queued under no Plan policy: a steer from a planning parent would drive edits.
				if (planSteerBlocked(record, pi.events)) return errorResult(planSteerRefusal(record.id));
				if (!record.session) {
					// Queued for a concurrency slot, or running with its session still
					// being built: either way the manager flushes `pendingSteers` into the
					// session the moment it exists, ahead of the first turn.
					if (!record.pendingSteers) record.pendingSteers = [];
					record.pendingSteers.push(params.message);
					pi.events.emit("subagents:steered", { id: record.id, message: params.message });
					return textResult(
						ref.state === "queued"
							? `Steering message queued for agent ${record.id} (status: queued). It will be delivered when the agent starts.`
							: `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
					);
				}

				try {
					await steerAgent(record.session, params.message);
					pi.events.emit("subagents:steered", { id: record.id, message: params.message });
					const tokens = formatLifetimeTokens(record);
					const contextPercent = getSessionContextPercent(record.session);
					const stateParts: string[] = [];
					if (tokens) stateParts.push(tokens);
					if (isShowCostEnabled()) {
						const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
						if (costText) stateParts.push(costText);
					}
					stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
					if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
					if (record.compactionCount)
						stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
					return textResult(
						`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
							`Current state: ${stateParts.join(" · ")}`,
					);
				} catch (err) {
					return errorResult(`Failed to steer agent: ${errorMessage(err)}`);
				}
			},
		}),
	);

	// ---- stop_subagent tool ----

	registerToolReportingUsage(
		defineTool({
			name: SUBAGENT_TOOL_NAMES.STOP,
			label: "Stop Agent",
			description:
				"Stop (cancel, kill) a running or queued background agent, or a SubagentWorkflow run by the run id it returned. " +
				"Use it when an agent's work is no longer wanted, e.g. a sibling already answered. Unlike steer_subagent, the agent cannot ignore it: " +
				"the run is aborted at once, its current tool call gets the abort signal, and it starts no further tool call. Its status becomes `stopped`. " +
				"A running agent's partial output, and any worktree branch with changes, arrives in one completion notice; a queued agent never starts. " +
				"A workflow stops with all of its agents. A stopped agent is not resumed. " +
				"A run of another extension's `workflow` tool is not ours to stop: use that extension's control (e.g. `workflow_control` with action `stop`).",
			promptSnippet: "Stop or cancel a running background agent or workflow",
			// Plan mode admits a trusted tool only on `readOnlyHint`. Stopping edits no
			// file and starts nothing; it only ends work already running, so it must
			// stay callable in Plan, where an orchestrator should still be able to
			// stand a fan-out down.
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			parameters: Type.Object({
				agent_id: Type.String({
					description:
						"The agent ID to stop. Its handle or name also works. A SubagentWorkflow run id stops that workflow run.",
				}),
			}),
			execute: async (_toolCallId, params) => {
				const ref = resolveSessionRef(params.agent_id, "session");
				const task = ref.state === "workflow-owned" && ref.owner.kind === "run" ? ref.owner.task : undefined;
				if (task && isLiveWorkflow(task)) {
					// Marked first: the run's notice is written when it settles, after this returns.
					task.stoppedBy = "parent";
					task.abortController.abort();
					return textResult(
						`Workflow "${task.meta!.name}" (${task.id}) stopped, with its agents. A completion notice follows.`,
					);
				}
				if (task && (task.status === "running" || task.status === "paused")) {
					// Told to stop, still unwinding: not "not running", and nothing more to do.
					return textResult(
						`Workflow "${task.meta!.name}" (${task.id}) is already stopping. A completion notice follows.`,
					);
				}
				if (ref.state !== "live" && ref.state !== "queued") {
					const note = ref.state === "saved" ? ref.note : undefined;
					if (note?.fromSavedSession) {
						return {
							...textResult(
								`${describeEvicted(note)}.\nNo live registry handle is available here; this historical entry cannot stop work.\n${describeStoppable()}`,
							),
							isError: true,
						};
					}
					// A workflow's child names nothing here: it stops with its run.
					const status = ref.state === "retained" ? ref.record.status : (task?.status ?? note?.status);
					const what = status
						? `"${params.agent_id}" is not running (status: ${status})`
						: `No agent or workflow "${params.agent_id}"`;
					return { ...textResult(`${what}, so there is nothing to stop.\n${describeStoppable()}`), isError: true };
				}
				const { record } = ref;
				const wasQueued = ref.state === "queued";
				stopAgent(record, "parent");
				const statsParts = [`Tool uses: ${record.toolUses}`];
				const tokens = formatLifetimeTokens(record);
				if (tokens) statsParts.push(tokens);
				return textResult(
					`Agent ${record.id} stopped.\n` +
						`Type: ${getDisplayName(record.type)} | Status: ${record.status} | ${statsParts.join(" | ")}\n` +
						`Description: ${record.description}\n\n` +
						(wasQueued
							? "It was still queued, so it never started and no completion notice follows."
							: "It starts no further tool call. One completion notice with its partial output follows."),
				);
			},
		}),
	);
}
