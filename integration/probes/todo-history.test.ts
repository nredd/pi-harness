import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Record actual `todo` historical call renders when the TUI host invokes them. */
export default function todoHistoryProbe(pi: ExtensionAPI): void {
	const output = process.env.PI_TODO_HISTORY_PROBE;
	if (!output) return;

	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		if (toolName !== "todo" || !renderers?.renderCall) return renderers;
		return {
			...renderers,
			renderCall(args, theme, context) {
				const component = renderers.renderCall?.(args, theme, context);
				const snapshot = (context.state as { taskSnapshot?: { tasks: Array<{ id: number; subject: string }> } })
					.taskSnapshot;
				if (
					component &&
					args &&
					typeof args === "object" &&
					(args as { action?: unknown }).action === "update" &&
					(args as { id?: unknown }).id === 1 &&
					snapshot
				) {
					appendFileSync(
						output,
						`${JSON.stringify({
							subject: snapshot.tasks.find((task) => task.id === 1)?.subject,
							rendered: component.render(200).join("\n"),
						})}\n`,
					);
				}
				return component;
			},
		};
	});
}
