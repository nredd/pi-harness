// The "skills and agents name tiers, never models" guard (#364, #501, #505), shared by the preset's
// resource tests and the subagents default-agent tests. Not a test file (no `.test.ts` suffix).
//
// The guard parses what is structured instead of pattern-matching prose: frontmatter and fenced
// YAML/JSON go through a YAML parser, and everything else (prose, inline code, `Agent(...)` call
// arguments, flow lists and maps, `--model` flags) through a small key/value tokenizer, plus GFM
// tables with a model-like header column. Every value under a model-like key must be a tier
// reference, optionally with a thinking suffix (`@review:high`). A separate, best-effort prose scan catches model
// ids and family names written without a key.
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** A tier reference, the only model value a skill or agent may name. */
export const TIER_REF = /^@[a-z0-9][a-z0-9._-]*$/;
/** A trailing thinking level, as in pi's `--models @review:high`; stripped before the `TIER_REF` check. */
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh)$/;

/** A key the tokenizer may read: an identifier, optionally a `-`/`--` flag. Rules out `a/b` prose. */
const KEY_SHAPE = /^-{0,2}[A-Za-z_][\w.-]*$/;
/** Fenced block languages whose body is data, parsed as YAML (a JSON superset). */
const DATA_FENCES = new Set(["json", "jsonc", "yaml", "yml"]);
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

/**
 * Model ids written as prose, with no key to parse. Best-effort: provider-qualified refs, versioned
 * ids and the family names that fuzzy model matching resolves. Slash refs need a known provider
 * prefix, since a generic `a/b` rule flags every path; `local/` is left out because it matches
 * `/usr/local/bin`. A keyed value is caught structurally whatever its provider.
 */
const MODEL_ID_PATTERNS = [
	/\b(?:anthropic|openai(?:-codex)?|google|openrouter|router|bedrock|vertex|azure|xai|mistral|deepseek|groq|ollama|together|meta)\/[\w.-]+/gi,
	/\bclaude-(?!code\b)[\w.-]+/gi,
	/\bgpt[- ]?\d[\w.-]*/gi,
	/\b(?:gemini[\w.-]*|o\d-[\w.-]*)/gi,
	/\b(?:opus|sonnet|haiku|fable|astra)[\d_.-]*\b/gi,
];

/** Whether a key names a model: a `model` or `models` word in any snake, kebab, camel or flag spelling. */
export const isModelKey = (key: string): boolean =>
	key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.some((word) => word === "model" || word === "models");

/** YAML (or JSON) source parsed through Pi's own frontmatter reader; `undefined` when it does not parse. */
function parseData(source: string): unknown {
	try {
		return parseFrontmatter(`---\n${source}\n---\n`).frontmatter;
	} catch {
		return undefined;
	}
}

interface Token {
	kind: "newline" | "quoted" | "punct" | "word";
	text: string;
	start: number;
	end: number;
}

/**
 * Newlines, quoted strings, the punctuation `: = , ( ) [ ] { }`, and words. Backticks, `;` and other
 * whitespace separate tokens, so `` `model: opus` `` and `` model: `opus` `` read like `model: opus`.
 * A word may carry an apostrophe (`parent's`) but never start with one.
 */
const TOKEN =
	/(\n)|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([:=,()[\]{}])|([^\s"'`:=,;()[\]{}][^\s"`:=,;()[\]{}]*)|[^\S\n]+|[\s\S]/gy;

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	TOKEN.lastIndex = 0;
	for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
		const [whole, newline, double, single, punct, word] = match;
		const span = { start: match.index, end: match.index + whole.length };
		if (newline !== undefined) tokens.push({ kind: "newline", text: newline, ...span });
		else if (double !== undefined) tokens.push({ kind: "quoted", text: double, ...span });
		else if (single !== undefined) tokens.push({ kind: "quoted", text: single, ...span });
		else if (punct !== undefined) tokens.push({ kind: "punct", text: punct, ...span });
		else if (word !== undefined) tokens.push({ kind: "word", text: word, ...span });
	}
	return tokens;
}

const isScalar = (token: Token | undefined): token is Token => token?.kind === "word" || token?.kind === "quoted";
const isAssign = (token: Token | undefined): boolean => token?.text === ":" || token?.text === "=";
const isPunct = (token: Token | undefined, text: string): boolean => token?.kind === "punct" && token.text === text;
/** Whether `b` starts exactly where `a` ends, i.e. no whitespace or separator between them. */
const touches = (a: Token | undefined, b: Token | undefined): boolean => a !== undefined && b?.start === a.end;
/** Whether the word at `index` continues as `:word` with no whitespace (`o3:high`), so it is one value. */
const isJoined = (tokens: Token[], index: number): boolean =>
	tokens[index]?.kind === "word" &&
	isPunct(tokens[index + 1], ":") &&
	touches(tokens[index], tokens[index + 1]) &&
	tokens[index + 2]?.kind === "word" &&
	touches(tokens[index + 1], tokens[index + 2]);

/** Scalars in value position between a `[`/`{` at `open` and its matching close; keys are skipped. */
function bracketValues(tokens: Token[], open: number): string[] {
	const values: string[] = [];
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const token = tokens[i] as Token;
		if (isPunct(token, "[") || isPunct(token, "{")) depth++;
		else if (isPunct(token, "]") || isPunct(token, "}")) depth--;
		else if (isScalar(token) && !isAssign(tokens[i + 1])) values.push(token.text);
		if (depth === 0) break;
	}
	return values;
}

/**
 * The value(s) starting at `index`: a scalar plus any comma-joined scalars with no space around the
 * comma (`@frontier,opus`), every value in a flow list or map, or "" when the value is missing. A
 * `word:word` with no whitespace is one value (`o3:high`, `@review:high`); a scalar followed by `=`,
 * or by a `:` that is not joined that way, is the next key and ends the chain.
 *
 * Known limit: a space after the comma (`model: @frontier, opus`) reads as prose and ends the value,
 * so the guard does not see `opus` there. Flow lists (`[@frontier, opus]`) have no such limit.
 */
function valuesAt(tokens: Token[], index: number): string[] {
	const first = tokens[index];
	if (isPunct(first, "[") || isPunct(first, "{")) return bracketValues(tokens, index);
	if (!isScalar(first) || (first.kind === "word" && first.text.startsWith("-"))) return [""];
	const values: string[] = [];
	for (let i = index; ; ) {
		let text = (tokens[i] as Token).text;
		for (; isJoined(tokens, i); i += 2) text += `:${(tokens[i + 2] as Token).text}`;
		values.push(text);
		const [comma, next] = [tokens[i + 1], tokens[i + 2]];
		if (!isPunct(comma, ",") || !isScalar(next) || !touches(tokens[i], comma) || !touches(comma, next)) break;
		if (isAssign(tokens[i + 3]) && !isJoined(tokens, i + 2)) break;
		i += 2;
	}
	return values;
}

/** The cells of one GFM table row, without the outer pipes; `\|` stays inside its cell. */
const tableCells = (line: string): string[] =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Every cell under a model-like header (`| agent | model |`) in a GFM table, with backticks and
 * surrounding emphasis removed; an empty cell reads as "".
 */
function tableModelValues(text: string): string[] {
	const lines = text.split("\n");
	const values: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const header = lines[i - 1] as string;
		if (!header.includes("|") || !TABLE_DELIMITER.test(lines[i] as string)) continue;
		const columns = tableCells(header).flatMap((cell, column) =>
			isModelKey(cell.replace(/[`*_]/g, "")) ? [column] : [],
		);
		for (i++; i < lines.length && (lines[i] as string).includes("|"); i++) {
			const cells = tableCells(lines[i] as string);
			for (const column of columns) values.push((cells[column] ?? "").replace(/^[`*_]+|[`*_]+$/g, ""));
		}
	}
	return values;
}

/**
 * Every value of a model-like key in free text: `key: v`, `key = v`, `"key": v`, `--model v` and
 * the model column of a GFM table.
 */
function textModelValues(text: string): string[] {
	const tokens = tokenize(text);
	const values = tableModelValues(text);
	tokens.forEach((token, i) => {
		if (!isScalar(token) || !KEY_SHAPE.test(token.text) || !isModelKey(token.text)) return;
		if (isAssign(tokens[i + 1])) values.push(...valuesAt(tokens, i + 2));
		else if (token.text.startsWith("--")) values.push(...valuesAt(tokens, i + 1));
	});
	return values;
}

/** Every string inside parsed data, recursively. */
function strings(data: unknown): string[] {
	if (typeof data === "string") return [data];
	if (data !== null && typeof data === "object") return Object.values(data).flatMap(strings);
	return [];
}

/**
 * Every model value in parsed data: each leaf under a model-like key at any depth (`null` reads as
 * ""), plus the model values written inside any string leaf.
 */
export const dataModelValues = (data: unknown): string[] => nestedModelValues(data, false);

/** `dataModelValues` below one node; `modelled` says whether a model-like key sits above it. */
function nestedModelValues(data: unknown, modelled: boolean): string[] {
	if (data === undefined) return [];
	if (data !== null && typeof data === "object")
		return Object.entries(data).flatMap(([key, value]) =>
			nestedModelValues(value, modelled || (!Array.isArray(data) && isModelKey(key))),
		);
	return [
		...(modelled ? [data === null ? "" : String(data)] : []),
		...(typeof data === "string" ? textModelValues(data) : []),
	];
}

/**
 * Every model value in a Markdown resource: frontmatter, fenced YAML/JSON blocks, and keys, call
 * arguments and `--model` flags in the remaining text. Deduplicated, in order of discovery.
 */
export function modelValues(text: string): string[] {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const values = dataModelValues(frontmatter);
	const prose = body.replace(FENCE, (block, _fence, lang: string, source: string) => {
		if (!DATA_FENCES.has(lang.toLowerCase())) return block;
		const data = parseData(source);
		if (data === undefined) return block;
		values.push(...dataModelValues(data));
		return "\n";
	});
	return [...new Set([...values, ...textModelValues(prose)])];
}

/** Model ids and family names written as prose; see `MODEL_ID_PATTERNS`. */
export const proseModelIds = (text: string): string[] =>
	MODEL_ID_PATTERNS.flatMap((pattern) => text.match(pattern) ?? []);

/** Whether a value is a tier reference, with or without a thinking suffix. */
export const isTierRef = (value: string): boolean => TIER_REF.test(value.replace(THINKING_SUFFIX, ""));

const nonTier = (values: string[]): string[] => values.filter((value) => !isTierRef(value));

/** Everything in a Markdown resource that names a model instead of a tier. */
export const modelLeaks = (text: string): string[] => [
	...new Set([...nonTier(modelValues(text)), ...proseModelIds(text)]),
];

/** Everything in parsed data (e.g. an agent config object) that names a model instead of a tier. */
export const dataModelLeaks = (data: unknown): string[] => [
	...new Set([...nonTier(dataModelValues(data)), ...strings(data).flatMap(proseModelIds)]),
];
