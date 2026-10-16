/**
 * Module specifier extraction for the package-contract gate, built on the installed TypeScript
 * parser (`typescript/unstable/sync`, the native `tsgo` server). Every specifier must be a literal
 * the gate can classify; computed specifiers are reported as diagnostics instead of being skipped.
 *
 * Covered: static imports and re-exports (`import`, `export ... from`, `import type`), `import x =
 * require()`, `import("x")` types, dynamic `import()` and `require()` calls. Not covered: this is a
 * syntactic audit, so it cannot prove anything about `eval`, `new Function`, `createRequire()` results,
 * `import.meta.resolve`, or JSDoc `@import` tags.
 *
 * CLI: `node import_audit.ts ROOT FILE...` parses each ROOT-relative FILE in one batch and prints
 * `{"files": {FILE: {"specifiers": [...], "diagnostics": [...]}}}` as JSON.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNoSubstitutionTemplateLiteral,
	isParenthesizedExpression,
	isStringLiteral,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

export interface FileImports {
	/** Every literal module specifier, in source order. */
	specifiers: string[];
	/** Human-readable `file:line:col: message` problems: syntax errors and non-literal specifiers. */
	diagnostics: string[];
}

export interface AuditResult {
	files: Record<string, FileImports>;
}

const TSCONFIG_NAME = "tsconfig.json";
const SNIPPET_LIMIT = 80;

/** Parse-only project: no lib, no type roots, and no module resolution, so nothing is followed. */
const PARSE_ONLY_CONFIG = {
	compilerOptions: {
		allowJs: true,
		noLib: true,
		noResolve: true,
		types: [],
		target: "esnext",
		module: "esnext",
	},
};

/** Resolve a specifier expression to its string value, or `undefined` when it is not a plain literal. */
function literalValue(node: Node): string | undefined {
	if (isParenthesizedExpression(node)) {
		return literalValue(node.expression);
	}
	if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
		return node.text;
	}
	return undefined;
}

function snippet(node: Node, file: SourceFile): string {
	const text = node.getText(file).replace(/\s+/g, " ");
	return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}...` : text;
}

function locate(file: SourceFile, name: string, position: number): string {
	const { line, character } = file.getLineAndCharacterOfPosition(position);
	return `${name}:${line + 1}:${character + 1}`;
}

/** Collect the specifiers and diagnostics of one parsed file. */
export function collectImports(file: SourceFile, name: string): FileImports {
	const found: FileImports = { specifiers: [], diagnostics: [] };

	function record(spec: Node | undefined, form: string, at: Node): void {
		const value = spec === undefined ? undefined : literalValue(spec);
		if (value !== undefined) {
			found.specifiers.push(value);
			return;
		}
		const shown = spec === undefined ? "<missing>" : snippet(spec, file);
		found.diagnostics.push(
			`${locate(file, name, at.getStart(file))}: ${form} specifier is not a string literal: \`${shown}\``,
		);
	}

	function visit(node: Node): void {
		if (isImportDeclaration(node)) {
			record(node.moduleSpecifier, "import declaration", node);
		} else if (isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
			record(node.moduleSpecifier, "export-from", node);
		} else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
			record(node.moduleReference.expression, "`import = require()`", node);
		} else if (isImportTypeNode(node)) {
			record(isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument, "`import()` type", node);
		} else if (isCallExpression(node)) {
			if (node.expression.kind === SyntaxKind.ImportKeyword) {
				record(node.arguments[0], "dynamic `import()`", node);
			} else if (isIdentifier(node.expression) && node.expression.text === "require") {
				record(node.arguments[0], "`require()`", node);
			}
		}
		node.forEachChild(visit);
	}

	visit(file);
	return found;
}

/**
 * Parse `files` (relative to `root`) in a single `tsgo` session.
 *
 * Syntax errors are reported as diagnostics, because imports in a file that did not parse cannot be
 * trusted to be complete.
 */
export function auditFiles(root: string, files: readonly string[]): AuditResult {
	const configPath = join(root, TSCONFIG_NAME);
	writeFileSync(configPath, JSON.stringify({ ...PARSE_ONLY_CONFIG, files }));
	const api = new API({ cwd: root });
	try {
		const project = api.updateSnapshot({ openProject: configPath }).getProject(configPath);
		if (project === undefined) {
			throw new Error(`tsgo did not open the project '${configPath}'`);
		}
		const result: AuditResult = { files: {} };
		for (const name of files) {
			const absolute = join(root, name);
			const file = project.program.getSourceFile(absolute);
			if (file === undefined) {
				throw new Error(`tsgo did not load '${name}'`);
			}
			const found = collectImports(file, name);
			for (const issue of project.program.getSyntacticDiagnostics(absolute)) {
				const at = issue.fileName === undefined ? name : locate(file, name, issue.pos);
				found.diagnostics.push(`${at}: syntax error: ${issue.text}`);
			}
			result.files[name] = found;
		}
		return result;
	} finally {
		api.close();
	}
}

if (import.meta.main) {
	const [root, ...files] = process.argv.slice(2);
	if (root === undefined || files.length === 0) {
		process.stderr.write("usage: node import_audit.ts ROOT FILE...\n");
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(auditFiles(root, files))}\n`);
}
