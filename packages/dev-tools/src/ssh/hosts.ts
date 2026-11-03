/**
 * Known hosts come from `~/.ssh/config` (`Host` aliases, `Include` followed, wildcards and
 * negations skipped). A host the model names must be one of them and must look like a host, so
 * it can never turn into an ssh option.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HOST_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** OpenSSH's own limit. */
const MAX_INCLUDE_DEPTH = 16;

export function sshConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".ssh", "config");
}

/** OpenSSH resolves a relative user-config `Include` against `~/.ssh`, not the including file. */
function expandIncludes(pattern: string, sshDir: string, homeDir: string): string[] {
	const expanded = pattern.startsWith("~/") ? join(homeDir, pattern.slice(2)) : pattern;
	const absolute = isAbsolute(expanded) ? expanded : resolve(sshDir, expanded);
	try {
		return globSync(absolute).sort();
	} catch {
		return existsSync(absolute) ? [absolute] : [];
	}
}

/** Roots for known-host discovery; omitted values keep the native home. */
export interface KnownHostsOptions {
	/** Home for the default config path and `Include ~/...` expansion. */
	homeDir?: string;
}

/**
 * Every concrete `Host` alias declared by `path` and the files it includes. Relative includes
 * resolve against the directory of the top-level config (`~/.ssh` in real life).
 */
export function readKnownHosts(path?: string, { homeDir = homedir() }: KnownHostsOptions = {}): Set<string> {
	const config = path ?? sshConfigPath(homeDir);
	return collectHosts(config, dirname(config), 0, new Set<string>(), homeDir);
}

function collectHosts(path: string, sshDir: string, depth: number, seen: Set<string>, homeDir: string): Set<string> {
	const hosts = new Set<string>();
	if (depth > MAX_INCLUDE_DEPTH || seen.has(path) || !existsSync(path)) return hosts;
	seen.add(path);
	for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = raw.replace(/\s#.*$/, "").trim();
		if (!line || line.startsWith("#")) continue;
		// `Host a b`, `Host=a`, `Host "a"` are all valid spellings.
		const [keyword, ...rest] = line
			.replace(/^(\w+)\s*=\s*/, "$1 ")
			.replace(/"/g, "")
			.split(/\s+/);
		const key = keyword?.toLowerCase();
		if (key === "host") {
			for (const alias of rest) {
				if (HOST_SHAPE.test(alias) && !alias.includes("*") && !alias.includes("?")) hosts.add(alias);
			}
		} else if (key === "include") {
			for (const pattern of rest) {
				for (const file of expandIncludes(pattern, sshDir, homeDir)) {
					for (const h of collectHosts(file, sshDir, depth + 1, seen, homeDir)) hosts.add(h);
				}
			}
		}
	}
	return hosts;
}

/** Why `host` is unusable, or undefined when it is a known, well-formed alias. */
export function validateHost(host: string, known: ReadonlySet<string>): string | undefined {
	if (!HOST_SHAPE.test(host)) return `host '${host}' is not a plain host alias`;
	if (!known.has(host)) {
		const list = [...known].sort().join(", ") || "(none)";
		return `host '${host}' is not a Host entry in ~/.ssh/config; known: ${list}`;
	}
	return undefined;
}
