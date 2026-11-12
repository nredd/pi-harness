import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CodexResetError, codexIdentity, parseOffers } from "../src/codex-contract.js";
import { showCodexResets } from "../src/codex-reset-command.js";
import type { ResetInspection } from "../src/codex-resets.js";
import { ResetView } from "../src/reset-view.js";
import { NOW, payload, token } from "./fixtures/codex.js";

function fixture(choices: (string | undefined)[] = [], tui = false, hasUI = true, refreshDetails = false) {
	const preview: ResetInspection = {
		binding: codexIdentity(token()).fingerprint,
		offers: parseOffers(payload(), NOW),
		stale: false,
	};
	const service = {
		inspect: vi.fn(async () => preview),
		redeem: vi.fn(async () => ({ outcome: "reset" as const, quotaRefreshed: true, offersRefreshed: true })),
	};
	const notify = vi.fn();
	const confirm = vi.fn(async (_title: string, _message: string) => true);
	const custom = vi.fn(async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
		let done: (value: unknown) => void = () => {};
		const result = new Promise((resolve) => {
			done = resolve;
		});
		const component = await factory(
			{ terminal: { rows: 20 }, requestRender: vi.fn() } as never,
			{ fg: (_color: string, text: string) => text } as never,
			{} as never,
			done,
		);
		try {
			component.render(40);
			if (component instanceof ResetView) component.handleInput(refreshDetails ? "r" : "q");
			return await result;
		} finally {
			if ("dispose" in component) component.dispose?.();
		}
	});
	const ctx = {
		mode: tui ? "tui" : "rpc",
		hasUI,
		ui: { notify, confirm, custom, select: vi.fn(async () => choices.shift()) },
	} as unknown as ExtensionCommandContext;
	const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;
	return { service, preview, ctx, pi, notify, confirm, custom };
}

it("reports actual offers without a UI or model turn, never rendering account/grant IDs", async () => {
	const h = fixture([], false, false);
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.pi.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ customType: "router:codex-resets", display: true }),
		{ triggerTurn: false },
	);
	const message = vi.mocked(h.pi.sendMessage).mock.calls[0]?.[0];
	expect(message?.content).not.toContain("fixture-grant");
	expect(message?.content).not.toContain("synthetic-workspace");
	expect(h.service.redeem).not.toHaveBeenCalled();
});
it("provides native wrapped details, explicit refresh and safe close paths", async () => {
	const h = fixture(["View wrapped grant details", "Refresh offers (read-only)", "Close"], true);
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.service.inspect).toHaveBeenCalledTimes(2);
	expect(h.custom).toHaveBeenCalledTimes(3);
	expect(h.service.redeem).not.toHaveBeenCalled();
	const cancel = fixture([undefined]);
	await showCodexResets(cancel.pi, cancel.ctx, cancel.service);
});
it("honors the wrapped detail screen's explicit refresh action", async () => {
	const h = fixture(["View wrapped grant details", "Close"], true, true, true);
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.service.inspect).toHaveBeenCalledTimes(2);
	expect(h.service.redeem).not.toHaveBeenCalled();
});
it("requires separate grant selection plus explicit account/quota/expiry/FREE confirmation", async () => {
	const h = fixture(["Use FREE grant 1"]);
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.confirm).toHaveBeenCalledWith(
		"Confirm FREE banked reset",
		expect.stringContaining("CURRENT Pi Codex principal/workspace"),
	);
	expect(h.confirm.mock.calls[0]?.[1]).toContain("No paid reset");
	expect(h.confirm.mock.calls[0]?.[1]).toContain("Grant expiry: UTC");
	expect(h.service.redeem).toHaveBeenCalledWith(h.ctx, h.preview, "fixture-grant", true, undefined, false);
	expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Authoritative quota refreshed"), "info");
	const refused = fixture(["Use FREE grant 1", "Close"]);
	refused.confirm.mockResolvedValue(false);
	await showCodexResets(refused.pi, refused.ctx, refused.service);
	expect(refused.service.redeem).not.toHaveBeenCalled();
});
it("keeps displayed grant ordinals when earlier offers are ineligible", async () => {
	const h = fixture(["Use FREE grant 2"]);
	const grant = h.preview.offers.grants?.[0];
	if (!grant) throw new Error("missing fixture");
	h.preview.offers.grants = [{ ...grant, id: "ineligible-grant", status: "redeemed" }, grant];
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.service.redeem).toHaveBeenCalledWith(h.ctx, h.preview, "fixture-grant", true, undefined, false);
});
it("suppresses locally confirmed consumption while provider offer propagation lags", async () => {
	const h = fixture(["Close"]);
	h.preview.usedGrants = ["fixture-grant"];
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.notify.mock.calls[0]?.[0]).toContain("provider offer details lag");
	expect(h.service.redeem).not.toHaveBeenCalled();
});
it("reports capability/version failures explicitly in non-TUI modes", async () => {
	const h = fixture([], false, false);
	h.service.inspect.mockRejectedValue(new CodexResetError("unsupported", "Verified client version mismatch"));
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.pi.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ content: expect.stringContaining("unsupported: Verified client version mismatch") }),
		{ triggerTurn: false },
	);
});
it("distinguishes successful redemption from post-success refresh failure and server refusal", async () => {
	for (const result of [
		{ outcome: "alreadyRedeemed", quotaRefreshed: false, offersRefreshed: false },
		{ outcome: "noCredit", quotaRefreshed: false, offersRefreshed: false },
	]) {
		const h = fixture(["Use FREE grant 1"], true);
		h.ctx.signal = new AbortController().signal;
		h.service.redeem.mockResolvedValue(result as never);
		await showCodexResets(h.pi, h.ctx, h.service);
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain(
			result.outcome === "noCredit" ? "No grant consumed" : "Do NOT redeem again",
		);
	}
});
it("only reconciles the same unresolved grant/key after another explicit confirmation", async () => {
	const h = fixture(["Reconcile SAME unresolved FREE reset attempt"]);
	h.preview.pending = {
		version: 1,
		sequence: 1,
		key: "a".repeat(36),
		grant: "fixture-grant",
		binding: h.preview.binding,
		scope: codexIdentity(token()).accountScope,
		createdAt: NOW,
		expiry: NOW + 1000,
	};
	h.preview.stale = true;
	h.preview.offers.used = [];
	h.preview.message = "last-known offers";
	await showCodexResets(h.pi, h.ctx, h.service);
	expect(h.confirm).toHaveBeenCalledWith(
		"Confirm SAME FREE reset reconciliation",
		expect.stringContaining("original provider idempotency key"),
	);
	expect(h.service.redeem).toHaveBeenCalledWith(h.ctx, h.preview, "fixture-grant", true, undefined, true);
});
it("rejects invalid selections, unknown grant terms, missing pending IDs and sanitized operational errors", async () => {
	for (const choice of ["Use FREE grant 99", "Reconcile SAME unresolved FREE reset attempt"]) {
		const h = fixture([choice]);
		await showCodexResets(h.pi, h.ctx, h.service);
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("confirmation:"), "error");
	}
	const missing = fixture(["Close"]);
	missing.preview.offers.grants = null;
	await showCodexResets(missing.pi, missing.ctx, missing.service);
	const ineligible = fixture(["Close"]);
	ineligible.preview.offers.used = [];
	await showCodexResets(ineligible.pi, ineligible.ctx, ineligible.service);
	const unknownExpiry = fixture(["Reconcile SAME unresolved FREE reset attempt"]);
	unknownExpiry.preview.pending = {
		version: 1,
		sequence: 1,
		key: "a".repeat(36),
		grant: "fixture-grant",
		binding: unknownExpiry.preview.binding,
		scope: codexIdentity(token()).accountScope,
		createdAt: NOW,
		expiry: undefined as never,
	};
	await showCodexResets(unknownExpiry.pi, unknownExpiry.ctx, unknownExpiry.service);
	expect(unknownExpiry.confirm.mock.calls[0]?.[1]).toContain("not currently reported");
	for (const error of [new CodexResetError("unsupported", "Client mismatch"), new Error("PRIVATE-RAW-FAILURE")]) {
		const h = fixture([], true);
		h.service.inspect.mockRejectedValue(error);
		await showCodexResets(h.pi, h.ctx, h.service);
		expect(h.notify.mock.calls.at(-1)?.[0]).not.toContain("PRIVATE-RAW-FAILURE");
	}
});
