import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager, EvictedNote } from "../agent-manager.ts";
import { normalizeMaxTurns, resolveEffectiveMaxTurns, resolveRunTurnCap } from "../agent-runner.ts";
import { getAgentConfig, resolveSpawnType } from "../agent-types.ts";
import type { Clock } from "../clock.ts";
import { errorMessage } from "../error-message.ts";
import { SUBAGENT_CREATED_EVENT } from "../events.ts";
import { resolveTurnCap } from "../invocation-config.ts";
import {
	appendModelFallbackEntry,
	appendModelTierEntry,
	createOutputFilePath,
	ensureOutputFile,
	streamToOutputFile,
} from "../output-file.ts";
import type { checkSavedChild } from "../saved-child-session.ts";
import type { AgentRecord, AgentTombstone, JoinMode } from "../types.ts";
import type { AgentActivity, AgentWidget } from "../ui/agent-widget.ts";
import type { FleetList } from "../ui/fleet-list.ts";
import { createActivityTracker } from "./activity.ts";

/**
 * The turn budget for resuming `record`, from its OWN type — resume ignores
 * `subagent_type`. Use the tighter of its definition and the requested
 * (or original invocation) cap, falling back to the project default (#368).
 */
export function resumeTurnLimit(record: AgentRecord, explicit?: number): number | undefined {
	// Preserve 0 until the runner resolves it: normalizing it here would turn
	// an explicit unlimited budget into "unspecified" and restore the spawn cap.
	return resolveRunTurnCap(explicit ?? record.invocation?.maxTurns, getAgentConfig(record.type)?.maxTurns);
}

/** Why `reopenEvicted` did not reopen; `type-unavailable` keeps the tombstone, `session-gone` drops it. */
type ReopenFailure =
	| { reason: "session-gone" }
	| { reason: "type-unavailable"; type: string }
	| { reason: "spawn-failed"; message: string };

/** The one wording both reopen callers use, `target` being `@handle` or `agent "<id>"`. */
export function couldNotResume(target: string, failure: ReopenFailure): string {
	switch (failure.reason) {
		case "session-gone":
			return `Could not resume ${target} — its session is gone.`;
		case "type-unavailable":
			return `Could not resume ${target} — the ${failure.type} agent is no longer available.`;
		case "spawn-failed":
			return `Could not resume ${target}: ${failure.message}`;
	}
}

interface TopLevelLaunchDeps {
	pi: ExtensionAPI;
	manager: AgentManager;
	clock: Clock;
	agentActivity: Map<string, AgentActivity>;
	reloadCustomAgents: () => void;
	savedSessionChecker: (
		ctx: ExtensionContext,
	) => (note: EvictedNote, file: string) => ReturnType<typeof checkSavedChild>;
	getDefaultJoinMode: () => JoinMode;
	joinTurnGroup: (id: string, joinMode: JoinMode) => void;
	eventFields: (record: AgentRecord) => Record<string, unknown>;
	readonly widget: Pick<AgentWidget, "markRunning" | "ensureTimer" | "update">;
	readonly fleet: Pick<FleetList, "ensureTimer" | "update">;
}

/** Keep the existing top-level launch paths together until their callers migrate. */
export function createTopLevelLaunch(deps: TopLevelLaunchDeps) {
	const {
		pi,
		manager,
		clock,
		agentActivity,
		reloadCustomAgents,
		savedSessionChecker,
		getDefaultJoinMode,
		joinTurnGroup,
		eventFields,
	} = deps;

	// Process-external callers may supply arbitrary options. Nested ownership and
	// config-root metadata are internal capabilities issued only by scoped tools.
	/**
	 * Resolve the agent type and spawn. Trusts its options — every caller must
	 * either be in-process or have gone through `spawnTopLevel` first.
	 */
	const spawnResolved = (piRef: ExtensionAPI, ctxRef: ExtensionContext, type: string, prompt: string, options: any) => {
		// Cross-extension callers get the same dispatch contract as the LLM (#183).
		// The RPC layer already throws for an unresolvable model rather than falling
		// back silently; a bad agent type should not be quieter. Throws become error
		// envelopes at the RPC boundary. Reload first so an agent file added mid
		// session is spawnable here too, not only through the Agent tool.
		reloadCustomAgents();
		const dispatch = resolveSpawnType(type);
		if (!dispatch.ok) throw new Error(dispatch.message);
		// Every programmatic spawn lands here — cross-extension RPC, both `@handle`
		// mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
		// none came through the Agent tool, which is where the UI activity tracker is
		// otherwise created. Without one the widget and FleetView have no tool name
		// and no turn count, so the row reads `thinking…` for the agent's whole life
		// while the header's tool-use count climbs beside it (#181). Double-tracking
		// is not possible: the Agent tool calls `manager.spawn` directly. The tracker
		// callbacks are the funnel's own — a caller's are not honoured, since a
		// half-wired tracker renders worse than none.
		//
		// The turn limit is resolved rather than read off `options`, which a mention
		// spawn deliberately omits so the agent's own config can decide: a tracker
		// built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
		// Like the tool's own, it is a prediction — editing the agent file mid-run
		// leaves the displayed ceiling stale.
		const maxTurns = resolveTurnCap(options?.maxTurns, getAgentConfig(dispatch.type)?.maxTurns);
		const { state, callbacks } = createActivityTracker(
			// `maxTurns` is already the tighter caller/definition cap: only the default and 0 remain.
			resolveEffectiveMaxTurns(maxTurns),
			undefined,
			clock,
		);
		// Repaints are left to the manager's `onStart` callback, which already starts
		// the widget/fleet timers for agents that enter this way.
		const id = manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, maxTurns, ...callbacks });
		agentActivity.set(id, state);
		return id;
	};

	const spawnTopLevel = (piRef: ExtensionAPI, ctxRef: ExtensionContext, type: string, prompt: string, options: any) => {
		const safeOptions = { ...(options ?? {}) };
		delete safeOptions.parentAgentId;
		// Internal too: a forged value would hide an RPC-spawned agent inside
		// someone else's workflow, and take it out of the concurrency pool with it.
		delete safeOptions.workflowId;
		delete safeOptions.rosterWorkflowRun;
		delete safeOptions.depth;
		delete safeOptions.maxSubagentDepth;
		delete safeOptions.configCwd;
		delete safeOptions.configProjectTrusted;
		// Also internal: it names a transcript directory, so a forged value would
		// be a path-traversal primitive.
		delete safeOptions.rootSessionId;
		// Worse than rootSessionId: this one names a file to OPEN and replay as a
		// conversation. Only the mention dispatcher may set it, and only from a
		// path this extension itself recorded — never from anything a caller sent.
		delete safeOptions.resumeSessionFile;
		// Bypasses handle allocation, so a forged value would duplicate a live
		// agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
		delete safeOptions.reclaim;
		// Would make the new agent claim an evicted agent's id on lifecycle events.
		delete safeOptions.previousId;
		// Every spawn through here is DETACHED — the caller gets an id back and
		// awaits nothing. A forged `blocking` would charge it to the foreground
		// pool and could defer it behind a queue whose gate nobody is holding.
		delete safeOptions.blocking;
		// The spawn path's own disclosure; a caller-supplied one could hide a
		// fallback or invent one. The runner reports the real outcome itself.
		delete safeOptions.modelFallback;
		delete safeOptions.modelSelection;
		delete safeOptions.modelTier;
		delete safeOptions.previousModelTier;
		delete safeOptions.previousModelFallback;
		return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
	};

	/**
	 * Reopen an evicted agent's conversation from its session file. An ordinary
	 * spawn carrying that file, so the new record picks up the widget, fleet row,
	 * transcript and completion notification unchanged, and `reclaim` hands it
	 * back the names the tombstone was holding. Always detached.
	 *
	 * Shared by `@handle message` and the Agent tool's `resume` of an evicted id
	 * (#330); they differ only in how they report the outcome, see
	 * `couldNotResume`. The evicted id is linked to the new one before the first
	 * await, so a second resume of the old id in the same turn finds the live
	 * record instead of reopening the file twice.
	 */
	async function reopenEvicted(
		ctx: ExtensionContext,
		entry: AgentTombstone,
		prompt: string,
		opts: { maxTurns?: number } = {},
	): Promise<{ ok: true; id: string } | { ok: false; failure: ReopenFailure }> {
		const saved = manager.getEvictedNote(entry.id);
		if (saved?.fromSavedSession) {
			// Bound to the transcript startup validated: a link retargeted since must not redirect it.
			const checked = savedSessionChecker(ctx)(
				{ ...saved, canonicalSessionFile: entry.sessionFile },
				saved.sessionFile!,
			);
			if ("refusal" in checked) return { ok: false, failure: { reason: "spawn-failed", message: checked.refusal } };
			entry = { ...entry, sessionFile: checked.file };
		}
		// Checked here rather than left to SessionManager.open: that runs inside
		// runAgent, whose rejection lands on the record as an agent error, not in
		// the catch below. A `/new` in another pi window or a manual delete makes
		// the conversation unrecoverable (Claude Code's `not_reachable`), so drop
		// the entry — a row that can only ever fail is worse than none — and say
		// so rather than quietly sending this message to an unrelated agent.
		if (!existsSync(entry.sessionFile)) {
			manager.dropTombstone(entry.handle);
			return { ok: false, failure: { reason: "session-gone" } };
		}

		// The Agent tool deliberately falls back to general-purpose for a type it
		// cannot resolve (#183), which covers a deleted file AND a merely
		// disabled one. A resume must not inherit that: reopening this
		// conversation under a different agent's prompt and tools is not
		// continuing it, and the new record would re-tombstone under the
		// substitute, so the handle would never find its way back.
		reloadCustomAgents();
		const dispatch = resolveSpawnType(entry.type);
		if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
			// The tombstone stays: re-enabling the agent makes the handle work
			// again, which a drop would foreclose.
			return { ok: false, failure: { reason: "type-unavailable", type: entry.type } };
		}

		let id: string | undefined;
		try {
			// spawnResolved, not spawnTopLevel: the latter strips
			// `resumeSessionFile` and `reclaim` as untrusted. This path is the
			// exception — both come from a tombstone this extension wrote.
			id = spawnResolved(pi, ctx, dispatch.type, prompt, {
				description: entry.description,
				maxTurns: opts.maxTurns,
				reclaim: { handle: entry.handle, alias: entry.alias },
				previousId: entry.id,
				resumeSessionFile: entry.sessionFile,
				// Historical disclosures never replace the continuation's current selection.
				...(entry.modelFallback ? { previousModelFallback: entry.modelFallback } : {}),
				...(entry.modelTier ? { previousModelTier: entry.modelTier } : {}),
				isBackground: true,
			});
			manager.linkSuccessor(entry.id, id);
			// The agent may still be starting — wait, so a startup failure lands in
			// the catch below instead of being announced as a resume.
			await manager.awaitStartup(id);
			// The tombstone deliberately stays. `resolveMention` prefers the live
			// record holding these same names, so it cannot shadow the resume — and
			// if this run dies before establishing its own session, the original
			// transcript is still the right thing for the next mention to reopen.
			// Once the resumed record is evicted it overwrites this entry in place,
			// keyed by the same handle, so nothing accumulates.
			return { ok: true, id };
		} catch (err) {
			// The type is already settled above, so what is left is a spawn-time
			// failure: a strict worktree-isolation error, an unusable cwd.
			// A run that never started is no successor: the old id reopens again next time.
			if (id !== undefined) manager.unlinkSuccessor(entry.id);
			return { ok: false, failure: { reason: "spawn-failed", message: errorMessage(err) } };
		}
	}

	/**
	 * Launch a detached resume of an existing agent and wire everything a
	 * re-running agent needs: transcript anchoring, activity tracking, join-mode
	 * batching, the widget/fleet refresh, and the `subagents:created` event.
	 *
	 * Shared by the Agent tool's `resume` + `run_in_background` branch and the
	 * `@handle message` prompt mention — they differ only in how they report the
	 * outcome. Returns the record, or undefined when the manager refused because
	 * the agent is still running (see AgentManager.resume).
	 *
	 * Callers must have already established that the record has a session.
	 */
	async function startBackgroundResume(
		ctx: ExtensionContext,
		existing: AgentRecord,
		prompt: string,
		opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
	): Promise<AgentRecord | undefined> {
		const id = existing.id;
		const priorSettleSeq = existing.settleSeq;
		const resumeSeq = manager.nextSequence();
		// A resume always runs detached, and a detached run joins by the default mode.
		const joinMode = getDefaultJoinMode();
		// Assigned unconditionally: the completion notification carries this as
		// `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
		// id left by the spawn that created the record. Keeping it would point the
		// orchestrator's new result at a tool call that was answered runs ago.
		existing.toolCallId = opts.toolCallId;
		existing.joinMode = joinMode;
		// Reuse the agent's transcript rather than starting a fresh one: the
		// path is deterministic per agent+session, so writing an initial entry
		// would truncate the previous run's turns (see ensureOutputFile).
		if (opts.outputTranscript) {
			// Keep a transcript that still exists where it is: an ENOSPC/EROFS retry (#900) may have
			// relocated it under the temp root, and a recomputed path would start an empty file elsewhere.
			if (!existing.outputFile || !existsSync(existing.outputFile)) {
				existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
			}
			ensureOutputFile(existing.outputFile);
			// A fresh transcript for a later resume must still say what the agent ran on.
			if (existing.modelFallback) appendModelFallbackEntry(existing.outputFile, id, existing.modelFallback);
			if (existing.modelTier) appendModelTierEntry(existing.outputFile, id, existing.modelTier);
		}
		// Anchor streaming past the turns already on disk, captured BEFORE the
		// run starts. The resumed prompt lands as an ordinary user message at
		// this index, so it is written exactly once.
		// Both callers resume only a record that still holds its session.
		const transcriptAnchor = existing.session!.messages.length;

		const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(
			normalizeMaxTurns(opts.maxTurns),
			undefined,
			clock,
		);
		// resumeAgent has no onSessionCreated — the session predates this run —
		// so seed it directly, or the widget shows no context % for the agent.
		bgState.session = existing.session;

		// No `signal`: a background spawn deliberately omits it, and a detached
		// resume must behave the same. Passing it would abort this agent when
		// the parent turn is interrupted (user Esc), while agents started with
		// run_in_background in that same turn keep going.
		const record = await manager.resume(id, prompt, undefined, {
			isBackground: true,
			maxTurns: opts.maxTurns,
			onTurnEnd: bgCallbacks.onTurnEnd,
			onTextDelta: bgCallbacks.onTextDelta,
			onModelCall: bgCallbacks.onModelCall,
			onToolActivity: bgCallbacks.onToolActivity,
			onAssistantUsage: bgCallbacks.onAssistantUsage,
			// Fires when the run actually starts — immediately, or on queue
			// drain. Wiring it here (rather than after resume() returns) means a
			// resume stopped while still queued never started streaming, so
			// there is no subscription left behind for a later run to trip over.
			onStarted: () => {
				const rec = manager.getRecord(id);
				if (rec?.session && rec.outputFile) {
					rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
				}
			},
		});
		if (!record) return undefined;

		// Only a resume from an Agent call belongs to that call's turn.
		if (opts.toolCallId !== undefined) joinTurnGroup(id, joinMode);

		agentActivity.set(id, bgState);
		// This agent already finished once, so the widget holds a finished-age
		// for it that is past the linger limit — without clearing it, the
		// resumed run's ✓/✗ line never renders and the agent just vanishes.
		deps.widget.markRunning(id);
		deps.widget.ensureTimer();
		deps.widget.update();
		deps.fleet.ensureTimer();
		deps.fleet.update();

		// Resume ignores subagent_type (the record keeps the type it was
		// spawned with), so report the record's own identity — a "created"
		// event carrying the caller's type would re-register the agent under
		// the wrong one in cross-extension mirrors keyed by id.
		pi.events.emit(SUBAGENT_CREATED_EVENT, {
			id,
			type: existing.type,
			description: existing.description,
			isBackground: true,
			...(record.status === "queued" && priorSettleSeq !== undefined
				? { queuedAfterSettleSeq: priorSettleSeq, queuedResumeSeq: resumeSeq }
				: {}),
			...eventFields(existing),
		});

		return record;
	}

	return { spawnTopLevel, reopenEvicted, startBackgroundResume };
}
