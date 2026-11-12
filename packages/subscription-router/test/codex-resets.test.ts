import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexResetError, codexIdentity } from "../src/codex-contract.js";
import { CodexResets } from "../src/codex-resets.js";
import type { CodexSession } from "../src/codex-session.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { ResetJournal } from "../src/reset-journal.js";
import { UsageService } from "../src/usage.js";
import { NOW, payload, token } from "./fixtures/codex.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "codex-service-test-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
function stored() {
	const identity = codexIdentity(token());
	return new ResetJournal(root, identity.accountScope, identity.fingerprint);
}
function setup() {
	let now = NOW;
	let current = token();
	let body: unknown = payload();
	let consume: (params: unknown) => Promise<unknown> = async () => ({ outcome: "reset" });
	let checkCount = 0;
	let failCheck = 0;
	const requests: { method: string; params: unknown }[] = [];
	const getToken = vi.fn(async () => current);
	const ctx = { modelRegistry: { getApiKeyForProvider: getToken } } as unknown as ExtensionContext;
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					rate_limit: {
						primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: (NOW + 3_600_000) / 1000 },
					},
				}),
			),
	);
	const usage = new UsageService({ now: () => now, getAccessToken: getToken, fetch });
	const tracker = new ExhaustionTracker(() => now);
	const open = vi.fn(
		async (): Promise<CodexSession> => ({
			identity: codexIdentity(current),
			checkIdentity: async () => {
				checkCount++;
				if (failCheck > 0 && checkCount >= failCheck) throw new CodexResetError("authentication", "Account changed");
			},
			request: async (method, params, signal, dispatched) => {
				requests.push({ method, params });
				if (signal?.aborted) throw new CodexResetError("cancelled", "Cancelled before dispatch");
				if (method === "account/rateLimits/read") return body;
				dispatched?.();
				return consume(params);
			},
			close: vi.fn(async () => {}),
		}),
	);
	const options = { root, now: () => now, getToken, usage, tracker, open };
	const service = new CodexResets(options);
	const inspect = () => service.inspect(ctx);
	const redeem = async () => service.redeem(ctx, await inspect(), "fixture-grant", true);
	return {
		service,
		options,
		ctx,
		getToken,
		usage,
		tracker,
		fetch,
		open,
		requests,
		inspect,
		redeem,
		setBody: (value: unknown) => {
			body = value;
		},
		setToken: (value: string) => {
			current = value;
		},
		consume: (fn: typeof consume) => {
			consume = fn;
		},
		advance: () => {
			now += 60_000;
		},
		failCheck: (number: number) => {
			failCheck = checkCount + number;
		},
	};
}

describe("account-bound confirmed FREE redemption", () => {
	it("uses the existing registry account and documented default client, never live credentials or a separate CLI login", async () => {
		const h = setup();
		const script = new URL("./fixtures/codex-app-server.mjs", import.meta.url);
		const binary = join(root, "codex");
		await writeFile(
			binary,
			`#!${process.execPath}\nprocess.argv.splice(2, 0, "normal", ${JSON.stringify(join(root, "backend.json"))}); import(${JSON.stringify(script.href)});\n`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
		const service = new CodexResets({ root: join(root, "journal"), usage: h.usage });
		const preview = await service.inspect(h.ctx);
		await expect(service.redeem(h.ctx, preview, "fixture-grant", true)).resolves.toEqual({
			outcome: "reset",
			quotaRefreshed: true,
			offersRefreshed: true,
		});
		expect(h.getToken).toHaveBeenCalled();
		expect((await service.inspect(h.ctx)).usedGrants).toEqual(["fixture-grant"]);
	});
	it("revalidates, journals before dispatch, invalidates only Codex cache and reconciles exact confirmed windows", async () => {
		const h = setup();
		h.tracker.mark({ provider: "openai-codex", id: "sample" }, { block: true, window: "7d" });
		h.tracker.mark({ provider: "other", id: "sample" }, { block: true, window: "7d" });
		h.consume(async (params) => {
			const entries = await stored().entries();
			expect(entries).toHaveLength(1);
			expect(params).toEqual({ creditId: "fixture-grant", idempotencyKey: entries[0]?.attempt.key });
			return { outcome: "reset" };
		});
		await expect(h.redeem()).resolves.toEqual({ outcome: "reset", quotaRefreshed: true, offersRefreshed: true });
		expect(h.requests.map((request) => request.method)).toEqual([
			"account/rateLimits/read",
			"account/rateLimits/read",
			"account/rateLimitResetCredit/consume",
			"account/rateLimits/read",
		]);
		expect(h.tracker.active().map((mark) => mark.provider)).toEqual(["other"]);
		expect(h.fetch).toHaveBeenCalledOnce();
	});
	it("distinguishes refusal, confirmed success and failed/cancelled post-success quota refresh", async () => {
		for (const outcome of ["noCredit", "nothingToReset", "alreadyRedeemed"]) {
			const h = setup();
			h.consume(async () => ({ outcome }));
			const result = await h.redeem();
			expect(result).toEqual({
				outcome,
				quotaRefreshed: outcome === "alreadyRedeemed",
				offersRefreshed: outcome === "alreadyRedeemed",
			});
			await rm(root, { recursive: true, force: true });
		}
		const h = setup();
		h.fetch.mockRejectedValueOnce(new Error("fixture network failure"));
		await expect(h.redeem()).resolves.toEqual({ outcome: "reset", quotaRefreshed: false, offersRefreshed: true });
		const entries = await stored().entries();
		expect(entries[0]?.outcome).toBe("reset");
	});
	it("refreshes quota independently when the post-consume banked offer read fails", async () => {
		const h = setup();
		h.consume(async () => {
			h.setBody(null);
			return { outcome: "reset" };
		});
		await expect(h.redeem()).resolves.toEqual({ outcome: "reset", quotaRefreshed: true, offersRefreshed: false });
	});
	it("keeps same durable key after uncertain completion/reload and does not replay on inspection", async () => {
		const h = setup();
		h.consume(async () => {
			throw new Error("lost completion after dispatch");
		});
		await expect(h.redeem()).rejects.toMatchObject({ kind: "unknown" });
		const first = h.requests.at(-1)?.params;
		const reloaded = new CodexResets(h.options);
		const preview = await reloaded.inspect(h.ctx);
		expect(preview.pending).toBeDefined();
		expect(h.requests.filter((request) => request.method.endsWith("/consume"))).toHaveLength(1);
		await expect(reloaded.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow("unresolved");
		h.consume(async () => ({ outcome: "alreadyRedeemed" }));
		await expect(reloaded.redeem(h.ctx, preview, "fixture-grant", true, undefined, true)).resolves.toEqual({
			outcome: "alreadyRedeemed",
			quotaRefreshed: true,
			offersRefreshed: true,
		});
		expect(h.requests.filter((request) => request.method.endsWith("/consume")).at(-1)?.params).toEqual(first);
		expect((await reloaded.inspect(h.ctx)).usedGrants).toEqual(["fixture-grant"]);
	});
	it("keeps unresolved workspace attempts blocked after a principal switch and refuses cross-principal reconciliation", async () => {
		const h = setup();
		h.consume(async () => {
			throw new Error("uncertain completion");
		});
		await expect(h.redeem()).rejects.toMatchObject({ kind: "unknown" });
		h.setToken(token("synthetic-workspace", "other-principal"));
		const switched = await h.inspect();
		expect(switched.pending).toBeDefined();
		await expect(h.service.redeem(h.ctx, switched, "fixture-grant", true)).rejects.toMatchObject({ kind: "busy" });
		await expect(h.service.redeem(h.ctx, switched, "fixture-grant", true, undefined, true)).rejects.toThrow(
			"different Pi principal",
		);
		h.setToken(token());
		const original = await h.inspect();
		h.consume(async () => ({ outcome: "alreadyRedeemed" }));
		await expect(h.service.redeem(h.ctx, original, "fixture-grant", true, undefined, true)).resolves.toMatchObject({
			outcome: "alreadyRedeemed",
		});
	});
	it("requires confirmation and stops cancellation/account changes before fresh admission", async () => {
		const h = setup();
		const preview = await h.inspect();
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", false)).rejects.toMatchObject({
			kind: "confirmation",
		});
		const abort = new AbortController();
		abort.abort();
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true, abort.signal)).rejects.toMatchObject({
			kind: "cancelled",
		});
		h.setToken(token("changed"));
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toMatchObject({
			kind: "authentication",
		});
	});
	it("dedupes concurrent attempts while preserving the first request's uncertain outcome", async () => {
		const h = setup();
		const preview = await h.inspect();
		let release: () => void = () => {};
		let started: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		h.consume(async () => {
			started();
			await gate;
			throw new Error("lost completion");
		});
		const first = h.service.redeem(h.ctx, preview, "fixture-grant", true);
		await ready;
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toMatchObject({ kind: "busy" });
		release();
		await expect(first).rejects.toMatchObject({ kind: "unknown" });
		expect(h.requests.filter((request) => request.method.endsWith("/consume"))).toHaveLength(1);
	});
	it("disables embeddings without cache invalidation and preserves confirmed success when receipt persistence fails", async () => {
		const h = setup();
		const preview = await h.inspect();
		const embedded = new CodexResets({ ...h.options, usage: { get: h.usage.get.bind(h.usage) } });
		await expect(embedded.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow("redemption is disabled");
		for (const outcome of ["reset", "alreadyRedeemed", "noCredit"]) {
			await rm(root, { recursive: true, force: true });
			h.consume(async () => ({ outcome }));
			vi.spyOn(ResetJournal.prototype, "settle").mockRejectedValueOnce(new Error("synthetic write failure"));
			await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow(
				outcome === "noCredit" ? "UNKNOWN" : "confirmed by Codex",
			);
			vi.restoreAllMocks();
		}
	});
	it("reports missing consume capabilities explicitly without releasing prior uncertain work", async () => {
		const h = setup();
		const preview = await h.inspect();
		h.consume(async () => {
			throw new CodexResetError("unsupported", "method not found");
		});
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toMatchObject({
			kind: "unsupported",
		});
		expect((await stored().entries())[0]?.outcome).toBe("notDispatched");
		await rm(root, { recursive: true, force: true });
		h.consume(async () => {
			throw new Error("lost completion");
		});
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toMatchObject({ kind: "unknown" });
		const pending = await h.service.inspect(h.ctx);
		h.consume(async () => {
			throw new CodexResetError("unsupported", "method not found");
		});
		await expect(h.service.redeem(h.ctx, pending, "fixture-grant", true, undefined, true)).rejects.toMatchObject({
			kind: "unsupported",
		});
		expect((await stored().entries())[0]?.outcome).toBeUndefined();
	});
	it("does not call stale post-redemption quota evidence refreshed", async () => {
		const h = setup();
		vi.spyOn(h.usage, "get").mockResolvedValue({
			provider: "openai-codex",
			status: "available",
			windows: [],
			retrievedAt: NOW,
			expiresAt: NOW,
		});
		await expect(h.redeem()).resolves.toMatchObject({ quotaRefreshed: false });
	});
	it("rejects changed terms and unsupported/missing offers without dispatch", async () => {
		const h = setup();
		const preview = await h.inspect();
		const changed = payload();
		for (const row of changed.rateLimitResetCredits.credits) row.expiresAt++;
		h.setBody(changed);
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow("terms changed");
		h.setBody({ rateLimits: {}, rateLimitResetCredits: null });
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toMatchObject({ kind: "unverified" });
		expect(h.requests.some((request) => request.method.endsWith("/consume"))).toBe(false);
	});
	it("settles pre-dispatch cancellation/identity failure as notDispatched, never inventing success", async () => {
		const h = setup();
		const preview = await h.inspect();
		h.failCheck(2);
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow("Account changed");
		expect((await stored().entries())[0]?.outcome).toBe("notDispatched");
	});
	it("rejects mismatched reconciliation keys/grants and unknown consume results", async () => {
		const h = setup();
		const preview = await h.inspect();
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true, undefined, true)).rejects.toThrow(
			"No matching",
		);
		h.consume(async () => ({ outcome: "unknown-provider-value" }));
		await expect(h.redeem()).rejects.toMatchObject({ kind: "unknown" });
		const reloaded = new CodexResets(h.options);
		const pending = await reloaded.inspect(h.ctx);
		await expect(reloaded.redeem(h.ctx, pending, "wrong-grant", true, undefined, true)).rejects.toThrow("No matching");
		await expect(
			reloaded.redeem(h.ctx, { ...pending, pending: undefined }, "fixture-grant", true, undefined, true),
		).rejects.toThrow("No matching");
	});
	it("keeps provider success distinct when identity/refresh subsequently fails", async () => {
		const h = setup();
		const preview = await h.inspect();
		h.failCheck(3);
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).resolves.toEqual({
			outcome: "reset",
			quotaRefreshed: false,
			offersRefreshed: false,
		});
	});
	it("does not trust a session bound to a different account", async () => {
		const h = setup();
		h.open.mockImplementationOnce(async () => ({
			identity: codexIdentity(token("other")),
			checkIdentity: vi.fn(),
			request: vi.fn(),
			close: vi.fn(),
		}));
		await expect(h.inspect()).rejects.toThrow("changed before inspection");
		h.advance();
		const preview = await h.inspect();
		h.open.mockImplementationOnce(async () => ({
			identity: codexIdentity(token("other")),
			checkIdentity: vi.fn(),
			request: vi.fn(),
			close: vi.fn(),
		}));
		await expect(h.service.redeem(h.ctx, preview, "fixture-grant", true)).rejects.toThrow("changed before redemption");
	});
	it("retains stale offer evidence and backs off failed initial reads", async () => {
		const h = setup();
		const first = await h.inspect();
		await h.inspect();
		expect(h.open).toHaveBeenCalledOnce();
		h.advance();
		h.setBody(null);
		expect(await h.inspect()).toMatchObject({ stale: true, offers: first.offers });
		expect(await h.inspect()).toMatchObject({ stale: true });
		h.setToken(token("new-account"));
		await expect(h.inspect()).rejects.toThrow("unsupported response");
		await expect(h.inspect()).rejects.toThrow("backed off");
	});
	it("coalesces account-local inspection and cancellation detaches only that inspector", async () => {
		const h = setup();
		let release: () => void = () => {};
		let started: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const baseOpen = h.open.getMockImplementation();
		if (!baseOpen) throw new Error("missing mock implementation");
		h.open.mockImplementation(async () => {
			const session = await baseOpen();
			const request = session.request;
			session.request = async (...args) => {
				started();
				await gate;
				return request(...args);
			};
			return session;
		});
		const abort = new AbortController();
		const first = h.service.inspect(h.ctx, abort.signal);
		await ready;
		const second = h.service.inspect(h.ctx);
		abort.abort();
		await expect(first).rejects.toMatchObject({ kind: "cancelled" });
		release();
		await expect(second).resolves.toMatchObject({ stale: false });
		expect(h.open).toHaveBeenCalledOnce();
	});
	it("cancels after account binding but before a shared read attaches", async () => {
		const h = setup();
		const abort = new AbortController();
		const entries = ResetJournal.prototype.entries;
		vi.spyOn(ResetJournal.prototype, "entries").mockImplementationOnce(async function (this: ResetJournal) {
			abort.abort();
			return entries.call(this);
		});
		await expect(h.service.inspect(h.ctx, abort.signal)).rejects.toMatchObject({ kind: "cancelled" });
		await h.inspect();
	});
});
