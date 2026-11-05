// The "skills and agents name tiers, never models" guard (#364, #501, #505), shared by the preset's
// resource tests and the subagents default-agent tests. Not a test file (no `.test.ts` suffix).
//
// The guard parses what is structured instead of pattern-matching prose: frontmatter and fenced
// YAML/JSON go through a YAML parser, and everything else (prose, inline code, `Agent(...)` call
// arguments, flow lists and maps, `--model` flags) through a small key/value tokenizer, plus GFM
// tables with a model-like header column. Every value under a model-like key must be a tier
// reference. Only pi's `--model`/`--models` flags may add a thinking suffix (`@review:high`):
// pi-subagents never parses one, so `model: "@review:high"` would run unmapped on the parent model. A separate, best-effort prose scan catches model
// ids and family names written without a key.
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** A tier reference, the only model value a skill or agent may name. */
export const TIER_REF = /^@[a-z0-9][a-z0-9._-]*$/;
/** A trailing thinking level, as in pi's `--models @review:high`; stripped from flag values only. */
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
 * Newlines, quoted strings, the punctuation `: = , ( ) [ ] { }`, and words. Backticks, `;`, other
 * whitespace and comment markers (`#`, `//`, `<!--`, `-->`) separate tokens, so `` `model: opus` ``,
 * `#model: opus` and `<!--model:opus-->` read like `model: opus`. A word may carry an apostrophe
 * (`parent's`) or an inner `#` (`C#`) but never start with either.
 */
const TOKEN =
	/(\n)|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([:=,()[\]{}])|#+|\/\/|<!--|-->|((?:(?!-->)[^\s"'`:=,;()[\]{}#])(?:(?!-->)[^\s"`:=,;()[\]{}])*)|[^\S\n]+|[\s\S]/gy;

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

/** The index of the last token of the value starting at `index`, past any joined `:word` parts. */
function valueEnd(tokens: Token[], index: number): number {
	let end = index;
	while (isJoined(tokens, end)) end += 2;
	return end;
}

/**
 * The value(s) starting at `index`: a scalar plus any comma-joined scalars, every value in a flow
 * list or map, or "" when the value is missing. A `word:word` with no whitespace is one value
 * (`o3:high`, `@review:high`).
 *
 * With no space around the comma (`@frontier,opus`) the chain goes on until a scalar followed by `=`
 * or an unjoined `:`, which is the next key. With a space (`@frontier, opus`) the next scalar joins
 * only when it stands alone, i.e. ends the line or is followed by another comma, so prose such as
 * `model: @frontier, then run it` ends the value.
 */
function valuesAt(tokens: Token[], index: number): string[] {
	const first = tokens[index];
	if (isPunct(first, "[") || isPunct(first, "{")) return bracketValues(tokens, index);
	if (!isScalar(first) || (first.kind === "word" && first.text.startsWith("-"))) return [""];
	const values: string[] = [];
	for (let i = index; ; i += 2) {
		const start = i;
		i = valueEnd(tokens, i);
		values.push(
			tokens
				.slice(start, i + 1)
				.map((token) => token.text)
				.join(""),
		);
		const [comma, next] = [tokens[i + 1], tokens[i + 2]];
		if (!isPunct(comma, ",") || !isScalar(next)) break;
		const after = tokens[valueEnd(tokens, i + 2) + 1];
		if (touches(tokens[i], comma) && touches(comma, next)) {
			if (isAssign(after)) break;
		} else if (after !== undefined && after.kind !== "newline" && !isPunct(after, ",")) break;
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
 * the model column of a GFM table. A `--flag` value may carry a thinking suffix, which is dropped.
 */
function textModelValues(text: string): string[] {
	const tokens = tokenize(text);
	const values = tableModelValues(text);
	tokens.forEach((token, i) => {
		if (!isScalar(token) || !KEY_SHAPE.test(token.text) || !isModelKey(token.text)) return;
		const flag = token.kind === "word" && token.text.startsWith("--");
		const found = isAssign(tokens[i + 1]) ? valuesAt(tokens, i + 2) : flag ? valuesAt(tokens, i + 1) : [];
		values.push(...(flag ? found.map((value) => value.replace(THINKING_SUFFIX, "")) : found));
	});
	return values;
}

/** The text of every `#` or `//` comment in a data fence; YAML and JSONC parsing drop them. */
const fenceComments = (source: string): string =>
	[...source.matchAll(/(?:^|\s)(?:#|\/\/)(.*)$/gm)].map((match) => match[1]).join("\n");

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
const dataModelValues = (data: unknown): string[] => nestedModelValues(data, false);

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
		values.push(...dataModelValues(data), ...textModelValues(fenceComments(source)));
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
