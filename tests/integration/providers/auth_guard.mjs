// Missing runtime-hook support is fatal before fake OAuth credentials can dispatch.
import { ExtensionStartupError } from "@earendil-works/pi-coding-agent";

import { verifyTransport } from "./auth_transport.mjs";

export default async function guardAuthTransport() {
	// Factories finish before any session_start handler (including router usage warmup).
	try {
		await verifyTransport();
	} catch (error) {
		throw new ExtensionStartupError(`Auth transport guard failed: ${String(error)}`);
	}
}
