/** Resolve the lockfile's pinned core artifacts to authenticated tarballs, offline. */
import { readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CoreLock,
	type CoreRelease,
	npmCacheDirs,
	readAuthenticatedTarball,
	selectReleaseDigest,
} from "./core-artifacts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
	return {
		tarball: readAuthenticatedTarball(integrity, sha256, npmCacheDirs(process.env, userInfo().homedir)),
		resolved,
		integrity,
	};
}
