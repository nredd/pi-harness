/** Single-fork interactive sessions on the locked core host, never the installed Pi. */
import { join } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { VirtualTerminal } from "@earendil-works/pi-tui/testing";
import { expect } from "vitest";
import { isolateStackHome, loadFork } from "./support.ts";

export type TodoArgs = Parameters<typeof fauxToolCall>[1];
export type TodoStep = Parameters<Harness["setResponses"]>[0][number];
export const FINAL = "ALL ROWS DONE";

/** Script one real tool call; the host still validates and executes it. */
export function todo(args: TodoArgs): TodoStep {
	return fauxAssistantMessage([fauxToolCall("todo", args)], { stopReason: "toolUse" });
}

/** Own the isolated home, file-backed session and actual emulator through failure-safe teardown. */
export class TodoFixture {
	private host: InteractiveHarness | undefined;
	private terminal: VirtualTerminal | undefined;
	private constructor(private readonly home: Awaited<ReturnType<typeof isolateStackHome>>) {}

	/** Hold the stack's process-scoped wake assertions before importing the real fork. */
	static async create(): Promise<TodoFixture> {
		return new TodoFixture(await isolateStackHome());
	}

	/** Load only rpiv-todo; an optional pass-through renderer observer is reapplied on real reload. */
	async start(columns = 140, rows = 60, observe?: (pi: ExtensionAPI) => void): Promise<InteractiveHarness> {
		const factory = await loadFork("rpiv-todo");
		const cwd = join(this.home.root, "work");
		this.terminal = new VirtualTerminal(columns, rows);
		this.host = await createInteractiveHarness({
			cwd,
			terminal: this.terminal,
			sessionManager: SessionManager.create(cwd, join(this.home.root, "sessions")),
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [
				async (pi) => {
					await factory(pi);
					observe?.(pi);
				},
			],
		});
		return this.host;
	}

	/** Abort/drain the real runtime before disposing the caller-owned emulator and home. */
	async dispose(): Promise<void> {
		try {
			await this.host?.dispose();
		} finally {
			this.terminal?.dispose();
			await this.home.cleanup();
		}
	}
}

/** Await the real turn and scheduler, never a timeout or a guessed number of event-loop ticks. */
export async function turn(host: InteractiveHarness, steps: TodoStep[]): Promise<void> {
	host.harness.setResponses([...steps, fauxAssistantMessage(FINAL)]);
	await host.harness.session.prompt("go");
	await host.harness.session.waitForIdle();
	await host.settle();
	expect(host.harness.getPendingResponseCount()).toBe(0);
	expect(host.harness.eventsOfType("tool_execution_end").map((event) => event.isError)).not.toContain(true);
	expect(host.viewport().join("\n")).toContain(FINAL);
}

/** Locate an actual painted row, rejecting absent targets instead of clicking arbitrary coordinates. */
export function rowOf(host: InteractiveHarness, pattern: RegExp): number {
	const rows = host.viewport();
	const row = rows.findIndex((text) => pattern.test(text));
	if (row < 0) throw new Error(`Missing row ${pattern}:\n${rows.join("\n")}`);
	return row;
}

/** Raw SGR press/release at zero-based coordinates, through the real mouse dispatch path. */
export async function click(host: InteractiveHarness, column: number, row: number): Promise<void> {
	host.input(`\x1b[<0;${column + 1};${row + 1}M`);
	host.input(`\x1b[<0;${column + 1};${row + 1}m`);
	await host.settle();
}

/** Raw SGR wheel at zero-based coordinates, one rendered frame per gesture. */
export async function wheel(host: InteractiveHarness, column: number, row: number, down: boolean): Promise<void> {
	host.input(`\x1b[<${down ? 65 : 64};${column + 1};${row + 1}M`);
	await host.settle();
}
