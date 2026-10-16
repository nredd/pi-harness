/** Command output that works in every pi mode, shared by `/diff` and `/stats`. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type Level = "info" | "warning" | "error";

/**
 * Show `text` where the mode can. `ctx.ui.notify` is a no-op in print and json mode (no UI), so print
 * writes to stdout (errors to stderr) and json adds one display message of `customType` to the stream.
 */
export function say(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	customType: string,
	text: string,
	level: Level,
): void {
	if (ctx.mode === "print") {
		(level === "info" ? process.stdout : process.stderr).write(`${text}\n`);
	} else if (ctx.mode === "json") {
		pi.sendMessage({ customType, content: text, display: true }, { triggerTurn: false });
	} else {
		ctx.ui.notify(text, level);
	}
}
