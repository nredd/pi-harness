import type { Clock } from "../clock.ts";
import { applyModelCallEvent, type ModelCallEvent } from "../model-call.ts";
import type { AgentActivity } from "../ui/agent-widget.ts";
import type { LifetimeUsage } from "../usage.ts";

export function createAgentActivityMap(): Map<string, AgentActivity> {
	return new Map<string, AgentActivity>();
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
export function createActivityTracker(
	maxTurns: number | undefined,
	onStreamUpdate: (() => void) | undefined,
	clock: Clock,
) {
	const state: AgentActivity = {
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 1,
		maxTurns,
		responseText: "",
		session: undefined,
	};

	const callbacks = {
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
			if (activity.type === "start") {
				state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
			} else {
				for (const [key, name] of state.activeTools) {
					if (name === activity.toolName) {
						state.activeTools.delete(key);
						break;
					}
				}
				state.toolUses++;
			}
			onStreamUpdate?.();
		},
		onTextDelta: (_delta: string, fullText: string) => {
			state.responseText = fullText;
			onStreamUpdate?.();
		},
		onTurnEnd: (turnCount: number) => {
			state.turnCount = turnCount;
			onStreamUpdate?.();
		},
		onModelCall: (event: ModelCallEvent) => {
			state.modelCall = applyModelCallEvent(state.modelCall, event, clock.now());
			onStreamUpdate?.();
		},
		onSessionCreated: (session: any) => {
			state.session = session;
		},
		// Spend is accumulated on the AgentRecord (agent-manager), which is what
		// every surface reads; this callback exists here only to repaint on it.
		onAssistantUsage: (_usage: LifetimeUsage) => {
			onStreamUpdate?.();
		},
	};

	return { state, callbacks };
}
