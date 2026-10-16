/** Pure logic for path-scoped rules: parsing, path resolution, glob matching, injection text. */

import { homedir } from "node:os";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MAX_RULES_PER_TURN = 8;
export const MAX_RULE_BYTES = 4096;
export const INJECTED_ENTRY = "session-kit:rule-injected";
export const TOOLS_WITH_PATH = new Set(["read", "edit", "write"]);

export interface Rule {
	/** Stable id, `project:<file>` or `user:<file>`. */
	id: string;
	globs: string[];
	body: string;
}

export interface InjectedEntryData {
	rule: string;
}

/** Parse a rule file. Returns undefined when it has no usable `paths`, an empty body or bad YAML. */
export function parseRule(id: string, content: string): Rule | undefined {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(content);
	} catch {
		return undefined;
	}
	const raw = parsed.frontmatter.paths;
	const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
	const globs = list.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim());
	const body = parsed.body.trim();
	if (globs.length === 0 || body === "") return undefined;
	return { id, globs, body };
}

/** Touched path relative to `cwd` with `/` separators; undefined when outside `cwd`. */
export function relativeToCwd(raw: string, cwd: string, home = homedir()): string | undefined {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~") p = home;
	else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
	const rel = path.relative(cwd, path.resolve(cwd, p));
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
	return rel.split(path.sep).join("/");
}

export function matchesRule(rule: Rule, relPath: string): boolean {
	return rule.globs.some((glob) => {
		try {
			return path.posix.matchesGlob(relPath, glob);
		} catch {
			return false;
		}
	});
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, cut on a code point boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		bytes += Buffer.byteLength(char);
		if (bytes > maxBytes) break;
		end += char.length;
	}
	return text.slice(0, end);
}

/** One rule's appended block: label + body (+ truncation notice), never over `maxBytes` UTF-8 bytes. */
export function formatRule(rule: Rule, maxBytes = MAX_RULE_BYTES): string {
	const head = `\n\n[pi-session-kit rule: ${rule.id}]\n`;
	const full = head + rule.body;
	if (Buffer.byteLength(full) <= maxBytes) return full;
	const notice = `\n[rule truncated at ${maxBytes} bytes]`;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(head) - Buffer.byteLength(notice));
	return head + truncateUtf8(rule.body, budget).trimEnd() + notice;
}

export function formatRules(rules: readonly Rule[]): string {
	return rules.map((r) => formatRule(r)).join("");
}

/** Rule ids still active on a branch: injections after the newest compaction. */
export function injectedKeys(entries: readonly unknown[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: Partial<InjectedEntryData> };
		if (e?.type === "compaction") keys.clear();
		else if (e?.type === "custom" && e.customType === INJECTED_ENTRY) {
			if (typeof e.data?.rule === "string") keys.add(e.data.rule);
		}
	}
	return keys;
}
