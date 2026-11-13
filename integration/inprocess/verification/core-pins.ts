/** Resolve the lockfile's pinned core artifacts to authenticated tarballs, offline. */
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedTarball } from "./core-artifacts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

type Lock = { packages: Record<string, { resolved?: string; integrity?: string }> };
type Release = { artifacts?: { url: string; sha256: string }[] };

/** npm cache roots to search: explicit override, npm's own variables, then the account's default. */
export function npmCacheDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	return [
		env.PI_CORE_TARBALL_CACHE,
		env.npm_config_cache,
		env.NPM_CONFIG_CACHE,
		join(userInfo().homedir, ".npm"),
	].filter((dir): dir is string => Boolean(dir));
}

/**
 * Authenticated tarball for `@earendil-works/<name>` as pinned by the root lockfile and a `releases/` record.
 *
 * Raises:
 *   Error: no release record lists the pinned URL, or the cached bytes fail either digest.
 */
export function pinnedCoreTarball(name: string): { tarball: Buffer; resolved: string; integrity: string } {
	const lock: Lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
	const { resolved, integrity } = lock.packages[`node_modules/@earendil-works/${name}`] ?? {};
	if (!resolved || !integrity) throw new Error(`Lockfile pins no resolved/integrity for ${name}`);
	const digests = readdirSync(join(ROOT, "releases"))
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => (JSON.parse(readFileSync(join(ROOT, "releases", file), "utf8")) as Release).artifacts ?? [])
		.filter((artifact) => artifact.url === resolved)
		.map((artifact) => artifact.sha256);
	const [sha256] = digests;
	if (!sha256 || new Set(digests).size !== 1) throw new Error(`No unambiguous release digest for ${resolved}`);
	return { tarball: readAuthenticatedTarball(integrity, sha256, npmCacheDirs()), resolved, integrity };
}
