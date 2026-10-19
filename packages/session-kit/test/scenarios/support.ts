/** Real-session fixtures shared by the Vitest and Bun scenario suites. No fake Pi or live config. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "@earendil-works/pi-coding-agent/testing";
import { defaultConfig, type Feature, type KitConfig } from "../../src/config.ts";
import { GOAL_ENTRY, GOAL_NUDGE_TYPE, type GoalSnapshot } from "../../src/goal/state.ts";
import { createSessionKit } from "../../src/index.ts";

export const EVIDENCE = "uv run pytest tests: 12 passed";

/** Enable only the features under test, without reading the user's agent directory. */
export function configFor(...features: Feature[]): KitConfig {
	const config = defaultConfig();
	for (const feature of Object.keys(config.features) as Feature[])
		config.features[feature] = features.includes(feature);
	return config;
}

/** Scratch workspace with file-backed sessions and explicitly configured real kit factories. */
export class ScenarioFixture {
	readonly root = mkdtempSync(join(tmpdir(), "pi-kit-scenario-"));
	readonly sessions = join(this.root, "sessions");
	readonly agentDir = join(this.root, "agent");
	private harnesses: Harness[] = [];

	/** Build and bind a fresh real session, or reopen a caller-supplied manager. */
	async start(config: KitConfig, options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			cwd: this.root,
			sessionManager: SessionManager.create(this.root, this.sessions),
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createSessionKit({ config, agentDir: this.agentDir, monitorRoot: join(this.root, "monitors") }),
			],
			...options,
		});
		this.harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print", uiContext: createTestUiContext() });
		return harness;
	}

	/** Dispose sessions before deleting caller-owned files. Safe after an earlier harness cleanup. */
	cleanup(): void {
		for (const harness of this.harnesses.reverse()) harness.cleanup();
		this.harnesses = [];
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** One scripted model tool request, executed by the real host. */
export function tool(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** Completion with evidence, shared by the goal continuation scenarios. */
export function complete(evidence = EVIDENCE) {
	return tool("goal_update", { status: "complete", evidence });
}

/** Persisted goal snapshots in branch order, including explicit clears. */
export function goalStates(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === GOAL_ENTRY ? [(entry.data as GoalSnapshot).goal] : [],
		);
}

/** Hidden goal messages as committed by the host settle path, not synthetic extension events. */
export function nudges(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_NUDGE_TYPE);
}

/** Newly emitted assistant prose, excluding restored history and tool-call-only responses. */
export function spoken(harness: Harness): string[] {
	return harness
		.eventsOfType("message_end")
		.filter((event) => event.message.role === "assistant")
		.map((event) => getMessageText(event.message))
		.filter(Boolean);
}

/** Tool results as persisted after extension tool_result hooks (including injected rules). */
export function outcomes(harness: Harness, name: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === name
			? [{ isError: message.isError, text: getMessageText(message) }]
			: [],
	);
}

/** Require a session file rather than silently testing an in-memory restore. */
export function sessionFile(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a file-backed session");
	return file;
}
