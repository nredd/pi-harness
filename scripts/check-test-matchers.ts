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
 * A name (or shorthand property) is followed into its initializer only under ONE conservative rule (#1302,
 * #1315): the nearest binding in scope is a plain `const name = ...` statement directly in the file, a block
 * or a `switch` case block, and no other binding of the name inside that scope could be visible at the use.
 * A `let`, `const` or `using` statement there binds exactly that scope. Every other binding (`var`, parameter,
 * catch, `for` header, destructuring, function, class, import, enum, namespace member) counts as visible
 * throughout its nearest enclosing function or the file, a superset of its real scope, so a binding the
 * resolver does not model precisely can only cause a miss, never a finding. A reused name (`const expected`
 * in each test) resolves per scope; a namespace-block `const`, `let`, `var`, `using`, destructuring and free
 * globals are not followed. `arguments` is never followed: every ordinary function binds it implicitly. A
 * `const` fixes the binding, not its contents: a name that appears in a write target anywhere in the file
 * (assignment, `++`/`--`, `delete`, the first argument of `Object.assign`, `defineProperty`,
 * `defineProperties` or `fromEntries`, under any of its bindings) and a use anywhere inside a `with` statement
 * nested in the chosen scope are not followed either: in its body the object may shadow the name, and its
 * object expression is skipped too although it is evaluated before that (conservative, only a miss).
 * Syntactic, so the temporal dead zone is not modeled: a `const` used in a different `switch` clause than its
 * initializer may be uninitialized at runtime, and the guard still reports it. A write through an alias or a call is not tracked,
 * so a regex later overwritten that way can still be reported. A regex reached through a helper call, `new RegExp(...)` or another
 * module is not seen. Each initializer is walked at most once per matcher call and stored mode, so shared
 * initializers (`const a2 = [a1, a1]`) cost linear work and a revisit adds no finding.
 *
 * CLI: `node scripts/check-test-matchers.ts` checks every owned JS/TS test source and exits 1 on findings.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Expression, Identifier, Node, SourceFile, VariableDeclaration } from "typescript/unstable/ast";
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import {
	isArrayLiteralExpression,
	isArrowFunction,
	isAsExpression,
	isBinaryExpression,
	isBindingElement,
	isBlock,
	isCallExpression,
	isCaseBlock,
	isCaseClause,
	isClassDeclaration,
	isClassExpression,
	isConditionalExpression,
	isConstructorDeclaration,
	isDefaultClause,
	isDeleteExpression,
	isElementAccessExpression,
	isEnumDeclaration,
	isEnumMember,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isIdentifier,
	isImportClause,
	isImportEqualsDeclaration,
	isImportSpecifier,
	isMethodDeclaration,
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
	isSetAccessorDeclaration,
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
	isEnumMember,
	isModuleDeclaration,
];

/** Nodes that bound every `var`, parameter and function declaration inside them (sloppy block functions included). */
const FUNCTIONS = [
	isFunctionDeclaration,
	isFunctionExpression,
	isArrowFunction,
	isMethodDeclaration,
	isConstructorDeclaration,
	isGetAccessorDeclaration,
	isSetAccessorDeclaration,
];

/** A `let`, `const` or `using` statement binding with the exact scope it binds in. */
interface Lexical {
	declaration: VariableDeclaration;
	scope: Node;
	constant: boolean;
}

/** `binding` as a `let`, `const` or `using` statement in the file, a block or a case block, else undefined. */
function lexical(binding: Node): Lexical | undefined {
	if (!isVariableDeclaration(binding)) return undefined;
	const list = binding.parent;
	const statement = list.parent;
	const kind = list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using);
	if (!isVariableDeclarationList(list) || kind === 0 || !isVariableStatement(statement)) return undefined;
	const parent = statement.parent;
	const scope = isCaseClause(parent) || isDefaultClause(parent) ? parent.parent : parent;
	if (!isSourceFile(scope) && !isBlock(scope) && !isCaseBlock(scope)) return undefined;
	return { declaration: binding, scope, constant: kind === NodeFlags.Const };
}

/**
 * A node containing every place a binding other than a lexical statement may be visible: its nearest enclosing
 * function (starting above the binding, so a function's own name counts outside it) or the file.
 */
function visibleRegion(binding: Node): Node {
	let node = binding.parent;
	while (!isSourceFile(node) && !FUNCTIONS.some((bounds) => bounds(node))) node = node.parent;
	return node;
}

/** Whether `outer` spans `inner`. */
function spans(outer: Node, inner: Node): boolean {
	return inner.pos >= outer.pos && inner.end <= outer.end;
}

/**
 * `Object` methods whose first argument counts as written. `fromEntries` never writes its argument; listing
 * it only makes the rule more conservative, which can cause a miss and never a finding.
 */
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "fromEntries"]);

/** A binding the resolver does not model exactly, with the region it may be visible in. */
interface Loose {
	binding: Node;
	region: Node;
}

/**
 * Every binding the file holds, classified once: `let`/`const`/`using` statements by exact scope and name,
 * the rest by name with their over-approximated regions, and every name in a write target.
 */
interface FileNames {
	scoped: Map<Node, Map<string, Lexical[]>>;
	loose: Map<string, Loose[]>;
	written: Set<string>;
}

/** Append `value` to the list under `key` in `map`. */
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

/** Collect the bindings and the syntactically written names of `file` in one walk. */
function namesOf(file: SourceFile): FileNames {
	const scoped = new Map<Node, Map<string, Lexical[]>>();
	const loose = new Map<string, Loose[]>();
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
			const exact = lexical(node);
			if (exact === undefined) append(loose, bound.text, { binding: node, region: visibleRegion(node) });
			else {
				const byName = scoped.get(exact.scope) ?? new Map<string, Lexical[]>();
				scoped.set(exact.scope, byName);
				append(byName, bound.text, exact);
			}
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
	return { scoped, loose, written };
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
	 * The initializer `use` resolves to. Walking out from `use`, the first scope holding a `let`, `const` or
	 * `using` statement binding of the name decides: it is followed only when it is a `const` with an
	 * initializer and no other binding of the name that may be visible at `use` lies inside that scope. The real
	 * binding of `use` lies inside its own scope and may be visible there, so a nearer binding the walk does not
	 * model is caught by that check. A `with` statement passed on the way (whose object could supply the name)
	 * and a name anything in the file writes into are never followed, nor is `arguments` (implicitly bound by
	 * every ordinary function). A lexical binding is visible at `use` exactly when its scope is an ancestor, so
	 * the only other lexical bindings that matter are duplicates in the chosen scope: per use, the work is the
	 * walk to the root plus the name's loose bindings, never every same-named `const` in the file.
	 */
	function constInitializer(use: Identifier): { declaration: Node; initializer: Expression } | undefined {
		names ??= namesOf(file);
		if (use.text === "arguments" || names.written.has(use.text)) return undefined;
		const loose = (names.loose.get(use.text) ?? []).filter(({ region }) => spans(region, use));
		for (let node: Node = use; ; node = node.parent) {
			if (isWithStatement(node)) return undefined;
			const here = names.scoped.get(node)?.get(use.text);
			if (here !== undefined) {
				const { declaration, constant } = here[0] as Lexical;
				const shadowed = here.length > 1 || loose.some(({ binding }) => spans(node, binding));
				if (!constant || declaration.initializer === undefined || shadowed) return undefined;
				return { declaration, initializer: declaration.initializer };
			}
			if (isSourceFile(node)) return undefined;
		}
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
