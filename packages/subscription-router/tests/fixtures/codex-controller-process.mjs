/** Real isolated controller process for shared-ledger interleavings, with synthetic auth/backend only. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { CodexResets } = await jiti.import("../../src/codex-resets.ts");
const { CodexResetError, codexIdentity } = await jiti.import("../../src/codex-contract.ts");
const { NOW, payload, token } = await jiti.import("./codex.ts");
const [role, mode, root] = process.argv.slice(2);
const messages = new Map();
const waiters = new Map();
process.on("message", (message) => {
	const waiter = waiters.get(message.command);
	if (waiter) {
		waiters.delete(message.command);
		waiter();
	} else messages.set(message.command, true);
});
const waitFor = (command) =>
	messages.has(command) ? Promise.resolve() : new Promise((resolve) => waiters.set(command, resolve));
const send = (event, fields = {}) => process.send?.({ event, role, ...fields });
let opened = 0;
const body = () => {
	const result = payload();
	result.rateLimitResetCredits.availableCount = 2;
	result.rateLimitResetCredits.credits.push({ ...result.rateLimitResetCredits.credits[0], id: "other-grant" });
	return result;
};
const cancellation = new AbortController();
const controller = new CodexResets({
	root,
	now: () => NOW,
	getToken: async () => token(),
	usage: {
		invalidate: () => {},
		get: async () => ({
			provider: "openai-codex",
			status: "available",
			windows: [],
			retrievedAt: NOW,
			expiresAt: NOW + 1000,
		}),
	},
	open: async () => {
		const ordinal = ++opened;
		let checks = 0;
		return {
			identity: codexIdentity(token()),
			checkIdentity: async () => {
				if (role !== "A" || ordinal !== 2 || ++checks !== 2) return;
				send("published");
				await waitFor("release-A");
				if (mode === "cancel") {
					cancellation.abort();
					return;
				}
				if (["unsupported", "noCredit", "nothingToReset"].includes(mode)) return;
				if (mode === "identity")
					throw new CodexResetError("authentication", "Synthetic identity changed after publication");
				throw new Error("Synthetic error after publication");
			},
			request: async (method, params, signal, dispatched) => {
				if (signal?.aborted) throw new CodexResetError("cancelled", "Synthetic cancellation before local dispatch");
				if (method === "account/rateLimits/read") return body();
				dispatched?.();
				if (role === "A" && mode === "unsupported")
					throw new CodexResetError("unsupported", "Synthetic method unavailable in this client only");
				if (role === "A" && ["noCredit", "nothingToReset"].includes(mode)) return { outcome: mode };
				await writeFile(
					join(root, `backend-${role}.json`),
					JSON.stringify({ key: params.idempotencyKey, grant: params.creditId, applied: true }),
					{ mode: 0o600 },
				);
				send("consume-dispatched", { key: params.idempotencyKey, grant: params.creditId });
				await waitFor("lose-response");
				throw new CodexResetError("transport", "Synthetic response lost after backend application");
			},
			close: async () => {},
		};
	},
});
try {
	const preview = await controller.inspect({});
	send("ready", { pendingKey: preview.pending?.key });
	await waitFor("start");
	await controller.redeem({}, preview, "fixture-grant", true, cancellation.signal, role === "B");
	send("finished", { kind: "unexpected-success" });
} catch (error) {
	send("finished", { kind: error instanceof CodexResetError ? error.kind : "error" });
} finally {
	process.disconnect();
}
