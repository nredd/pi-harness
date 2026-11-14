/** Human-only FREE reset entrypoint. There is deliberately no model-callable consume tool. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";
import { CodexResetError, eligibleGrant, formatOffers } from "./codex-contract.js";
import type { CodexResets } from "./codex-resets.js";
import { ResetView } from "./reset-view.js";

/** Native cancellable operation, with no custom terminal UI in RPC/print/JSON modes. */
async function operation<T>(
	ctx: ExtensionCommandContext,
	title: string,
	run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
	if (ctx.mode !== "tui") return run(ctx.signal);
	const result = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _kb, done) => {
		const loader = new CancellableLoader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			`${title}; Escape cancels this caller`,
		);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, loader.signal]) : loader.signal;
		void run(signal).then(
			(value) => done({ value }),
			(error: unknown) => done({ error }),
		);
		return loader;
	});
	if ("error" in result) throw result.error;
	return result.value;
}

/** List actual reported grants. Mutations require a separate selection AND an explicit account/terms confirmation. */
export async function showCodexResets(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	resets: Pick<CodexResets, "inspect" | "redeem">,
	now: () => number = Date.now,
): Promise<void> {
	try {
		let inspection = await operation(ctx, "Inspecting FREE Codex reset offers", (signal) =>
			resets.inspect(ctx, signal),
		);
		for (;;) {
			const text = `${formatOffers(inspection.offers)}\n${inspection.stale ? "STALE: " : ""}${inspection.message ?? ""}${inspection.pending ? "\nAn unresolved attempt is retained. No new grant may be consumed until it is reconciled." : ""}${inspection.usedGrants?.length ? "\nKnown successful receipts suppress repeat consumption even if provider offer details lag." : ""}`;
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "router:codex-resets", content: text, display: true }, { triggerTurn: false });
				return;
			}
			ctx.ui.notify(text, "info");
			const candidates = inspection.pending
				? []
				: (inspection.offers.grants ?? [])
						.map((grant, index) => ({ grant, index }))
						.filter(({ grant }) => {
							if (inspection.usedGrants?.includes(grant.id)) return false;
							try {
								eligibleGrant(inspection.offers, grant.id, now());
								return true;
							} catch {
								return false;
							}
						});
			const choices = [
				"Close",
				"Refresh offers (read-only)",
				...(ctx.mode === "tui" ? ["View wrapped grant details"] : []),
				...(inspection.pending
					? ["Reconcile SAME unresolved FREE reset attempt"]
					: candidates.map(({ index }) => `Use FREE grant ${index + 1}`)),
			];
			const choice = await ctx.ui.select("FREE Codex banked resets (current Pi account/workspace)", choices);
			if (!choice || choice === "Close") return;
			if (choice === "View wrapped grant details") {
				const refresh = await ctx.ui.custom<boolean>(
					(tui, _theme, _kb, done) =>
						new ResetView(
							text,
							() => tui.terminal.rows,
							() => tui.requestRender(),
							done,
						),
				);
				if (!refresh) continue;
			}
			if (choice === "Refresh offers (read-only)" || choice === "View wrapped grant details") {
				inspection = await operation(ctx, "Refreshing offers (once/minute limit applies)", (signal) =>
					resets.inspect(ctx, signal),
				);
				continue;
			}
			const reconcile = choice === "Reconcile SAME unresolved FREE reset attempt";
			const grant = candidates.find(({ index }) => index === Number(choice.split(" ").at(-1)) - 1)?.grant;
			if (!reconcile && !grant)
				throw new CodexResetError("confirmation", "Invalid reset selection; nothing dispatched.");
			const id = reconcile ? inspection.pending?.grant : grant?.id;
			if (!id) throw new CodexResetError("confirmation", "No matching reset selected.");
			const expiry = reconcile ? inspection.pending?.expiry : grant?.expiresAt;
			const confirmation = [
				"Account context: CURRENT Pi Codex principal/workspace, token-bound in an isolated app-server; NOT a separate CLI login.",
				reconcile
					? "Reconcile/retry the SAME durable logical attempt using its original provider idempotency key and grant. If the first call did not complete, this can consume that originally selected FREE grant. No new grant/key is chosen."
					: "Consume ONE FREE earned banked grant, only after live eligibility and account revalidation.",
				`Quota: main Codex allowances; current reported usage ${inspection.offers.used.join(", ") || "unknown"}%. Exact per-grant window applicability is not reported; the provider decides eligibility.`,
				`Grant expiry: ${expiry == null ? "not currently reported; the provider must reconcile the original grant" : `UTC ${new Date(expiry).toISOString()}`}.`,
				"No paid reset, purchase, extra usage billing or automatic redemption. Cancellation after dispatch can leave an UNKNOWN outcome; do not spend another grant to test success.",
			].join("\n");
			if (
				!(await ctx.ui.confirm(
					reconcile ? "Confirm SAME FREE reset reconciliation" : "Confirm FREE banked reset",
					confirmation,
				))
			)
				continue;
			const result = await operation(
				ctx,
				reconcile ? "Reconciling SAME FREE reset attempt" : "Consuming confirmed FREE reset",
				(signal) => resets.redeem(ctx, inspection, id, true, signal, reconcile),
			);
			ctx.ui.notify(
				result.outcome === "reset" || result.outcome === "alreadyRedeemed"
					? `FREE reset confirmed (${result.outcome}). ${result.quotaRefreshed ? "Authoritative quota refreshed." : "Quota refresh FAILED or was cancelled; redemption remains confirmed. Do NOT redeem again."} ${result.offersRefreshed ? "Banked offers refreshed." : "Banked offer refresh failed; inspect before another grant."} Parked work/goals/loops are not resumed.`
					: `Codex refused this request (${result.outcome}). The published attempt remains unresolved; another same-key request may have consumed the grant. Its global outcome is UNKNOWN. Inspect, then explicitly Reconcile SAME. Do NOT consume another grant to test success. If reconciliation keeps refusing, use the official Usage UI.`,
				"info",
			);
			return;
		}
	} catch (error) {
		const message =
			error instanceof CodexResetError
				? `${error.kind}: ${error.message}`
				: "Codex reset operation failed safely; inspect the durable attempt before retrying. No fallback attempted.";
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else pi.sendMessage({ customType: "router:codex-resets", content: message, display: true }, { triggerTurn: false });
	}
}
