/**
 * Expanded Footer Extension
 *
 * Replaces the stock footer's cryptic stats line (`↑138 ↓42k R8.7M W400k CH99.8%
 * $3.933 21.5%/1.0M (auto)`) with clear word labels (`in 138 out 42k read 8.7M
 * write 400k hit 99.8% cost $3.933 ctx 21.5%/1.0M (auto)`) whenever the terminal
 * is wide enough to show them without truncating anything, and falls back
 * automatically to the original compact abbreviations otherwise -- so it never
 * wraps or overflows on a narrower terminal (e.g. a work laptop) while still
 * reading clearly on a roomy one (e.g. an ultrawide monitor).
 *
 * Always on: registers ctx.ui.setFooter() from session_start, no toggle command.
 * cwd/branch/session-name line and the extension-status line are untouched.
 *
 * A quota row sits between the stats line and the statuses once the subscription
 * router answers `router:rpc:usage` (polled in the background, see lib/footer-quota.ts).
 * Without the router the row stays hidden.
 *
 * `hit N%` carries a prompt-cache marker (`warm`/`cold`, compact `w`/`c`) and, after a hit-rate
 * drop, a cause tag (see lib/footer-cache.ts). A one-shot timer repaints when the cache goes cold.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { analyzeCache, cacheTtlSeconds, formatCacheMarker } from "../lib/footer-cache.ts";
import { createQuotaPoller, formatQuotaRow, type PollerDeps } from "../lib/footer-quota.ts";

/** Format token counts for compact footer display. Mirrors the stock footer's formatTokens. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Replace home directory with ~. Mirrors the stock footer's formatCwdForFooter. */
function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(
	totals: UsageTotals,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } },
) {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** One clock for deferred startup, quota cadence/staleness, and cache expiry. */
export type FooterClock = Required<
	Pick<PollerDeps, "now" | "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">
>;

const realClock: FooterClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Mount the expanded footer; omitted options preserve the real clock and timers. */
export function createExpandedFooter(options: { clock?: FooterClock } = {}): ExtensionFactory {
	const clock = options.clock ?? realClock;
	return (pi: ExtensionAPI) => {
		let stopQuota: (() => void) | undefined;
		const stopPoller = () => {
			stopQuota?.();
			stopQuota = undefined;
		};

		pi.on("session_shutdown", async () => stopPoller());

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			stopPoller();

			ctx.ui.setFooter((tui, theme, footerData) => {
				const unsub = footerData.onBranchChange(() => tui.requestRender());
				stopPoller();
				const quota = createQuotaPoller({
					events: pi.events,
					onChange: () => tui.requestRender(),
					now: () => clock.now(),
					setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
					clearTimeout: (handle) => clock.clearTimeout(handle),
					setInterval: (fn, ms) => clock.setInterval(fn, ms),
					clearInterval: (handle) => clock.clearInterval(handle),
				});
				// Local extensions can mount before package session_start handlers run.
				// Wait one event-loop tick so the router has its session context before refreshing.
				const startTimer = clock.setTimeout(() => quota.start(), 0);
				const disposeQuota = () => {
					clock.clearTimeout(startTimer);
					quota.dispose();
				};
				stopQuota = disposeQuota;
				let coldTimer: unknown;
				let coldTimerAt: number | undefined;
				const scheduleCold = (coldAt: number | undefined) => {
					if (coldAt === coldTimerAt) return;
					clock.clearTimeout(coldTimer);
					coldTimerAt = coldAt;
					coldTimer = undefined;
					if (coldAt === undefined) return;
					// Idle footers never repaint on their own; wake once when the cache expires.
					coldTimer = clock.setTimeout(() => tui.requestRender(), Math.max(0, coldAt - clock.now()) + 50);
					if (
						coldTimer &&
						typeof coldTimer === "object" &&
						"unref" in coldTimer &&
						typeof coldTimer.unref === "function"
					)
						coldTimer.unref();
				};

				return {
					dispose() {
						unsub();
						clock.clearTimeout(coldTimer);
						disposeQuota();
						if (stopQuota === disposeQuota) stopQuota = undefined;
					},
					invalidate() {},
					render(width: number): string[] {
						// --- Line 1: cwd / branch / session name (unchanged from stock) ---
						let pwd = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE || homedir());
						const branch = footerData.getGitBranch();
						if (branch) pwd = `${pwd} (${branch})`;
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) pwd = `${pwd} • ${sessionName}`;
						const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

						// --- Usage totals across the whole session (unchanged from stock) ---
						const totals = emptyTotals();
						for (const entry of ctx.sessionManager.getEntries()) {
							if (entry.type === "usage") {
								addUsage(totals, entry.usage);
							} else if (entry.type === "message" && entry.message.role === "assistant") {
								addUsage(totals, entry.message.usage);
							} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
								addUsage(totals, entry.message.usage);
							} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
								addUsage(totals, entry.usage);
							}
						}

						const cache = analyzeCache(
							ctx.sessionManager.getBranch(),
							clock.now(),
							cacheTtlSeconds(ctx.model?.promptCache),
						);
						scheduleCold(cache.coldAt);
						const latestCacheHitRate = cache.hitRate;

						const contextUsage = ctx.getContextUsage();
						const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
						const contextPercentValue = contextUsage?.percent ?? 0;
						const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

						// Subscription detection: kimi-coding is subscription-backed despite using
						// API-key auth (per stock footer); everything else uses OAuth as the proxy
						// for "subscription", since ExtensionContext has no direct equivalent of
						// ModelRuntime.isUsingSubscription().
						const usingSubscription = ctx.model
							? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
							: false;

						// Auto-compact is on by default; ExtensionContext doesn't expose the live
						// toggle, so this always shows "(auto)" rather than tracking the real state.
						const autoSuffix = " (auto)";
						const contextDisplayRaw =
							contextPercent === "?"
								? `?/${formatTokens(contextWindow)}${autoSuffix}`
								: `${contextPercent}%/${formatTokens(contextWindow)}${autoSuffix}`;
						let contextSegmentPlain = contextDisplayRaw;
						let contextSegmentFull = `ctx ${contextDisplayRaw}`;
						if (contextPercentValue > 90) {
							contextSegmentPlain = theme.fg("error", contextSegmentPlain);
							contextSegmentFull = theme.fg("error", contextSegmentFull);
						} else if (contextPercentValue > 70) {
							contextSegmentPlain = theme.fg("warning", contextSegmentPlain);
							contextSegmentFull = theme.fg("warning", contextSegmentFull);
						}

						function buildParts(tier: "full" | "compact"): string[] {
							const full = tier === "full";
							const parts: string[] = [];
							if (totals.input)
								parts.push(full ? `in ${formatTokens(totals.input)}` : `↑${formatTokens(totals.input)}`);
							if (totals.output)
								parts.push(full ? `out ${formatTokens(totals.output)}` : `↓${formatTokens(totals.output)}`);
							if (totals.cacheRead)
								parts.push(full ? `read ${formatTokens(totals.cacheRead)}` : `R${formatTokens(totals.cacheRead)}`);
							if (totals.cacheWrite)
								parts.push(full ? `write ${formatTokens(totals.cacheWrite)}` : `W${formatTokens(totals.cacheWrite)}`);
							if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
								const marker = formatCacheMarker(cache, tier);
								parts.push(
									full
										? `hit ${latestCacheHitRate.toFixed(1)}%${marker}`
										: `CH${latestCacheHitRate.toFixed(1)}%${marker}`,
								);
							}
							if (totals.cost || usingSubscription) {
								const costStr = `$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
								parts.push(full ? `cost ${costStr}` : costStr);
							}
							parts.push(full ? contextSegmentFull : contextSegmentPlain);
							return parts;
						}

						const minPadding = 2;
						const modelName = ctx.model?.id || "no-model";
						let rightSideBase = modelName;
						if (ctx.model?.reasoning) {
							const level = ctx.thinkingLevel || "off";
							rightSideBase = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
						}

						function buildLine(tier: "full" | "compact"): string {
							let statsLeft = buildParts(tier).join(" ");
							let statsLeftWidth = visibleWidth(statsLeft);
							if (statsLeftWidth > width) {
								statsLeft = truncateToWidth(statsLeft, width, "...");
								statsLeftWidth = visibleWidth(statsLeft);
							}

							let rightSide = rightSideBase;
							if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
								const withProvider = `(${ctx.model.provider}) ${rightSideBase}`;
								if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
									rightSide = withProvider;
								}
							}
							const rightSideWidth = visibleWidth(rightSide);
							const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

							let statsLine: string;
							if (totalNeeded <= width) {
								statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
							} else {
								const availableForRight = width - statsLeftWidth - minPadding;
								if (availableForRight > 0) {
									const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
									const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
									statsLine = statsLeft + pad + truncatedRight;
								} else {
									statsLine = statsLeft;
								}
							}

							const dimStatsLeft = theme.fg("dim", statsLeft);
							const remainder = statsLine.slice(statsLeft.length);
							const dimRemainder = theme.fg("dim", remainder);
							return dimStatsLeft + dimRemainder;
						}

						// Prefer the full word-label tier when it fits untruncated alongside the
						// model name; otherwise fall back to the compact tier (which has its own
						// truncation fallback, guaranteeing the line always fits `width`).
						const fullStatsLeft = buildParts("full").join(" ");
						const fitsUntruncated = visibleWidth(fullStatsLeft) + minPadding + visibleWidth(rightSideBase) <= width;
						const statsLine = buildLine(fitsUntruncated ? "full" : "compact");

						const lines = [pwdLine, statsLine];

						// --- Quota row: only once the router has answered at least once ---
						const quotaState = quota.getState();
						if (quotaState) {
							const colorize = (color: "warning" | "error" | "dim", text: string) => theme.fg(color, text);
							const plainFull = formatQuotaRow(quotaState, "full", (_color, text) => text);
							const tier = visibleWidth(plainFull) <= width ? "full" : "compact";
							const row = formatQuotaRow(quotaState, tier, colorize);
							lines.push(truncateToWidth(row, width, theme.fg("dim", "...")));
						}

						// --- Line 3: extension statuses (unchanged from stock) ---
						const extensionStatuses = footerData.getExtensionStatuses();
						if (extensionStatuses.size > 0) {
							const sortedStatuses = Array.from(extensionStatuses.entries())
								.sort(([a], [b]) => a.localeCompare(b))
								.map(([, text]) =>
									text
										.replace(/[\r\n\t]/g, " ")
										.replace(/ +/g, " ")
										.trim(),
								);
							const statusLine = sortedStatuses.join(" ");
							lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
						}

						return lines;
					},
				};
			});
		});
	};
}

export default createExpandedFooter();
