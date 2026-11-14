/** Deterministic shared-ledger race: separate OS controller processes, real claims, synthetic backend only. */
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { codexIdentity } from "../src/codex-contract.js";
import { CodexResets } from "../src/codex-resets.js";
import { ResetJournal } from "../src/reset-journal.js";
import { NOW, payload, token } from "./fixtures/codex.js";

interface Notice {
	event: string;
	role: string;
	kind?: string;
	key?: string;
	pendingKey?: string;
	grant?: string;
}

function actor(role: "A" | "B", mode: string, root: string) {
	const child = fork(
		fileURLToPath(new URL("./fixtures/codex-controller-process.mjs", import.meta.url)),
		[role, mode, root],
		{
			execArgv: [],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { PATH: process.env.PATH, JITI_FS_CACHE: "false" },
		},
	);
	const queued: Notice[] = [];
	const waits = new Map<string, { resolve(message: Notice): void; reject(error: Error): void }>();
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-4096);
	});
	child.on("message", (message: Notice) => {
		const waiter = waits.get(message.event);
		if (waiter) {
			waits.delete(message.event);
			waiter.resolve(message);
		} else queued.push(message);
	});
	let exited = false;
	const closed = new Promise<void>((resolve) =>
		child.once("exit", () => {
			exited = true;
			for (const waiter of waits.values())
				waiter.reject(new Error(`Synthetic actor '${role}' exited before its barrier: ${stderr}`));
			waits.clear();
			resolve();
		}),
	);
	child.on("error", (error) => {
		for (const waiter of waits.values()) waiter.reject(error);
		waits.clear();
	});
	return {
		pid: child.pid,
		wait: (event: string): Promise<Notice> => {
			const index = queued.findIndex((message) => message.event === event);
			if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] as Notice);
			if (exited) return Promise.reject(new Error(`Synthetic actor '${role}' already exited: ${stderr}`));
			return new Promise((resolve, reject) => waits.set(event, { resolve, reject }));
		},
		send: (command: string) => child.send({ command }),
		kill: async () => {
			if (!exited) child.kill("SIGKILL");
			await closed;
		},
		closed,
	};
}

it.each(["identity", "cancel", "error", "unsupported", "noCredit", "nothingToReset", "crash"])(
	"retains another process's uncertain consume after publisher %s",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "codex-cross-process-"));
		const a = actor("A", mode, root);
		let b: ReturnType<typeof actor> | undefined;
		try {
			await a.wait("ready");
			a.send("start");
			await a.wait("published");
			const identity = codexIdentity(token());
			const journal = new ResetJournal(root, identity.accountScope, identity.fingerprint);
			const published = (await journal.entries())[0]?.attempt;
			if (!published) throw new Error("publisher did not create a real claim");
			b = actor("B", mode, root);
			expect(b.pid).not.toBe(a.pid);
			expect((await b.wait("ready")).pendingKey).toBe(published.key);
			b.send("start");
			const dispatched = await b.wait("consume-dispatched");
			expect(dispatched).toMatchObject({ key: published.key, grant: published.grant });
			if (mode === "crash") await a.kill();
			else {
				a.send("release-A");
				await a.wait("finished");
				await a.closed;
			}
			b.send("lose-response");
			expect((await b.wait("finished")).kind).toBe("unknown");
			await b.closed;
			expect(JSON.parse(await readFile(join(root, "backend-B.json"), "utf8"))).toEqual({
				key: published.key,
				grant: published.grant,
				applied: true,
			});

			// A local pre-dispatch failure is not globally authoritative once another process can dispatch.
			expect.soft((await journal.entries())[0]?.outcome).toBeUndefined();
			const consumes: unknown[] = [];
			const body = payload();
			body.rateLimitResetCredits.availableCount = 2;
			body.rateLimitResetCredits.credits.push({
				...body.rateLimitResetCredits.credits[0],
				id: "other-grant",
			} as (typeof body.rateLimitResetCredits.credits)[number]);
			const c = new CodexResets({
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
				open: async () => ({
					identity,
					checkIdentity: async () => {},
					close: async () => {},
					request: async (method, params, _signal, markDispatched) => {
						if (method === "account/rateLimits/read") return body;
						markDispatched?.();
						consumes.push(params);
						// B's synthetic backend already applied the original key once. A retry returns
						// its prior success, never another spend; only a new grant can apply anew.
						return {
							outcome:
								(params as { idempotencyKey: string }).idempotencyKey === published.key ? "alreadyRedeemed" : "reset",
						};
					},
				}),
			});
			const preview = await c.inspect({} as ExtensionContext);
			const fresh = await Promise.allSettled([c.redeem({} as ExtensionContext, preview, "other-grant", true)]);
			expect.soft(fresh[0]).toMatchObject({ status: "rejected", reason: { kind: "busy" } });
			expect.soft(consumes).toEqual([]);
			// Reload/inspection is read-only. Explicit recovery keeps BOTH original grant and UUID.
			expect(preview.pending?.key).toBe(published.key);
			await expect(
				c.redeem({} as ExtensionContext, preview, published.grant, true, undefined, true),
			).resolves.toMatchObject({ outcome: "alreadyRedeemed" });
			expect(consumes).toEqual([{ creditId: published.grant, idempotencyKey: published.key }]);
			const settled = await c.inspect({} as ExtensionContext);
			expect(settled.pending).toBeUndefined();
			await expect(c.redeem({} as ExtensionContext, settled, published.grant, true)).rejects.toMatchObject({
				kind: "busy",
			});
			expect(consumes).toHaveLength(1);
			await expect(c.redeem({} as ExtensionContext, settled, "other-grant", true)).resolves.toMatchObject({
				outcome: "reset",
			});
			expect(consumes).toHaveLength(2);
			expect(consumes[1]).not.toEqual(consumes[0]);
		} finally {
			await a.kill();
			await b?.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);
