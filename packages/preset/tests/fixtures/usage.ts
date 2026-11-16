/** Router protocol fixtures shared by headless and interactive footer scenarios. */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { STATUS } from "@nredd/pi-test-lib/terminal";
import { USAGE_CHANNEL } from "../../src/footer-quota.ts";

/** Router-shaped usage snapshot, with provider-scoped names and unknown-provider validation. */
export function snapshot(
	provider: string,
	used: readonly [number, number] | undefined,
	now: number,
	status = "available",
	resetAts: readonly (number | undefined)[] = [],
) {
	const names =
		provider === "anthropic" ? ["five_hour", "seven_day"] : provider === "openai-codex" ? ["5h", "7d"] : undefined;
	if (!names) throw new Error(`Unknown provider: ${provider}`);
	return {
		provider,
		status,
		expiresAt: now + 3_600_000,
		windows: used
			? names.map((name, i) => ({ name, scope: "provider", usedPercent: used[i], resetAt: resetAts[i] }))
			: [],
	};
}

function withWindows<T extends { windows: unknown[] }>(
	base: T,
	windows: readonly Record<string, unknown>[] | undefined,
): T {
	return windows ? { ...base, windows: [...windows] } : base;
}

/** Usage-bus double only; the real footer owns parsing, polling, timeout and stale recovery. */
export class UsageBus {
	anthropic: readonly [number, number] | undefined = [20, 40];
	codex: readonly [number, number] | undefined = [30, 50];
	statuses: [string, string] = ["available", "available"];
	/** Raw router windows replacing the anthropic fixture windows (e.g. no `five_hour`); `anthropic` still gates presence. */
	anthropicWindows: readonly Record<string, unknown>[] | undefined = undefined;
	/** Raw router windows replacing the codex fixture windows (spans, provenance); `codex` still gates presence. */
	codexWindows: readonly Record<string, unknown>[] | undefined = undefined;
	/** Router `resetAt` epoch ms per window ([5h-or-first, weekly]); unset means the router reported none. */
	anthropicResets: readonly (number | undefined)[] = [];
	codexResets: readonly (number | undefined)[] = [];
	mode: "ok" | "hang" | "error" = "ok";
	ready = false;
	requests: { at: number; ready: boolean; refresh: unknown; reply: (body?: unknown) => void }[] = [];
	private readonly firstRequest = deferred<void>();
	readonly clock: FakeClock;
	constructor(clock: FakeClock) {
		this.clock = clock;
	}

	/** Omit absent providers entirely, as the router does, instead of inventing windows. */
	envelope(): unknown {
		return {
			success: true,
			data: {
				snapshots: [
					...(this.anthropic
						? [
								withWindows(
									snapshot("anthropic", this.anthropic, this.clock.now(), this.statuses[0], this.anthropicResets),
									this.anthropicWindows,
								),
							]
						: []),
					...(this.codex
						? [
								withWindows(
									snapshot("openai-codex", this.codex, this.clock.now(), this.statuses[1], this.codexResets),
									this.codexWindows,
								),
							]
						: []),
				],
				blocks: [],
			},
		};
	}

	/** Attach to Pi's real event bus and mark readiness in the later startup handler. */
	private emit: ((channel: string, body: unknown) => void) | undefined;
	readonly extension: ExtensionFactory = (pi) => {
		this.emit = (channel, body) => pi.events.emit(channel, body);
		const off = pi.events.on(USAGE_CHANNEL, (raw: unknown) => {
			const request = raw as { requestId: string; refresh?: unknown };
			const reply = (body: unknown = this.envelope()) =>
				this.emit?.(`${USAGE_CHANNEL}:reply:${request.requestId}`, body);
			this.requests.push({ at: this.clock.now(), ready: this.ready, refresh: request.refresh, reply });
			this.firstRequest.resolve();
			if (this.mode === "ok") reply();
			else if (this.mode === "error") reply({ success: false, error: "fixture failure" });
		});
		pi.on("session_start", (_event, ctx) => {
			this.ready = true;
			ctx.ui.setStatus("fixture", STATUS);
		});
		pi.on("session_shutdown", () => {
			this.ready = false;
			off();
		});
	};

	/** Await the first protocol request before inspecting the asynchronously repainted quota row. */
	waitForFirstRequest(): Promise<void> {
		return this.firstRequest.promise;
	}
}
