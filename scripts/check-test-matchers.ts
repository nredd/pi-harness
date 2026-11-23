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
 * `["toMatchObject"](...)`.
 *
 * A name (or shorthand property) is followed into its initializer only under ONE conservative rule (#1302):
 * the file binds that name exactly once, as a plain `const name = ...` statement directly in the file or
 * a block, and that scope contains the use. Anything else (`let`, `var`, `using`, destructuring, a
 * second binding anywhere that could shadow it, a case clause or namespace scope, a free global) is not
 * followed, so shadowing can only cause a miss. A `const` fixes the binding, not its contents: a name that
 * appears in a write target anywhere in the file (assignment, `++`/`--`, `delete`, the first argument of
 * `Object.assign`, `defineProperty`, `defineProperties` or `fromEntries`) and any use inside a `with` body
 * are not followed either. A write through an alias or a call is not tracked, so a regex later overwritten
 * that way can still be reported. A regex reached through a helper call, `new RegExp(...)` or another
 * module is not seen. Each initializer is walked at most once per matcher call and stored mode, so shared
 * initializers (`const a2 = [a1, a1]`) cost linear work and a revisit adds no finding.
 *
 * CLI: `node scripts/check-test-matchers.ts` checks every owned JS/TS test source and exits 1 on findings.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Expression, Identifier, Node, SourceFile } from "typescript/unstable/ast";
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import {
	isArrayLiteralExpression,
	isAsExpression,
	isBinaryExpression,
	isBindingElement,
	isBlock,
	isCallExpression,
	isClassDeclaration,
	isClassExpression,
	isConditionalExpression,
	isDeleteExpression,
	isElementAccessExpression,
	isEnumDeclaration,
	isFunctionDeclaration,
	isFunctionExpression,
	isIdentifier,
	isImportClause,
	isImportEqualsDeclaration,
	isImportSpecifier,
	isModuleDeclaration,
	isNamespaceImport,
	isNonNullExpression,
	isObjectLiteralExpression,
	isParameterDeclaration,
	isParenthesizedExpression,
	isPostfixUnaryExpression,
	isPrefixUnaryExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isRegularExpressionLiteral,
	isSatisfiesExpression,
	isShorthandPropertyAssignment,
	isSourceFile,
	isSpreadAssignment,
	isSpreadElement,
	isStringLiteral,
	isVariableDeclaration,
	isVariableDeclarationList,
	isVariableStatement,
	isWithStatement,
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

/** Declarations whose identifier `name` binds a value or namespace in some scope of the file. */
const BINDS = [
	isVariableDeclaration,
	isParameterDeclaration,
	isBindingElement,
	isFunctionDeclaration,
	isFunctionExpression,
	isClassDeclaration,
	isClassExpression,
	isImportClause,
	isImportSpecifier,
	isNamespaceImport,
	isImportEqualsDeclaration,
	isEnumDeclaration,
	isModuleDeclaration,
];

/**
 * `Object` methods whose first argument counts as written. `fromEntries` never writes its argument; listing
 * it only makes the rule more conservative, which can cause a miss and never a finding.
 */
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "fromEntries"]);

/** Every identifier the file binds, by name and wherever it is bound, and every name in a write target. */
interface FileNames {
	bindings: Map<string, Node[]>;
	written: Set<string>;
}

/** Collect the bindings and the syntactically written names of `file` in one walk. */
function namesOf(file: SourceFile): FileNames {
	const bindings = new Map<string, Node[]>();
	const written = new Set<string>();

	/** Mark the base name of `target` (`a` in `(a.b[c]!) as T`), or every name inside a destructuring pattern. */
	function write(target: Node): void {
		let base = target;
		while (
			isParenthesizedExpression(base) ||
			isAsExpression(base) ||
			isSatisfiesExpression(base) ||
			isNonNullExpression(base) ||
			isPropertyAccessExpression(base) ||
			isElementAccessExpression(base)
		) {
			base = base.expression;
		}
		if (isIdentifier(base)) written.add(base.text);
		else base.forEachChild(write);
	}

	/** Record `node`'s binding and writes, then recurse; named apart from the matcher walk's `visit` for LCOV. */
	function scan(node: Node): void {
		const bound = BINDS.some((binds) => binds(node)) ? (node as Node & { name?: Node }).name : undefined;
		if (bound !== undefined && isIdentifier(bound)) {
			const existing = bindings.get(bound.text);
			if (existing) existing.push(node);
			else bindings.set(bound.text, [node]);
		}
		if (isBinaryExpression(node)) {
			const operator = node.operatorToken.kind;
			if (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment) write(node.left);
		} else if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
			if (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken) {
				write(node.operand);
			}
		} else if (isDeleteExpression(node)) {
			write(node.expression);
		} else if (
			isCallExpression(node) &&
			isPropertyAccessExpression(node.expression) &&
			isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "Object" &&
			OBJECT_WRITERS.has(node.expression.name.text)
		) {
			for (const target of node.arguments.slice(0, 1)) write(target);
		}
		node.forEachChild(scan);
	}
	scan(file);
	return { bindings, written };
}

/** Report every bare regex literal reachable through literals in the arguments of a `toMatchObject` call. */
export function findVacuousMatchers(file: SourceFile, name: string): string[] {
	const problems: string[] = [];
	let names: FileNames | undefined;
	/**
	 * Declarations already walked for the current matcher call, by stored mode (index 1 = stored). A revisit
	 * reaches the same regex locations again, so skipping it loses no finding, breaks cycles
	 * (`const loop = { m: loop }`), and keeps shared initializers (`const a2 = [a1, a1]`) linear.
	 */
	const walked = [new Set<Node>(), new Set<Node>()];

	function at(node: Node): string {
		const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
		return `${line + 1}:${character + 1}`;
	}

	/**
	 * The initializer of the single plain `const` binding `use` names, when its scope contains `use`, nothing
	 * in the file writes into it, and `use` is outside any `with` body (whose object could supply the name).
	 */
	function constInitializer(use: Identifier): { declaration: Node; initializer: Expression } | undefined {
		names ??= namesOf(file);
		if (names.written.has(use.text)) return undefined;
		for (let node: Node = use; !isSourceFile(node); node = node.parent) {
			if (isWithStatement(node)) return undefined;
		}
		const [declaration, ...others] = names.bindings.get(use.text) ?? [];
		if (declaration === undefined || others.length > 0 || !isVariableDeclaration(declaration)) return undefined;
		const list = declaration.parent;
		const statement = list.parent;
		const scope = statement.parent;
		if (
			declaration.initializer === undefined ||
			!isVariableDeclarationList(list) ||
			(list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using)) !== NodeFlags.Const ||
			!isVariableStatement(statement) ||
			!(isSourceFile(scope) || isBlock(scope)) ||
			use.pos < scope.pos ||
			use.end > scope.end
		) {
			return undefined;
		}
		return { declaration, initializer: declaration.initializer };
	}

	/**
	 * Walk `node`; `stored` is false for an object spread operand, whose own regex contributes no keys.
	 * `via` is the outermost name followed from the matcher argument, reported with the regex.
	 */
	function expected(node: Expression, stored = true, via?: Identifier): void {
		if (isRegularExpressionLiteral(node)) {
			if (!stored) return;
			const route = via ? ` via \`${via.text}\` at ${at(via)}` : "";
			problems.push(`${name}:${at(node)}: bare ${node.text} in ${MATCHER}${route} ${FIX}`);
		} else if (isIdentifier(node)) {
			const resolved = constInitializer(node);
			const seen = walked[Number(stored)] as Set<Node>;
			if (resolved === undefined || seen.has(resolved.declaration)) return;
			seen.add(resolved.declaration);
			expected(resolved.initializer, stored, via ?? node);
		} else if (
			isParenthesizedExpression(node) ||
			isAsExpression(node) ||
			isSatisfiesExpression(node) ||
			isSpreadElement(node)
		) {
			expected(node.expression, stored, via);
		} else if (isConditionalExpression(node)) {
			expected(node.whenTrue, stored, via);
			expected(node.whenFalse, stored, via);
		} else if (isArrayLiteralExpression(node)) {
			for (const element of node.elements) expected(element, true, via);
		} else if (isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				if (isPropertyAssignment(property)) expected(property.initializer, true, via);
				// The grammar only allows an identifier as a shorthand property name.
				else if (isShorthandPropertyAssignment(property)) expected(property.name as Identifier, true, via);
				else if (isSpreadAssignment(property)) expected(property.expression, false, via);
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
			for (const seen of walked) seen.clear();
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
