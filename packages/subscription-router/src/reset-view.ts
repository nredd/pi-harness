/** Native, width-bounded cached schedule screen; completion only requests a read or closes. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Key, matchesKey, ScrollView, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { UsageService, UsageSnapshot } from "./usage.js";

/** Escape detaches this refresh caller; the usage service retains ownership of shared reads. */
export async function refreshSchedules(
	ctx: ExtensionCommandContext,
	usage: Pick<UsageService, "get">,
	providers: readonly string[],
): Promise<UsageSnapshot[]> {
	const read = (signal: AbortSignal | undefined) =>
		Promise.all(providers.map((provider) => usage.get(ctx, provider, { force: true, signal })));
	if (ctx.mode !== "tui") return read(ctx.signal);
	return ctx.ui.custom<UsageSnapshot[]>((tui, theme, _kb, done) => {
		const loader = new CancellableLoader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			"Refreshing usage schedules (read-only; Escape cancels)",
		);
		void read(loader.signal).then(done);
		return loader;
	});
}

/** Reuse Pi's wrapping and scroll state without owning a terminal, timer, or asynchronous work. */
export class ResetView {
	private readonly scroll: ScrollView;

	constructor(
		text: string,
		private readonly rows: () => number,
		private readonly requestRender: () => void,
		private readonly done: (refresh: boolean) => void,
	) {
		this.scroll = new ScrollView(new Text(text, 0, 0));
	}

	invalidate(): void {
		this.scroll.invalidate();
	}

	handleInput(data: string): void {
		if (data === "r") this.done(true);
		else if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.done(false);
		else if (data === "j" || matchesKey(data, Key.down)) this.scroll.scrollBy(1);
		else if (data === "k" || matchesKey(data, Key.up)) this.scroll.scrollBy(-1);
		else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-this.scroll.viewportHeight);
		this.requestRender();
	}

	render(width: number): string[] {
		const lines = this.scroll.render(Math.max(1, width));
		const height = Math.max(1, this.rows() - 1);
		this.scroll.updateLayout(lines.length, height, this.requestRender);
		return [
			...lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height),
			truncateToWidth("j/k scroll | PgUp/PgDn | r refresh (read-only) | q/Esc close", Math.max(1, width)),
		];
	}
}
