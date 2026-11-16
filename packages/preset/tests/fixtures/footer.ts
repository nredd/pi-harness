/** Real core host and deterministic ports shared by Vitest and Bun footer scenarios. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createInteractiveHarness,
	type InteractiveHarness,
	type InteractiveHarnessOptions,
} from "@earendil-works/pi-coding-agent/testing/interactive";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { fauxAssistantMessage } from "@nredd/pi-test-lib/harness";
import { createExpandedFooter } from "../../src/index.ts";

import { UsageBus } from "./usage.ts";

export { snapshot, UsageBus } from "./usage.ts";

export interface Turn {
	age: number;
	read: number;
	input: number;
	write?: number;
	model?: string;
}
export const WARM: Turn[] = [
	{ age: 60, read: 0, input: 100, write: 3000 },
	{ age: 5, read: 3000, input: 100 },
];
export const COLD: Turn[] = [
	{ age: 3700, read: 0, input: 100, write: 3000 },
	{ age: 3600, read: 3000, input: 100 },
];
export const DROP_WARM: Turn[] = [
	{ age: 60, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100 },
];
export const DROP_COLD: Turn[] = [
	{ age: 3700, read: 3000, input: 100 },
	{ age: 3600, read: 0, input: 3100 },
];
export const DROP_IDLE: Turn[] = [
	{ age: 2000, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100 },
];
export const DROP_SWITCH: Turn[] = [
	{ age: 60, read: 3000, input: 100 },
	{ age: 5, read: 0, input: 3100, model: "alt" },
];

/** Caller-owned scratch history and one real interactive host. */
export class FooterFixture {
	readonly root = realpathSync(mkdtempSync(join(tmpdir(), "pi-footer-")));
	readonly clock = new FakeClock(Date.parse("2026-10-19T12:00:00Z"));
	readonly usage = new UsageBus(this.clock);
	host: InteractiveHarness | undefined;

	/** Persist the live scenarios' history through SessionManager, then mount the real footer. */
	async start(
		options: InteractiveHarnessOptions & {
			turns?: Turn[];
			name?: string;
			compaction?: boolean;
			ttl?: number;
			absent?: boolean;
			deferStart?: boolean;
		} = {},
	): Promise<InteractiveHarness> {
		const { turns = [], name, compaction, ttl, absent, deferStart, ...hostOptions } = options;
		const cwd = hostOptions.cwd ?? join(this.root, "project");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, join(this.root, "sessions"));
		if (name) manager.appendSessionInfo(name);
		let first: string | null = null;
		for (const [i, turn] of turns.entries()) {
			if (compaction && i === turns.length - 1) manager.appendCompaction("s", first, 1);
			const at = this.clock.now() - turn.age * 1000;
			const id = manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `q${i}` }],
				timestamp: at - 1000,
			});
			first ??= id;
			const message = fauxAssistantMessage(`reply ${i}`, { timestamp: at });
			message.model = turn.model ?? "main";
			message.provider = "faux";
			message.usage = {
				input: turn.input,
				output: 20,
				cacheRead: turn.read,
				cacheWrite: turn.write ?? 0,
				totalTokens: turn.input + turn.read + (turn.write ?? 0) + 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
			};
			manager.appendMessage(message);
		}
		const file = manager.getSessionFile();
		this.host = await createInteractiveHarness({
			cwd,
			columns: 120,
			rows: 40,
			models: [{ id: "main" }, { id: "alt" }],
			sessionManager: file && turns.length ? SessionManager.open(file) : manager,
			...hostOptions,
			extensionFactories: [
				createExpandedFooter({ clock: this.clock, timeZone: "UTC" }),
				...(absent ? [] : [this.usage.extension]),
				...(hostOptions.extensionFactories ?? []),
			],
		});
		if (ttl !== undefined)
			await this.host.harness.session.setModel({ ...this.host.harness.getModel(), promptCache: { short: ttl } });
		await this.host.settle();
		if (!deferStart && !absent) {
			await this.advance(0);
			await this.usage.waitForFirstRequest();
			await this.host.settle();
		}
		return this.host;
	}

	/** Advance extension time, then flush real renderer scheduling and xterm writes. */
	async advance(ms: number): Promise<void> {
		this.clock.advance(ms);
		await this.requireHost().settle();
	}

	/** Require a mounted host rather than silently omitting assertions. */
	requireHost(): InteractiveHarness {
		if (!this.host) throw new Error("Footer host not started");
		return this.host;
	}

	/** Real lifecycle disposal before removing caller-owned session files. */
	async dispose(): Promise<void> {
		await this.host?.dispose();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** First quota row (the one carrying the `Quota left:`/`Left:` lead); duplicates fail instead of hiding leaked output. */
export function quotaRow(host: InteractiveHarness): string {
	const rows = host.viewport().filter((row) => /^\s*(Quota left:|Left:)/.test(row));
	if (rows.length !== 1) throw new Error(`Expected one quota row: ${host.viewport().join("\n")}`);
	return rows[0] ?? "";
}

/** Every on-screen quota row (one when it fits, one per provider when wrapped), each provider-led. */
export function quotaRows(host: InteractiveHarness): string[] {
	return host.viewport().filter((row) => /^\s*(?:Quota left: |Left: )?(?:Anthropic|Anth|OpenAI|OAI) /.test(row));
}

/** Provider segment from any rendered tier or wrapped layout. */
export function providerSegment(host: InteractiveHarness, provider: "anthropic" | "openai-codex"): string {
	const rows = quotaRows(host);
	const pattern = provider === "anthropic" ? /(?:Anthropic|Anth) (.*?)(?:\s*\||$)/ : /(?:OpenAI|OAI) (.*)$/;
	for (const row of rows) {
		const match = row.match(pattern);
		if (match) return match[1] ?? "";
	}
	throw new Error(`Missing ${provider}: ${rows.join("\n")}`);
}

/** Displayed window values, not poller internals. */
export function values(host: InteractiveHarness, provider: "anthropic" | "openai-codex"): string[] {
	return [...providerSegment(host, provider).matchAll(/(\d+%|--)/g)].map((match) => match[0]);
}
