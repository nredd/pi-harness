import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelFallback, ModelRegistry } from "../model-resolver.ts";
import type { ModelSelection } from "../model-selection.ts";
import type { TierDisclosure } from "../model-tiers.ts";
import type { QuotaBlock } from "../quota-admission.ts";
import type { AgentInvocation, IsolationMode, JoinMode, ScheduledSubagent, ThinkingLevel } from "../types.ts";
import type { CompiledSchema } from "../workflow/json-schema.ts";

export type LaunchKind = "tool" | "external" | "mention" | "reopen" | "scheduled" | "nested" | "workflow" | "wizard";

/** What the caller's session offers. Deciders never see ExtensionContext. */
export interface LaunchContext {
	cwd: string;
	parentModel: Model<any> | undefined;
	modelRegistry: ModelRegistry;
	sessionId: string | undefined;
}

export type LaunchOwner =
	| { kind: "session" }
	| {
			kind: "agent";
			parentAgentId: string;
			depth: number;
			maxSubagentDepth: number;
			configCwd: string;
			configProjectTrusted: boolean;
			homeDir?: string;
	  }
	| { kind: "workflow"; workflowId: string; execution: ExecutionBinding };

export interface ExecutionBinding {
	readonly signal: AbortSignal;
	isRunning(): boolean;
}

export interface LaunchIdentity {
	type: string;
	description: string;
	name?: string;
	owner: LaunchOwner;
	rootSessionId?: string;
	cwd?: string;
	/** Reserved for the reopen decider. */
	continuation?: {
		sessionFile: string;
		reclaim: { handle: string; alias?: string };
		previousId: string;
		previousModelTier?: TierDisclosure;
		previousModelFallback?: ModelFallback;
	};
}

export interface LaunchHow {
	model?: Model<any> | string;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	isolation?: IsolationMode;
	structuredOutput?: CompiledSchema;
}

export interface ResolvedHow extends Omit<LaunchHow, "model"> {
	selection: ModelSelection;
	admission: "admitted" | "at-start";
	invocation: AgentInvocation;
}

export type DeliveryMode =
	| { mode: "foreground"; signal?: AbortSignal; onQueued?: (id: string, ahead: number) => void }
	| { mode: "background"; notify: { toolCallId?: string; joinMode: JoinMode } }
	| { mode: "detached" };

export type ActivityBinding =
	| { kind: "tracked"; surface: "session" | "workflow"; turnCap: number | undefined; onStreamUpdate?: () => void }
	| { kind: "untracked"; reason: "nested-reports-through-parent" };

export type TranscriptBinding =
	| { kind: "write"; configCwd: string; sessionId: string; prompt: string }
	| { kind: "none"; reason: "frontmatter-off" | "non-tool-start" | "owner-reports" };

/** Observers run after the tracker; they do not replace it. */
export interface LaunchObservers {
	onSessionCreated?: (session: AgentSession) => void;
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	/** Id is known before queueing, admission or worktree creation. */
	onPrepared?: (id: string) => void;
	onStarted?: (id: string) => void;
	onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
}

export interface ResolvedDelivery {
	mode: DeliveryMode;
	queue: "pool" | "bypass";
	activity: ActivityBinding;
	transcript: TranscriptBinding;
	observers: LaunchObservers;
}

export interface LaunchNote {
	readonly kind: "type-fallback" | "scope-warning";
	readonly message: string;
}

type ActivityFor<K> = K extends "nested"
	? Extract<ActivityBinding, { kind: "untracked" }>
	: Extract<ActivityBinding, { kind: "tracked" }>;

export interface LaunchDecision<K extends LaunchKind = LaunchKind> {
	readonly kind: K;
	readonly prompt: string;
	readonly identity: LaunchIdentity;
	readonly how: ResolvedHow;
	readonly delivery: ResolvedDelivery & { activity: ActivityFor<K> };
	readonly notes: readonly LaunchNote[];
}

export type LaunchRefusalCode =
	| "type-unknown"
	| "type-disabled"
	| "type-not-allowed"
	| "type-unavailable"
	| "depth-exceeded"
	| "background-unsupported"
	| "model-unresolved"
	| "model-out-of-scope"
	| "session-gone"
	| "saved-session-refused"
	| "plan-mode"
	| "quota-blocked";

export interface LaunchRefusal {
	readonly code: LaunchRefusalCode;
	readonly message: string;
	/** Only present for quota-blocked; the caller may park the request. */
	readonly block?: QuotaBlock;
}

export type LaunchOutcome<K extends LaunchKind = LaunchKind> =
	| { ok: true; decision: LaunchDecision<K> }
	| { ok: false; refusal: LaunchRefusal };

/** Resume is a relaunch of a retained record. */
export interface ResumeDecision {
	readonly kind: "resume";
	readonly id: string;
	readonly prompt: string;
	readonly maxTurns: number | undefined;
	readonly delivery: Pick<ResolvedDelivery, "mode" | "activity" | "observers"> & {
		transcript: { kind: "append" } | { kind: "none" };
	};
}

export interface ScheduledLaunchRequest {
	kind: "scheduled";
	job: ScheduledSubagent;
	selection: ModelSelection;
}

/** External requests cannot set internal ownership, continuation, or selection fields. */
export interface ExternalSpawnOptions extends LaunchHow {
	name?: string;
	description?: string;
	cwd?: string;
	isBackground?: boolean;
}

export interface ExternalLaunchRequest {
	kind: "external";
	type: string;
	prompt: string;
	options: ExternalSpawnOptions;
}
