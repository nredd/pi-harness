/** Resolve the lockfile's pinned core artifacts to authenticated tarballs, offline. */
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CoreLock, type CoreRelease, readAuthenticatedTarball, selectReleaseDigest } from "./core-artifacts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
 *   Error: pin selection fails (`selectReleaseDigest`), or the cached bytes fail either digest.
 */
export function pinnedCoreTarball(name: string): { tarball: Buffer; resolved: string; integrity: string } {
	const lock: CoreLock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
	const releases = readdirSync(join(ROOT, "releases"))
		.filter((file) => file.endsWith(".json"))
		.map((file) => JSON.parse(readFileSync(join(ROOT, "releases", file), "utf8")) as CoreRelease);
	const { resolved, integrity, sha256 } = selectReleaseDigest(lock, releases, name);
	return { tarball: readAuthenticatedTarball(integrity, sha256, npmCacheDirs()), resolved, integrity };
}
