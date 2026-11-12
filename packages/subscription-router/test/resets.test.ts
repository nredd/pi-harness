import { describe, expect, it } from "vitest";
import { formatResets } from "../src/resets.js";
import type { UsageSnapshot } from "../src/usage.js";

const NOW = Date.parse("2026-11-01T05:30:00Z");
const snapshot: UsageSnapshot = {
	provider: "example",
	status: "available",
	retrievedAt: NOW,
	expiresAt: NOW + 60_000,
	windows: [
		{
			name: "weekly",
			usedPercent: 75,
			resetAt: NOW + 3_600_000,
			durationMs: 604_800_000,
			spanSource: "assumed",
			scope: "model",
			families: ["sample"],
		},
	],
};

describe("reset schedule presentation", () => {
	it("keeps family scope, usage and guessed spans explicit across DST", () => {
		const text = formatResets(["example"], () => snapshot, NOW, "America/New_York");
		expect(text).toContain("fresh");
		expect(text).toContain("75% used");
		expect(text).toContain("families: sample");
		expect(text).toContain("7d (assumed)");
		expect(text).toContain("GMT-04:00");
		expect(text).toContain("GMT-05:00");
		expect(text).toContain("America/New_York");
		expect(text).toContain("2026-11-01T06:30:00.000Z");
		expect(text).toContain("in 60m");
	});
	it("retains expired snapshots without inventing replenishment", () => {
		const text = formatResets(["example"], () => snapshot, NOW + 3_600_000);
		expect(text).toContain("stale");
		expect(text).toContain("75% used");
		expect(text).toContain("reset passed; needs verification");
		expect(text).not.toContain("0% used");
	});
	it("separates unknown, unavailable and failed inspection from unintegrated offers", () => {
		const text = formatResets(
			["missing", "unavailable", "error"],
			(provider) =>
				provider === "missing"
					? undefined
					: {
							...snapshot,
							provider,
							status: provider === "error" ? "error" : "unavailable",
							windows: [],
						},
			NOW,
		);
		expect(text).toContain("missing: unknown (not checked)");
		expect(text).toContain("unavailable: unavailable");
		expect(text).toContain("error: error");
		expect(text).toContain("Offer discovery: unavailable in Pi (not integrated)");
		expect(text).toContain("Free redemption: unavailable in Pi (not integrated)");
		expect(text).toContain("Balance, eligibility, expiry and history: unknown, not verified zero");
		expect(text).toContain("/usage -> Redeem reset");
	});
	it("handles absent and invalid times and durations without throwing", () => {
		const text = formatResets(
			["example"],
			() => ({
				...snapshot,
				retrievedAt: Number.NaN,
				windows: [
					{ name: "provider", usedPercent: 100, scope: "provider", resetAt: Number.POSITIVE_INFINITY },
					{ name: "unknown", usedPercent: 10, scope: "model", durationMs: -1 },
					{ name: "reported", usedPercent: 5, scope: "provider", durationMs: 18_000_000, spanSource: "reported" },
				],
			}),
			NOW,
		);
		expect(text).toContain("last checked: unknown");
		expect(text).toContain("reset: unknown");
		expect(text).toContain("families: unknown");
		expect(text).toContain("span: unknown");
		expect(text).toContain("5h (reported)");
	});
	it("shows empty state, messages, unusual spans and unknown provenance", () => {
		expect(formatResets([], () => undefined, NOW)).toContain("No subscription providers in use");
		const text = formatResets(
			["example"],
			() => ({
				...snapshot,
				status: "stale",
				message: "Backing off.",
				windows: [{ name: "custom", usedPercent: 25, scope: "provider", durationMs: 90_000, resetAt: NOW - 1 }],
			}),
			NOW,
		);
		expect(text).toContain("Backing off.");
		expect(text).toContain("90s (provenance unknown)");
		expect(text).toContain("ago");
	});
});
