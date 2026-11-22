/**
 * Reject a bare regular expression literal in the expected value of a Vitest `toMatchObject` call (#1299).
 *
 * Vitest's subset equality treats an expected `RegExp` as an object with no own keys, so
 * `expect({ message: "zzz" }).toMatchObject({ message: /x/ })` passes for ANY present value: the
 * regex is never matched. `expect.stringMatching(/x/)` (or an exact string) does what such tests mean.
 * `toEqual`, `toStrictEqual`, `objectContaining` and `arrayContaining` compare a `RegExp` by
 * equality instead, so a bare regex there fails against a string rather than passing vacuously.
 *
 * Syntactic, via the installed `tsgo` parser like `import_audit.ts`: the walk follows object and array
 * literals (and parentheses, `as`, `satisfies`, spreads and both conditional branches) inside each
 * argument, and stops at any other expression. A regex spread into an object (`{ ...(/x/) }`) adds no
 * keys, so it is not an expected value. Calls are recognized as `.toMatchObject(...)` or
 * `["toMatchObject"](...)`. A regex reached through a variable, a helper call or `new RegExp(...)` is not seen.
 *
 * CLI: `node scripts/check-test-matchers.ts` checks every owned JS/TS test source and exits 1 on findings.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Expression, Node, SourceFile } from "typescript/unstable/ast";
import {
	isArrayLiteralExpression,
	isAsExpression,
	isCallExpression,
	isConditionalExpression,
	isElementAccessExpression,
	isObjectLiteralExpression,
	isParenthesizedExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isRegularExpressionLiteral,
	isSatisfiesExpression,
	isSpreadAssignment,
	isSpreadElement,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/async";
import { listOwnedTestSources } from "./check-test-tempdirs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const MATCHER = "toMatchObject";
const FIX = "matches any value; use expect.stringMatching(...) or an exact value";

/** Parse-only project: no lib, no type roots, and no module resolution, so nothing is followed. */
const PARSE_ONLY_OPTIONS = {
	allowJs: true,
	noLib: true,
	noResolve: true,
	types: [],
	target: "esnext",
	module: "esnext",
};

/** Report every bare regex literal reachable through literals in the arguments of a `toMatchObject` call. */
export function findVacuousMatchers(file: SourceFile, name: string): string[] {
	const problems: string[] = [];

	/** Walk `node`; `stored` is false for an object spread operand, whose own regex contributes no keys. */
	function expected(node: Expression, stored = true): void {
		if (isRegularExpressionLiteral(node)) {
			if (!stored) return;
			const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
			problems.push(`${name}:${line + 1}:${character + 1}: bare ${node.text} in ${MATCHER} ${FIX}`);
		} else if (
			isParenthesizedExpression(node) ||
			isAsExpression(node) ||
			isSatisfiesExpression(node) ||
			isSpreadElement(node)
		) {
			expected(node.expression, stored);
		} else if (isConditionalExpression(node)) {
			expected(node.whenTrue, stored);
			expected(node.whenFalse, stored);
		} else if (isArrayLiteralExpression(node)) {
			for (const element of node.elements) expected(element);
		} else if (isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				if (isPropertyAssignment(property)) expected(property.initializer);
				else if (isSpreadAssignment(property)) expected(property.expression, false);
			}
		}
	}

	/** Whether `callee` names the matcher as `.toMatchObject` or `["toMatchObject"]`. */
	function isMatcher(callee: Expression): boolean {
		if (isPropertyAccessExpression(callee)) return callee.name.text === MATCHER;
		return (
			isElementAccessExpression(callee) &&
			isStringLiteral(callee.argumentExpression) &&
			callee.argumentExpression.text === MATCHER
		);
	}

	function visit(node: Node): void {
		if (isCallExpression(node) && isMatcher(node.expression)) {
			for (const argument of node.arguments) expected(argument);
		}
		node.forEachChild(visit);
	}

	visit(file);
	return problems;
}

/**
 * Parse `files` (relative to `cwd`) in one `tsgo` session and collect every finding.
 *
 * The parse-only project lives in a private temporary directory, so the checkout is never written.
 * The directory is removed on every exit, including a failed config write or session close.
 * A file that does not parse is a finding too: matchers in it cannot be trusted to be complete.
 */
export async function checkFiles(cwd: string, files: readonly string[]): Promise<string[]> {
	if (files.length === 0) return [];
	const configDir = mkdtempSync(join(tmpdir(), "pi-test-matchers-"));
	try {
		const configPath = join(configDir, "tsconfig.json");
		writeFileSync(
			configPath,
			JSON.stringify({ compilerOptions: PARSE_ONLY_OPTIONS, files: files.map((file) => join(cwd, file)) }),
		);
		const api = new API({ cwd: configDir });
		try {
			const project = (await api.updateSnapshot({ openProject: configPath })).getProject(configPath);
			if (project === undefined) throw new Error(`tsgo did not open the project '${configPath}'`);
			const problems: string[] = [];
			for (const name of files) {
				const path = join(cwd, name);
				const file = await project.program.getSourceFile(path);
				if (file === undefined) throw new Error(`tsgo did not load '${name}'`);
				problems.push(...findVacuousMatchers(file, name));
				for (const issue of await project.program.getSyntacticDiagnostics(path)) {
					const { line, character } = file.getLineAndCharacterOfPosition(issue.pos);
					problems.push(`${name}:${line + 1}:${character + 1}: syntax error: ${issue.text}`);
				}
			}
			return problems;
		} finally {
			await api.close();
		}
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
}

/** Check every owned JS/TS test source in the `cwd` checkout. */
export async function checkTestMatchers(cwd: string): Promise<string[]> {
	return await checkFiles(cwd, listOwnedTestSources(cwd));
}

/** Apply the contract at the CLI boundary. */
export async function dispatch(isMain: boolean, check = checkTestMatchers): Promise<void> {
	if (!isMain) return;
	const problems = await check(root);
	for (const problem of problems) console.error(problem);
	process.exitCode = problems.length ? 1 : 0;
}

await dispatch(import.meta.main);
