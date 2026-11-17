/** Fork-only interactive host. Headless fixtures must never import this module. */
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createInteractiveHarness,
	type InteractiveHarness,
	type InteractiveHarnessOptions,
} from "@earendil-works/pi-coding-agent/testing/interactive";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { STATUS } from "@nredd/pi-test-lib/terminal";
import type { KitConfig } from "../../src/config.ts";
import { createSessionKit } from "../../src/index.ts";
import { ScenarioFixture } from "./session.ts";

export const RESIZES = [
	[60, 24],
	[320, 60],
	[80, 30],
	[240, 50],
	[60, 40],
] as const;

/** Real interactive host with an observed (not replaced) overlay mount and deterministic kit clock. */
export class TerminalFixture extends ScenarioFixture {
	readonly clock = new FakeClock(Date.parse("2026-10-18T12:00:00Z"));
	host: InteractiveHarness | undefined;
	private mounted: ReturnType<typeof deferred<void>> | undefined;
	private command: Promise<void> | undefined;

	/** Mount the real editor, footer and extension UI. Histories/config remain under this scratch root. */
	async startTerminal(config: KitConfig, options: InteractiveHarnessOptions = {}): Promise<InteractiveHarness> {
		const observe: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setStatus("fixture", STATUS);
				const custom = ctx.ui.custom.bind(ctx.ui);
				ctx.ui.custom = (factory, opts) =>
					custom((...args) => {
						const component = factory(...args);
						this.mounted?.resolve();
						return component;
					}, opts);
			});
		};
		this.host = await createInteractiveHarness({
			cwd: this.root,
			columns: 120,
			rows: 40,
			sessionManager: SessionManager.create(this.root, this.sessions),
			settings: { retry: { enabled: false } },
			...options,
			extensionFactories: [
				createSessionKit({ config, agentDir: this.agentDir, clock: this.clock }),
				observe,
				...(options.extensionFactories ?? []),
			],
		});
		// VirtualTerminal sends chunks verbatim; ProcessTerminal uses this parser before TUI input.
		// Flush incomplete input because fixture calls supply whole keys (including a lone Escape).
		const input = this.host.input;
		const parser = new StdinBuffer();
		parser.on("data", input);
		this.host.input = (data) => {
			parser.process(data);
			for (const sequence of parser.flush()) input(sequence);
		};
		return this.host;
	}

	/** Wait for the real custom factory to mount, rather than polling terminal frames or sleeping. */
	async open(command: string, raw = false): Promise<void> {
		const host = this.requireHost();
		this.mounted = deferred<void>();
		if (raw) {
			host.input(command);
			host.input("\r");
			await this.mounted.promise;
			await host.settle();
			return;
		}
		this.command = host.harness.session.prompt(command);
		const outcome = await Promise.race([
			this.mounted.promise.then(() => "mounted"),
			this.command.then(() => "finished"),
		]);
		if (outcome !== "mounted") throw new Error(`No overlay for ${command}`);
		await host.settle();
	}

	/** Deliver raw terminal input and flush the real host scheduler without advancing wall time. */
	async key(data: string): Promise<void> {
		const host = this.requireHost();
		host.input(data);
		this.clock.advance(0);
		await host.settle();
	}

	/** Close the overlay and wait for the command that owned it to return. */
	async close(key = "q"): Promise<void> {
		await this.key(key);
		await this.command;
		this.command = undefined;
		await this.requireHost().settle();
	}

	/** Complete real host disposal before removing file-backed sessions. */
	async dispose(): Promise<void> {
		await this.host?.dispose();
		this.cleanup();
	}

	/** Reject accidental use before startup. */
	requireHost(): InteractiveHarness {
		if (!this.host) throw new Error("Terminal fixture has not started");
		return this.host;
	}
}
