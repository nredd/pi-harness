import { describe, expect, it, vi } from "vitest";
import {
	codexIdentity,
	eligibleGrant,
	formatOffers,
	parseOffers,
	readIdentity,
	record,
} from "../src/codex-contract.js";

import { NOW, payload, token } from "./fixtures/codex.js";

describe("pinned first-party Codex contract", () => {
	it("bounds credential-owner waits, sanitizes errors and handles cancellation races", async () => {
		await expect(readIdentity(async () => token())).resolves.toMatchObject({ account: "synthetic-workspace" });
		await expect(readIdentity(async () => token(), new AbortController().signal)).resolves.toBeDefined();
		await expect(
			readIdentity(() => {
				throw new Error("sync credential owner failure");
			}),
		).rejects.toThrow("lookup failed");
		const suppressed = new AbortController();
		suppressed.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
		await expect(
			readIdentity(async () => {
				await Promise.resolve();
				suppressed.abort();
				return token();
			}, suppressed.signal),
		).rejects.toMatchObject({ kind: "cancelled" });
		await expect(
			readIdentity(async () => {
				throw new Error("SECRET-ERROR");
			}),
		).rejects.toThrow("lookup failed");
		await expect(readIdentity(async () => new Promise(() => {}), undefined, 1)).rejects.toThrow("timed out");
		const abort = new AbortController();
		abort.abort();
		const lookup = vi.fn(async () => token());
		await expect(readIdentity(lookup, abort.signal)).rejects.toMatchObject({ kind: "cancelled" });
		expect(lookup).not.toHaveBeenCalled();
		const during = new AbortController();
		await expect(
			readIdentity(() => {
				during.abort();
				return Promise.resolve(token());
			}, during.signal),
		).rejects.toMatchObject({ kind: "cancelled" });
		const late = new AbortController();
		const pending = readIdentity(async () => new Promise(() => {}), late.signal);
		late.abort();
		await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
	});
	it("binds principal and workspace, not token rotation or a separate CLI account", () => {
		expect(codexIdentity(token()).fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(codexIdentity(token()).accountScope).toBe(codexIdentity(token("synthetic-workspace", "other")).accountScope);
		const missingSubject = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "sample", chatgpt_user_id: "not-a-substitute" } })).toString("base64url")}.x`;
		expect(() => codexIdentity(missingSubject)).toThrow("OAuth identity");
		const rotated = `x.${Buffer.from(JSON.stringify({ sub: "synthetic-user", "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-workspace", chatgpt_user_id: "changed-optional-metadata" } })).toString("base64url")}.x`;
		expect(codexIdentity(rotated).fingerprint).toBe(codexIdentity(token()).fingerprint);
		expect(codexIdentity(token()).fingerprint).not.toBe(codexIdentity(token("other")).fingerprint);
		expect(codexIdentity(token()).fingerprint).not.toBe(
			codexIdentity(token("synthetic-workspace", "other")).fingerprint,
		);
		const fallback = `x.${Buffer.from(JSON.stringify({ sub: "fallback-user", "https://api.openai.com/auth": { chatgpt_account_id: "sample" } })).toString("base64url")}.x`;
		expect(codexIdentity(fallback).account).toBe("sample");
	});
	it.each([
		undefined,
		"",
		"invalid",
		"x..x",
		"x.bnVsbA.x",
		`x.${Buffer.from(JSON.stringify({})).toString("base64url")}.x`,
		token(""),
		token("a", ""),
	])("rejects missing or unsafe account binding %s", (value) => {
		expect(() => codexIdentity(value)).toThrow("OAuth identity is unavailable");
	});
	it.each([null, undefined, [], 3, "secret"])("rejects non-object protocol fields %s", (value) =>
		expect(() => record(value)).toThrow("unsupported response shape"),
	);
	it("keeps unknown, count-only, zero and details distinct", () => {
		const root = payload();
		expect(parseOffers({ rateLimits: { primary: null, secondary: undefined } }, NOW)).toMatchObject({
			count: null,
			grants: null,
			used: [],
		});
		expect(parseOffers({ ...root, rateLimitResetCredits: null }, NOW).count).toBeNull();
		expect(parseOffers({ ...root, rateLimitResetCredits: { availableCount: 0, credits: [] } }, NOW)).toMatchObject({
			count: 0,
			grants: [],
		});
		expect(parseOffers({ ...root, rateLimitResetCredits: { availableCount: 2, credits: null } }, NOW)).toMatchObject({
			count: 2,
			grants: null,
		});
		expect(parseOffers(root, NOW).grants?.[0]?.expiresAt).toBe(NOW + 100_000);
		expect(
			parseOffers(
				{
					...root,
					rateLimitResetCredits: {
						availableCount: 1,
						credits: [{ ...root.rateLimitResetCredits.credits[0], expiresAt: null }],
					},
				},
				NOW,
			).grants?.[0]?.expiresAt,
		).toBeNull();
		expect(eligibleGrant(parseOffers(root, NOW), "fixture-grant", NOW).id).toBe("fixture-grant");
	});
	it.each([-1, 101, NaN, Infinity, "50", null])("rejects invalid usage %s", (usedPercent) =>
		expect(() => parseOffers({ rateLimits: { primary: { usedPercent } } }, NOW)).toThrow("invalid quota usage"),
	);
	it.each([-1, 1.5, NaN, Infinity, "1"])("rejects invalid balance %s", (availableCount) =>
		expect(() => parseOffers({ ...payload(), rateLimitResetCredits: { availableCount } }, NOW)).toThrow(
			"invalid reset balance",
		),
	);
	it("validates details, epoch bounds, IDs and duplicate rows", () => {
		const root = payload();
		expect(() => parseOffers({ ...root, rateLimitResetCredits: { availableCount: 1, credits: {} } }, NOW)).toThrow(
			"details are unavailable",
		);
		for (const patch of [
			{ id: "" },
			{ id: "x".repeat(1025) },
			{ id: 3 },
			{ resetType: 3 },
			{ status: null },
			{ grantedAt: "bad" },
			{ grantedAt: 1.5 },
			{ grantedAt: 1e20 },
			{ expiresAt: undefined },
			{ expiresAt: -Infinity },
		]) {
			expect(() =>
				parseOffers(
					{
						...root,
						rateLimitResetCredits: {
							availableCount: 1,
							credits: [{ ...root.rateLimitResetCredits.credits[0], ...patch }],
						},
					},
					NOW,
				),
			).toThrow("invalid reset details");
		}
		expect(() =>
			parseOffers(
				{
					...root,
					rateLimitResetCredits: {
						availableCount: 2,
						credits: [root.rateLimitResetCredits.credits[0], root.rateLimitResetCredits.credits[0]],
					},
				},
				NOW,
			),
		).toThrow("duplicate");
	});
	it("fails closed for unknown eligibility, expiry, quota or unsupported types", () => {
		const offers = parseOffers(payload(), NOW);
		for (const patch of [
			{ grants: null },
			{ count: null },
			{ count: 0 },
			{ used: [] },
			{ used: [20] },
			{ grants: [{ ...offers.grants?.[0], id: "fixture-grant", type: "unknown" }] },
			{ grants: [{ ...offers.grants?.[0], status: "redeemed" }] },
			{ grants: [{ ...offers.grants?.[0], status: "unknown" }] },
			{ grants: [{ ...offers.grants?.[0], expiresAt: null }] },
			{ grants: [{ ...offers.grants?.[0], expiresAt: NOW }] },
		]) {
			expect(() => eligibleGrant({ ...offers, ...patch } as typeof offers, "fixture-grant", NOW)).toThrow(
				"eligibility",
			);
		}
	});
	it("renders only safe reported fields, never opaque IDs, arbitrary statuses or unknown applicability", () => {
		const root = payload();
		const offers = parseOffers(root, NOW);
		const grant = offers.grants?.[0];
		if (!grant) throw new Error("missing fixture grant");
		const text = formatOffers(offers);
		expect(text).toContain("main Codex quota; available");
		expect(text).not.toContain("fixture-grant");
		expect(text).toContain("history: not reported");
		const unknown = parseOffers({ rateLimits: {}, rateLimitResetCredits: null }, NOW);
		expect(formatOffers(unknown)).toContain("unknown (not verified zero)");
		expect(
			formatOffers({
				...offers,
				grants: [{ ...grant, type: "private-type", status: "private-status", expiresAt: null }],
			}),
		).toContain("unsupported type; unknown status");
		expect(formatOffers({ ...offers, grants: [{ ...grant, expiresAt: null }] })).toContain("expiry unknown");
	});
});
