/**
 * Path-scoped rules. `.pi/rules/*.md` (project) and `<agent dir>/rules/*.md` (user) carry a
 * `paths:` frontmatter of globs relative to the cwd. The first time `read`/`edit`/`write` touches a
 * matching file in a context window, the rule text is appended to that tool result. The system
 * prompt is never touched, so prompt caching survives.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KitConfig } from "../config.ts";
import {
	formatRules,
	INJECTED_ENTRY,
	type InjectedEntryData,
	injectedKeys,
	MAX_RULES_PER_TURN,
	matchesRule,
	parseRule,
	type Rule,
	relativeToCwd,
	TOOLS_WITH_PATH,
} from "./logic.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

/** Load every rule in a directory; a missing directory or unreadable file is skipped. */
export function loadRuleDir(dir: string, source: "project" | "user"): Rule[] {
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((n) => n.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	const rules: Rule[] = [];
	for (const name of names) {
		try {
			const rule = parseRule(`${source}:${name}`, readFileSync(path.join(dir, name), "utf8"));
			if (rule) rules.push(rule);
		} catch {
			// Unreadable file: ignore it, like a rule without `paths`.
		}
	}
	return rules;
}

export function register(pi: ExtensionAPI, _config: KitConfig, userAgentDir = agentDir()): void {
	let injected = new Set<string>();
	let turnCount = 0;

	const rebuild = (ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		injected = injectedKeys(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));
	pi.on("session_compact", () => {
		injected = new Set();
	});
	pi.on("turn_start", () => {
		turnCount = 0;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError || !TOOLS_WITH_PATH.has(event.toolName)) return;
		const raw = event.input.path;
		if (typeof raw !== "string") return;
		const rel = relativeToCwd(raw, ctx.cwd);
		if (rel === undefined) return;

		const rules = [
			...loadRuleDir(path.join(ctx.cwd, ".pi", "rules"), "project"),
			...loadRuleDir(path.join(userAgentDir, "rules"), "user"),
		];
		const fresh: Rule[] = [];
		for (const rule of rules) {
			if (turnCount + fresh.length >= MAX_RULES_PER_TURN) break;
			if (!injected.has(rule.id) && matchesRule(rule, rel)) fresh.push(rule);
		}
		if (fresh.length === 0) return;

		for (const rule of fresh) {
			injected.add(rule.id);
			pi.appendEntry<InjectedEntryData>(INJECTED_ENTRY, { rule: rule.id });
		}
		turnCount += fresh.length;
		return { content: [...event.content, { type: "text" as const, text: formatRules(fresh) }] };
	});
}
