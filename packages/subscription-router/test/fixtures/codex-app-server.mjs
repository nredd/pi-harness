/** Synthetic app-server, never Codex or a provider. Durable fixture state simulates backend idempotency. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode = "normal", stateFile] = process.argv.slice(2);
if (process.argv.at(-1) === "--version") {
	if (mode === "version-error") process.exit(1);
	process.stdout.write(mode === "version-mismatch" ? "codex-cli 0.0.0\n" : "codex-cli 0.167.2\n");
	process.exit(0);
}
if (mode === "ignore-term") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
}
let bound = false;
const waiting = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ id, result: value });
const state = () => {
	try {
		return JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {
		return { count: 1, keys: [], consumes: 0 };
	}
};
const offers = () => {
	const backend = state();
	return {
		rateLimits: { primary: { usedPercent: 50 }, secondary: null },
		rateLimitResetCredits: {
			availableCount: backend.count,
			credits: [
				{
					id: "fixture-grant",
					resetType: "codexRateLimits",
					status: backend.count ? "available" : "redeemed",
					grantedAt: 1_899_999_900,
					expiresAt: 1_900_000_100,
				},
			],
		},
	};
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === "refresh-token") {
		if (typeof message.result?.accessToken !== "string") process.exit(7);
		result(waiting.get("read"), offers());
		return;
	}
	if (message.id === "unknown-request") {
		result(waiting.get("init"), {});
		return;
	}
	if (message.method === "initialize") {
		if (
			process.env.HOME !== process.env.CODEX_HOME ||
			process.env.PI_CODEX_SECRET_SENTINEL ||
			!message.params.capabilities.experimentalApi
		)
			process.exit(8);
		if (mode === "bad-json") {
			process.stdout.write("not JSON\n");
			return;
		}
		if (mode === "oversize") {
			process.stdout.write("x".repeat(262_145));
			return;
		}
		if (mode === "exit") process.exit(1);
		if (mode === "unknown-request") {
			waiting.set("init", message.id);
			send({ id: "unknown-request", method: "unsupported/request", params: { secret: "never-render" } });
			return;
		}
		send({});
		send({ id: 9998, error: { code: -32601, message: "ignored" } });
		send({ method: "account/chatgptAuthTokens/refresh" });
		result(9999, { ignored: true });
		result(message.id, mode === "bad-init" ? [] : {});
	} else if (message.method === "account/login/start") {
		bound =
			message.params.type === "chatgptAuthTokens" &&
			message.params.chatgptAccountId === "synthetic-workspace" &&
			message.params.accessToken.startsWith("fixture.");
		result(message.id, { type: mode === "bad-login" ? "apiKey" : "chatgptAuthTokens" });
	} else if (message.method === "account/read") {
		result(message.id, {
			account: { type: bound && mode !== "bad-account" ? "chatgpt" : "apiKey" },
			requiresOpenaiAuth: true,
		});
	} else if (message.method === "account/rateLimits/read") {
		send({ method: "account/updated", params: { authMode: "chatgptAuthTokens" } });
		send({ method: "ignored/notification" });
		if (mode === "unsupported" || mode === "server-error") {
			send({ id: message.id, error: { code: mode === "unsupported" ? -32601 : -32600, message: "PRIVATE-RAW-ERROR" } });
			return;
		}
		if (mode === "refresh") {
			waiting.set("read", message.id);
			send({ id: "refresh-token", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } });
			return;
		}
		if (mode === "account-change") {
			send({ method: "account/updated", params: { authMode: "apikey" } });
			return;
		}
		if (mode === "read-hang") return;
		result(message.id, offers());
	} else if (message.method === "account/rateLimitResetCredit/consume") {
		if (message.params.creditId !== "fixture-grant" || !message.params.idempotencyKey) process.exit(9);
		const backend = state();
		const prior = backend.keys.includes(message.params.idempotencyKey);
		if (!prior) {
			backend.keys.push(message.params.idempotencyKey);
			backend.count = 0;
			backend.consumes++;
		}
		if (stateFile) writeFileSync(stateFile, JSON.stringify(backend), { mode: 0o600 });
		if (mode === "consume-hang") return;
		if (mode === "consume-exit") process.exit(2);
		result(message.id, { outcome: prior ? "alreadyRedeemed" : "reset" });
	}
});
