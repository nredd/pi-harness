/** Loader adapter injects only existing production options; child scope is the real kit's work. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionKit, type SessionKitOptions } from "../../../../packages/session-kit/src/index.ts";

export const OPTIONS = Symbol.for("pi-stack-tests:kit-options");

export default function childKit(pi: ExtensionAPI): void {
	const options = (globalThis as Record<symbol, unknown>)[OPTIONS] as SessionKitOptions | undefined;
	if (!options) throw new Error("Controlled kit options missing");
	createSessionKit(options)(pi);
}
