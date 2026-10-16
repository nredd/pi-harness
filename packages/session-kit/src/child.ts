/**
 * Subagent child-session detection.
 *
 * `pi-subagents` runs children in-process and loads extensions into them, but its own child
 * marker is a private `AsyncLocalStorage`, unreachable from another package. It names every child
 * session `<agent type>#<first 8 chars of the agent id>` before `session_start` fires, so that
 * name bootstraps a session-bound custom entry so renaming and reloading cannot lose identity.
 * TODO: replace the name heuristic if `pi-subagents` ever exports a shared marker.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const CHILD_NAME = /#[0-9a-f]{8}$/;
export const CHILD_ENTRY = "session-kit:child";

const identities = new WeakMap<object, { child: boolean }>();

/**
 * Register once, at the beginning of a module factory, before its session rebuild hooks.
 * Runtime APIs are unbound during factory loading; inspect only the active branch on startup.
 * Include the session id because forks/fresh Plan sessions can inherit a parent's entries.
 */
export function registerChildIdentity(pi: ExtensionAPI): void {
	if (identities.has(pi)) return;
	const identity = { child: false };
	identities.set(pi, identity);
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const marked = ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== CHILD_ENTRY) return false;
			const data = entry.data as { version?: unknown; sessionId?: unknown } | null;
			return data?.version === 1 && data.sessionId === sessionId;
		});
		identity.child = marked || isChildSessionName(pi.getSessionName());
		if (identity.child && !marked) pi.appendEntry(CHILD_ENTRY, { version: 1, sessionId });
	});
	pi.on("session_shutdown", () => {
		identity.child = false;
	});
}

export function isChildSessionName(name: string | undefined): boolean {
	return name !== undefined && CHILD_NAME.test(name);
}

export function isChildSession(pi: Pick<ExtensionAPI, "getSessionName">): boolean {
	return identities.get(pi)?.child === true || isChildSessionName(pi.getSessionName());
}

/**
 * Withdraw a parent-only capability at child binding, not merely from the active set.
 *
 * Child scoping reactivates registered tools after `session_start`; deferred promotion can
 * do so again later. Pi's public `hidden` exposure prevents both schema activation and nested
 * execution. Keep call-time guards too, including after a child renames its session.
 */
export function registerParentTool<TParams extends TSchema, TDetails, TState>(
	pi: ExtensionAPI,
	tool: ToolDefinition<TParams, TDetails, TState>,
): void {
	registerChildIdentity(pi);
	const reason = `${tool.name} is not available in subagents`;
	const guarded: ToolDefinition<TParams, TDetails, TState> = {
		...tool,
		async execute(...args) {
			if (isChildSession(pi)) throw new Error(reason);
			return tool.execute(...args);
		},
	};
	pi.registerTool(guarded);
	pi.on("session_start", () => {
		pi.registerTool(isChildSession(pi) ? { ...guarded, exposure: "hidden" } : guarded);
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === tool.name && isChildSession(pi)) return { block: true, reason };
		return undefined;
	});
}
