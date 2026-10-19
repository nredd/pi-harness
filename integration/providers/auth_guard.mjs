// Missing NODE_OPTIONS support is fatal before fake OAuth credentials can dispatch.
import { ExtensionStartupError } from "@earendil-works/pi-coding-agent";

async function verifyTransport() {
	const mock = process.env.HARNESS_ANTHROPIC_MOCK;
	const nonce = process.env.HARNESS_AUTH_NONCE;
	const installed = globalThis[Symbol.for("pi-harness.auth-redirect")];
	if (!mock || !nonce || installed?.mock !== mock || installed?.nonce !== nonce) {
		throw new Error("Auth transport NOT RUN: redirect preload is missing in this runtime");
	}
	let refused = false;
	try {
		await fetch("https://pi-harness-egress.invalid/never-send");
	} catch (error) {
		refused = error instanceof Error && error.message.includes("harness refused non-loopback fetch");
	}
	if (!refused) throw new Error("Auth transport guard did not refuse non-loopback fetch");
	const response = await fetch(`${mock}/__harness_ready__?nonce=${encodeURIComponent(nonce)}`);
	const ready = await response.json();
	if (!response.ok || ready.nonce !== nonce) throw new Error("Auth transport loopback readiness nonce did not match");
}

export default function guardAuthTransport(pi) {
	pi.on("session_start", async () => {
		try {
			await verifyTransport();
		} catch (error) {
			throw new ExtensionStartupError(`Auth transport guard failed: ${String(error)}`);
		}
	});
}
