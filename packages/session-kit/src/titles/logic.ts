/** Pure logic for auto-titles: model order, prompt building and output sanitising. */

export const DEFAULT_TITLE_MODELS = ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"] as const;
export const MAX_USER_CHARS = 2000;
export const MAX_ASSISTANT_CHARS = 1000;
export const MAX_TITLE_CHARS = 60;
export const MAX_TITLE_WORDS = 6;

export const TITLE_SYSTEM_PROMPT =
	"You name coding-agent sessions. Reply with ONLY a title of 3 to 6 words that says what the session is about. No quotes, no punctuation, no preamble.";

export interface ModelRef {
	provider: string;
	id: string;
}

/** Parse `provider/id`; the id may itself contain slashes. */
export function parseModelRef(ref: string): ModelRef | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Logical model name -> `provider/id` candidates, lower-cased keys. */
export type ModelAliases = Readonly<Record<string, readonly string[]>>;

export const ALIAS_MANIFEST_VERSION = 1;
/** Logical alias names tried after the pinned default, in order. */
export const TITLE_ALIAS_NAMES = ["claude-haiku-5-5", "claude-haiku-4-5"] as const;

/**
 * Extract `subagents.modelAliases` from the machine-local manifest text. Mirrors pi-subagents:
 * rejects group/other-accessible files, a non-object or wrong-version manifest, and ignores
 * invalid alias entries. Silent on any problem; no other manifest field is read.
 */
export function parseModelAliases(text: string, mode: number): ModelAliases {
	if ((mode & 0o077) !== 0) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	if (!isRecord(raw) || raw.version !== ALIAS_MANIFEST_VERSION) return {};
	const subagents = raw.subagents;
	if (subagents === undefined || !isRecord(subagents)) return {};
	const rawAliases = subagents.modelAliases;
	if (!isRecord(rawAliases)) return {};
	const aliases: Record<string, string[]> = {};
	for (const [alias, rawCandidates] of Object.entries(rawAliases)) {
		const name = alias.trim().toLowerCase();
		const candidates = Array.isArray(rawCandidates)
			? rawCandidates
					.filter((c): c is string => typeof c === "string")
					.map((c) => c.trim())
					.filter(Boolean)
			: [];
		if (!name || name.includes("/") || name in aliases || candidates.length === 0) continue;
		if (candidates.some((c) => parseModelRef(c) === undefined)) continue;
		aliases[name] = [...new Set(candidates)];
	}
	return aliases;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Candidate models, best first: the configured one, the pinned default, the alias candidates for
 * each logical name, then the fallback default. Deduplicated.
 */
export function modelCandidates(titleModel?: string, aliases: ModelAliases = {}): ModelRef[] {
	const [primary, ...rest] = DEFAULT_TITLE_MODELS;
	const refs = [titleModel, primary, ...TITLE_ALIAS_NAMES.flatMap((name) => aliases[name] ?? []), ...rest];
	const seen = new Set<string>();
	const out: ModelRef[] = [];
	for (const ref of refs) {
		const parsed = ref === undefined ? undefined : parseModelRef(ref);
		if (!parsed) continue;
		const key = `${parsed.provider}/${parsed.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(parsed);
	}
	return out;
}

/** Flatten message content (string or content blocks) to its text blocks. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

export interface FirstExchange {
	user: string;
	assistant: string;
}

/** First user message and first assistant reply on a branch of session entries. */
export function firstExchange(entries: readonly unknown[]): FirstExchange | undefined {
	let user: string | undefined;
	let assistant: string | undefined;
	for (const entry of entries) {
		const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
		if ((entry as { type?: string }).type !== "message" || !message) continue;
		if (user === undefined && message.role === "user") user = contentText(message.content);
		else if (user !== undefined && assistant === undefined && message.role === "assistant") {
			assistant = contentText(message.content);
		}
		if (user !== undefined && assistant !== undefined) break;
	}
	if (!user?.trim()) return undefined;
	return { user, assistant: assistant ?? "" };
}

export function buildTitlePrompt(exchange: FirstExchange): string {
	const parts = [`User message:\n${exchange.user.slice(0, MAX_USER_CHARS)}`];
	if (exchange.assistant.trim()) {
		parts.push(`Assistant reply (start):\n${exchange.assistant.slice(0, MAX_ASSISTANT_CHARS)}`);
	}
	parts.push("Title (3-6 words, no quotes, no punctuation):");
	return parts.join("\n\n");
}

/** Strip quotes, newlines and trailing punctuation; cap at 6 words and 60 chars on a word boundary. */
export function sanitizeTitle(raw: string): string | undefined {
	const firstLine = raw.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
	let title = firstLine
		.replace(/^\s*(title|name)\s*:\s*/i, "")
		.replace(/["'`\u201c\u201d\u2018\u2019]/g, "")
		.replace(/[*_#]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.,;:!?\-\u2013\u2014]+$/, "")
		.trim();
	title = title.split(" ").slice(0, MAX_TITLE_WORDS).join(" ");
	if (title.length > MAX_TITLE_CHARS) {
		const cut = title.slice(0, MAX_TITLE_CHARS);
		const space = cut.lastIndexOf(" ");
		title = (space > 0 ? cut.slice(0, space) : cut).trim();
	}
	return title === "" ? undefined : title;
}

/** True when the newest `plan-mode-state` entry on the branch says planning is active. */
export function planModeActive(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { enabled?: unknown } };
		if (entry?.type === "custom" && entry.customType === "plan-mode-state") return entry.data?.enabled === true;
	}
	return false;
}
