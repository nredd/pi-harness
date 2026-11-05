// The "skills and agents name tiers, never models" guard (#364, #501, #505), shared by the preset's
// resource tests and the subagents default-agent tests. Not a test file (no `.test.ts` suffix).
//
// The guard parses what is structured instead of pattern-matching prose: frontmatter and fenced
// YAML/JSON go through a YAML parser, and everything else (prose, inline code, `Agent(...)` call
// arguments, flow lists and maps, `--model` flags) through a small key/value tokenizer. Every value
// under a model-like key must be a tier reference. A separate, best-effort prose scan catches model
// ids and family names written without a key.
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** A tier reference, the only model value a skill or agent may name. */
export const TIER_REF = /^@[a-z0-9][a-z0-9._-]*$/;

/** A key the tokenizer may read: an identifier, optionally a `-`/`--` flag. Rules out `a/b` prose. */
const KEY_SHAPE = /^-{0,2}[A-Za-z_][\w.-]*$/;
/** Fenced block languages whose body is data, parsed as YAML (a JSON superset). */
const DATA_FENCES = new Set(["json", "jsonc", "yaml", "yml"]);
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

/**
 * Model ids written as prose, with no key to parse. Best-effort: provider-qualified refs, versioned
 * ids and the family names that fuzzy model matching resolves.
 */
const MODEL_ID_PATTERNS = [
	/\b(?:anthropic|openai(?:-codex)?|google|openrouter|router|bedrock|vertex|azure|xai|mistral|deepseek)\/[\w.-]+/gi,
	/\bclaude-(?!code\b)[\w.-]+/gi,
	/\bgpt[- ]?\d[\w.-]*/gi,
	/\b(?:gemini|o\d)-[\w.-]*/gi,
	/\b(?:opus|sonnet|haiku|fable|astra|gemini)\b/gi,
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
 * comma (`@frontier,opus`), every value in a flow list or map, or "" when the value is missing.
 */
function valuesAt(tokens: Token[], index: number): string[] {
	const first = tokens[index];
	if (isPunct(first, "[") || isPunct(first, "{")) return bracketValues(tokens, index);
	if (!isScalar(first) || (first.kind === "word" && first.text.startsWith("-"))) return [""];
	const values = [first.text];
	for (let i = index; ; i += 2) {
		const [prev, comma, next] = [tokens[i] as Token, tokens[i + 1], tokens[i + 2]];
		if (!isPunct(comma, ",") || !isScalar(next) || isAssign(tokens[i + 3])) break;
		if (comma?.start !== prev.end || next.start !== comma.end) break;
		values.push(next.text);
	}
	return values;
}

/** Every value of a model-like key in free text: `key: v`, `key = v`, `"key": v` and `--model v`. */
function textModelValues(text: string): string[] {
	const tokens = tokenize(text);
	const values: string[] = [];
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
export function dataModelValues(data: unknown, modelled = false): string[] {
	if (data === undefined) return [];
	if (data !== null && typeof data === "object")
		return Object.entries(data).flatMap(([key, value]) =>
			dataModelValues(value, modelled || (!Array.isArray(data) && isModelKey(key))),
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

const nonTier = (values: string[]): string[] => values.filter((value) => !TIER_REF.test(value));

/** Everything in a Markdown resource that names a model instead of a tier. */
export const modelLeaks = (text: string): string[] => [
	...new Set([...nonTier(modelValues(text)), ...proseModelIds(text)]),
];

/** Everything in parsed data (e.g. an agent config object) that names a model instead of a tier. */
export const dataModelLeaks = (data: unknown): string[] => [
	...new Set([...nonTier(dataModelValues(data)), ...strings(data).flatMap(proseModelIds)]),
];
