/**
 * `/loop <interval> <prompt>`: re-send a prompt into this session on a timer.
 *
 * Per-process and in-memory only: loops die with the session (`session_shutdown`, `/new`) and are
 * never persisted. A tick that finds the agent busy is skipped, never queued. Ticks do not fire
 * while a `/goal` is active (they would fight over the same idle gaps) or Plan mode is on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../child.ts";
import { type Clock, realClock, type TimerHandle } from "../clock.ts";
import type { KitConfig } from "../config.ts";
import { coordination, planModeActive, watchQuota, watchStops } from "../shared.ts";
import { CACHE_WARM_MS, decideTick, describeLoop, formatInterval, type LoopEntry, parseLoopArgs } from "./state.ts";

export function register(pi: ExtensionAPI, _config: KitConfig, clock: Clock = realClock): void {
	const shared = coordination(pi);
	const loops = new Map<string, { entry: LoopEntry; timer: TimerHandle }>();
	let lastCtx: ExtensionContext | undefined;
	let nextId = 1;

	const stop = (id: string): void => {
		const loop = loops.get(id);
		if (!loop) return;
		loop.timer.cancel();
		loops.delete(id);
	};
	const stopAll = (): void => {
		for (const id of [...loops.keys()]) stop(id);
	};

	const tick = (id: string): void => {
		const loop = loops.get(id);
		const ctx = lastCtx;
		if (!loop || !ctx) return;
		try {
			const decision = decideTick({
				isChild: isChildSession(pi),
				busy: !ctx.isIdle() || ctx.hasPendingMessages() || shared.quotaParked.size > 0,
				goalActive: shared.goalActive,
				planMode: planModeActive(ctx),
				loop: loop.entry,
			});
			if (!decision.fire) {
				if (decision.reason !== "paused") loop.entry.skipped++;
				return;
			}
			loop.entry.runs++;
			pi.sendUserMessage(loop.entry.prompt, { expandPromptTemplates: true });
			if (loop.entry.runs >= loop.entry.maxRuns) {
				stop(id);
				ctx.ui.notify(`loop ${id} finished: ${loop.entry.maxRuns} runs`, "info");
			}
		} catch {
			// Stale context: the session this loop belonged to is gone.
			stopAll();
		}
	};

	pi.on("session_start", (_event, ctx) => {
		stopAll();
		lastCtx = ctx;
	});
	pi.on("session_shutdown", () => stopAll());
	pi.on("before_agent_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	const pauseLoops = (reason: string, ctx: ExtensionContext): void => {
		let paused = 0;
		for (const { entry } of loops.values()) {
			if (entry.paused) continue;
			entry.paused = reason;
			paused++;
		}
		if (paused > 0) ctx.ui.notify(`loop paused (${paused}): ${reason}. /loop resume after resolving it`, "warning");
	};

	watchQuota(pi, (reason, ctx) => {
		if (!isChildSession(pi)) pauseLoops(reason, ctx);
	});

	watchStops(pi, (outcome, ctx) => {
		if (outcome !== "error" || isChildSession(pi)) return;
		pauseLoops("provider error", ctx);
	});

	const select = (target: string): string[] =>
		target === "all" ? [...loops.keys()] : loops.has(target) ? [target] : [];

	/** Registered from `session_start` so subagent (child) sessions never get `/loop`; see `/goal`. */
	const registerLoopCommand = (): void => {
		pi.registerCommand("loop", {
			description:
				"Re-send a prompt on a timer: /loop <30s|5m|1h> <prompt> [--max N] | list | stop [id|all] | resume [id|all]",
			getArgumentCompletions: (prefix) => {
				const items = ["list", "stop", "resume"]
					.filter((name) => name.startsWith(prefix))
					.map((name) => ({ value: name, label: name }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				if (isChildSession(pi)) return;
				lastCtx = ctx;
				shared.reconcilePlanMode?.(ctx);
				const command = parseLoopArgs(args);
				if (command.kind === "error") return ctx.ui.notify(command.message, "error");
				if (command.kind === "list") {
					const lines = [...loops.values()].map(({ entry }) => describeLoop(entry));
					return ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "no loops", "info");
				}
				if (command.kind === "stop" || command.kind === "resume") {
					if (command.kind === "resume" && shared.quotaParked.size > 0)
						return ctx.ui.notify("refused: quota dispatch is still parked. Resolve it before resuming loops", "error");
					const ids = select(command.target);
					if (ids.length === 0)
						return ctx.ui.notify(command.target === "all" ? "no loops" : `no loop ${command.target}`, "error");
					for (const id of ids) {
						if (command.kind === "stop") stop(id);
						else delete loops.get(id)?.entry.paused;
					}
					return ctx.ui.notify(`${command.kind === "stop" ? "stopped" : "resumed"} ${ids.join(", ")}`, "info");
				}
				if (command.kind !== "start") return;
				const id = String(nextId++);
				const entry: LoopEntry = {
					id,
					intervalMs: command.intervalMs,
					prompt: command.prompt,
					maxRuns: command.maxRuns,
					...(shared.quotaParked.size > 0 ? { paused: "quota parked" } : {}),
					runs: 0,
					skipped: 0,
				};
				const timer = clock.setInterval(() => tick(id), command.intervalMs);
				loops.set(id, { entry, timer });
				ctx.ui.notify(`loop ${id}: every ${formatInterval(command.intervalMs)}, max ${command.maxRuns} runs`, "info");
				if (command.intervalMs > CACHE_WARM_MS) {
					ctx.ui.notify(
						`loop ${id}: interval above 5m, every tick pays a cold prompt cache (use 5m or less to keep it warm)`,
						"warning",
					);
				}
			},
		});
	};

	pi.on("session_start", () => {
		if (!isChildSession(pi)) registerLoopCommand();
	});
}
