/**
 * Real workspace factory, not synthetic registrations. Child package discovery cannot pass
 * SessionKitOptions, so this loader adapter shares the parent's controlled clock/spawn.
 * child-tools.test.ts proves hidden provenance and denied calls in both load orders, plus
 * zero ControlledProcesses spawns. Loading the default entry would bypass that last check
 * and could launch a real process if the child guard regressed. Keep this injection boundary.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionKit, type SessionKitOptions } from "../../../../packages/session-kit/src/index.ts";

export const OPTIONS = Symbol.for("pi-stack-tests:kit-options");

export default function childKit(pi: ExtensionAPI): void {
	const options = (globalThis as Record<symbol, unknown>)[OPTIONS] as SessionKitOptions | undefined;
	if (!options) throw new Error("Controlled kit options missing");
	createSessionKit(options)(pi);
}
