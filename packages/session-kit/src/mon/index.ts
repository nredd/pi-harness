/** Command/lifecycle shell. Production registration awaits the published shared sampler adapter. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../clock.ts";
import { MonView } from "./component.ts";
import { MonPoll, type MonSource } from "./poll.ts";

export interface MonOptions {
	/** Required: no fake or fallback production collector. Invoked only while the TUI opens. */
	createSource: () => MonSource;
	clock?: Clock;
}

/** No persistence, model tools, notifications to model context, or collection at registration. */
export function registerMon(pi: ExtensionAPI, options: MonOptions): void {
	let closeActive: (() => Promise<void>) | undefined;
	let generation = 0;
	let ownership = Promise.resolve();
	const serialize = (action: () => Promise<void>): Promise<void> => {
		const next = ownership.then(action);
		ownership = next.catch(() => {});
		return next;
	};
	const reset = (): Promise<void> => {
		generation++;
		return serialize(async () => {
			await closeActive?.();
		});
	};
	pi.on("session_shutdown", reset);
	pi.on("session_start", reset);
	pi.registerCommand("mon", {
		description: "Live local CPU, memory and busy processes (read only)",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/mon requires an interactive terminal", "warning");
				return;
			}
			const requestedGeneration = generation;
			let interaction: Promise<void> | undefined;
			let poll: MonPoll | undefined;
			let ownClose: (() => Promise<void>) | undefined;
			try {
				await serialize(async () => {
					if (requestedGeneration !== generation) return;
					await closeActive?.();
					if (requestedGeneration !== generation) return;
					let markReady!: () => void;
					const ready = new Promise<void>((resolve) => {
						markReady = resolve;
					});
					interaction = ctx.ui.custom<void>(
						(tui, theme, _kb, done) => {
							if (requestedGeneration !== generation) {
								done();
								return { render: () => [], invalidate: () => {} };
							}
							let closed = false;
							const close = (): Promise<void> => {
								const cleanup = poll?.dispose() ?? Promise.resolve();
								if (!closed) {
									closed = true;
									done();
								}
								return cleanup;
							};
							ownClose = close;
							closeActive = close;
							const view = new MonView({
								theme,
								rows: () => tui.terminal.rows,
								requestRender: () => tui.requestRender(),
								onClose: () => {
									void close();
								},
							});
							poll = new MonPoll(options.createSource(), (sample) => view.update(sample), options.clock);
							poll.start();
							markReady();
							return {
								render: (width: number) => {
									try {
										return view.render(width);
									} catch (error) {
										void close();
										throw error;
									}
								},
								invalidate: () => view.invalidate(),
								handleInput: (data: string) => view.handleInput(data),
								dispose: () => poll?.dispose(),
							};
						},
						{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
					);
					// Hold ownership until even a deferred UI factory has installed its closer.
					await Promise.race([ready, interaction]);
				});
				await interaction;
			} finally {
				await poll?.dispose();
				if (closeActive === ownClose) closeActive = undefined;
			}
		},
	});
}
