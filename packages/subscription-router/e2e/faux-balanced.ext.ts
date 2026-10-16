/** Actual installed-Pi balanced routing fixture. No network or real credentials. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { UsageService, type UsageSnapshot } from "../src/usage.js";
import { register } from "./faux.js";

export default function fauxBalanced(pi: ExtensionAPI): void {
	const scenario = process.env.SPIKE_BALANCED;
	const snapshots = new Map<string, UsageSnapshot>();
	const resetAt = Date.now() + 3_600_000;
	const set = (provider: string, usedPercent: number, status: UsageSnapshot["status"] = "available") =>
		snapshots.set(provider, {
			provider,
			status,
			windows: [{ name: "weekly", usedPercent, scope: "provider", resetAt, durationMs: 3_600_000 }],
			retrievedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});
	class FauxUsage extends UsageService {
		override peek(provider: string) {
			return snapshots.get(provider);
		}
		override async get(_ctx: unknown, provider: string): Promise<UsageSnapshot> {
			return (
				snapshots.get(provider) ?? {
					provider,
					status: "unavailable",
					windows: [],
					retrievedAt: Date.now(),
					expiresAt: Date.now(),
				}
			);
		}
	}
	const usage = new FauxUsage();
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subscription-router.shared")] = {
		usage,
		tracker: new ExhaustionTracker(),
	};
	set("spike-a", 80);
	set("spike-b", 60);
	set("spike-c", 20);
	let prompt = 0;
	pi.on("before_agent_start", () => {
		if (scenario === "balanced-switch") {
			prompt++;
			// Switch to A initially; the 20% mathematical boundary stays A, then >20% switches to B.
			set("spike-a", 50);
			set("spike-b", prompt === 1 ? 70 : prompt === 2 ? 40 : 30);
			set("spike-c", 95);
		} else if (scenario === "balanced-fallback" || scenario === "balanced-unmeasured") {
			set("spike-a", 1, "stale");
			set("spike-b", 60);
			snapshots.delete("spike-c");
		}
	});
	pi.registerTool({
		name: "change_quota",
		label: "Change quota",
		description: "Change the faux cached quota mid-turn",
		parameters: Type.Object({}),
		async execute() {
			if (scenario === "balanced-unmeasured") set("spike-b", 100);
			else {
				set("spike-a", 0);
				set("spike-c", scenario === "balanced-blocked" ? 100 : 99);
			}
			return { content: [{ type: "text", text: "quota changed" }], details: undefined };
		},
	});
	for (const [provider, id] of [
		["spike-a", "sonnet-a"],
		["spike-b", "terra-b"],
		["spike-c", "third-c"],
	] as const) {
		const core = register(pi, provider, id);
		const responses = Array.from({ length: 10 }, () => fauxAssistantMessage(`ANSWER ${provider}`));
		if (
			(provider === "spike-c" && (scenario === "balanced-sticky" || scenario === "balanced-blocked")) ||
			(provider === "spike-b" && scenario === "balanced-unmeasured")
		) {
			responses[0] = fauxAssistantMessage(fauxToolCall("change_quota", {}), { stopReason: "toolUse" });
		}
		core.setResponses(responses);
	}
}
