/** Real Pi command -> first-party protocol adapter -> faux subprocess/backend -> durable reload reconciliation. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, createTestUiContext } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { codexIdentity } from "../../src/codex-contract.js";
import { CodexResets } from "../../src/codex-resets.js";
import { openCodexSession } from "../../src/codex-session.js";
import { createSubscriptionRouter } from "../../src/index.js";
import { ResetJournal } from "../../src/reset-journal.js";
import { UsageService } from "../../src/usage.js";
import { NOW, token } from "../fixtures/codex.js";

it("confirms a FREE consume, retains unknown completion and reconciles the original key across reload without a second spend", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-reset-scenario-"));
	const state = join(root, "fake-backend.json");
	const fixture = fileURLToPath(new URL("../fixtures/codex-app-server.mjs", import.meta.url));
	let mode = "consume-exit";
	const notifications: string[] = [];
	const confirmations: string[] = [];
	const usage = new UsageService({
		now: () => NOW,
		getAccessToken: async () => token(),
		fetch: async () =>
			new Response(
				JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } }),
			),
	});
	const options = {
		root: join(root, "journal"),
		now: () => NOW,
		usage,
		getToken: async () => token(),
		open: async () =>
			openCodexSession({
				getToken: async () => token(),
				command: [process.execPath, fixture, mode, state],
				timeoutMs: 5000,
			}),
	};
	const identity = codexIdentity(token());
	const journal = new ResetJournal(options.root, identity.accountScope, identity.fingerprint);
	const start = async () => {
		const resets = new CodexResets(options);
		const harness = await createHarness({
			extensionFactories: [
				createSubscriptionRouter({ config: { ok: true, profiles: [] }, usage, codexResets: resets, now: () => NOW }),
			],
		});
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				notify: (message) => notifications.push(message),
				select: async (_title, choices) =>
					choices.find((choice) => choice.startsWith("Use FREE") || choice.startsWith("Reconcile SAME")),
				confirm: async (_title, message) => {
					confirmations.push(message);
					return true;
				},
			}),
		});
		return harness;
	};
	try {
		const first = await start();
		try {
			await first.session.prompt("/router resets codex");
			expect(first.session.messages.some((message) => message.role === "assistant")).toBe(false);
		} finally {
			first.cleanup();
		}
		expect(notifications.at(-1)).toContain("UNKNOWN");
		const pending = (await journal.entries())[0];
		expect(pending?.outcome).toBeUndefined();
		mode = "normal";
		const reloaded = await start();
		try {
			await reloaded.session.prompt("/router resets codex");
		} finally {
			reloaded.cleanup();
		}
		expect(notifications.at(-1)).toContain("alreadyRedeemed");
		expect(notifications.at(-1)).toContain("Authoritative quota refreshed");
		expect(confirmations).toHaveLength(2);
		expect(confirmations[1]).toContain("SAME durable logical attempt");
		const backend = JSON.parse(await readFile(state, "utf8"));
		expect(backend.consumes).toBe(1);
		expect(backend.keys).toEqual([pending?.attempt.key]);
		expect((await journal.entries())[0]?.outcome).toBe("alreadyRedeemed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
