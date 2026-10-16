// Shared helpers for the static resource tests. Not a test file (no `.test.ts` suffix).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Frontmatter or loosely typed JSON object; callers narrow the fields they read. */
export type Json = Record<string, unknown>;

export interface ExternalSkill {
	name: string;
	requiredBy: string[];
	source: string;
	path: string;
	revision: string;
	license: string;
}

export interface ExternalExtension {
	name: string;
	requiredBy: string[];
	package: string;
	selectorForm: string;
}

/** The fields of the preset's `package.json` the tests read. */
export interface Manifest {
	name: string;
	version: string;
	license: string;
	private?: boolean;
	publishConfig?: unknown;
	repository: { type: string; url: string; directory: string };
	keywords: string[];
	scripts: Record<string, string>;
	files: string[];
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	dependencies?: Record<string, string>;
	bundledDependencies?: unknown;
	bundleDependencies?: unknown;
	pi: {
		extensions: string[];
		skills: string[];
		themes: string[];
		subagents: { agents: string[] };
		prompts?: unknown;
	};
	piPreset: { externalResources: { skills: ExternalSkill[]; extensions: ExternalExtension[] } };
}

export const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const readText = (rel: string): string => readFileSync(join(pkgRoot, rel), "utf8");
export const readJson = <T = Json>(rel: string): T => JSON.parse(readText(rel)) as T;
export const manifest = (): Manifest => readJson<Manifest>("package.json");

/** Every file below `rel` (package-relative, sorted, `/`-separated). */
export function walk(rel: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(pkgRoot, rel), { withFileTypes: true })) {
		const child = `${rel}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(child));
		else out.push(child);
	}
	return out.sort();
}

/** Frontmatter and body of a package-relative Markdown file, via Pi's own reader. */
export function frontmatterOf(rel: string): { frontmatter: Json; body: string } {
	return parseFrontmatter<Json>(readText(rel));
}

/** Files `npm pack` would publish (package-relative, sorted). Offline, no scripts, no tarball. */
export function packedFiles(): string[] {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: pkgRoot,
		encoding: "utf8",
		env: { ...process.env, npm_config_loglevel: "silent" },
	});
	const [report] = JSON.parse(out) as [{ files: { path: string }[] }];
	return report.files.map((f) => f.path).sort();
}
