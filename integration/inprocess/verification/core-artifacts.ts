/** Offline proof that an installed core package is byte-identical to its authenticated release tarball. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK = 512;
const NAME_END = 100;
const SIZE_START = 124;
const SIZE_END = 136;
const TYPE_OFFSET = 156;
const PREFIX_START = 345;
const PREFIX_END = 500;
const OCTAL = 8;
const TYPE_REGULAR = "0";
const TYPE_DIRECTORY = "5";
const TAR_ROOT = /^package\//;

/** Result of comparing an install to the files its tarball ships. */
export type ContentDiff = { missing: string[]; modified: string[]; extra: string[] };

/** Fixed public facts about one verified package; never a process path or runtime setting. */
export type ContentReceipt = { files: number; treeSha256: string };

function cString(block: Buffer, start: number, end: number): string {
	const slice = block.subarray(start, end);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

/**
 * Map the regular files of a gzipped npm tarball, with the leading `package/` removed.
 *
 * Raises:
 *   Error: a link, device, pax header, traversal path or truncated entry. Fails closed rather than skipping.
 */
export function unpackTarball(gz: Buffer): Map<string, Buffer> {
	const tar = gunzipSync(gz);
	const files = new Map<string, Buffer>();
	let offset = 0;
	while (offset + TAR_BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + TAR_BLOCK);
		if (header.every((byte) => byte === 0)) break;
		const type = String.fromCharCode(header[TYPE_OFFSET] || TYPE_REGULAR.charCodeAt(0));
		const prefix = cString(header, PREFIX_START, PREFIX_END);
		const name = (prefix ? `${prefix}/` : "") + cString(header, 0, NAME_END);
		const size = Number.parseInt(cString(header, SIZE_START, SIZE_END).trim() || "0", OCTAL);
		const body = offset + TAR_BLOCK;
		if (type !== TYPE_REGULAR && type !== TYPE_DIRECTORY)
			throw new Error(`Unsupported tar entry type '${type}' for '${name}'`);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for '${name}'`);
		if (body + size > tar.length) throw new Error(`Truncated tar entry '${name}'`);
		const path = name.replace(TAR_ROOT, "");
		if (type === TYPE_REGULAR) {
			if (path === name || path === "" || path.split("/").includes("..")) throw new Error(`Unsafe tar path '${name}'`);
			if (files.has(path)) throw new Error(`Duplicate tar entry '${name}'`);
			files.set(path, Buffer.from(tar.subarray(body, body + size)));
		}
		offset = body + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
	}
	return files;
}

/**
 * Read a tarball from an npm content-addressable cache and authenticate it.
 *
 * Parameters:
 *   integrity (string): lockfile `sha512-` SRI; also the cache key.
 *   sha256 (string): release record digest the bytes must also match.
 *   cacheDirs (string[]): candidate npm cache roots, first hit wins.
 *
 * Raises:
 *   Error: no cache holds the artifact, or the bytes fail either digest.
 */
export function readAuthenticatedTarball(integrity: string, sha256: string, cacheDirs: string[]): Buffer {
	const hex = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
	const relative = join("content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
	const found = cacheDirs.map((dir) => join(dir, "_cacache", relative)).find((path) => existsSync(path));
	if (!found) throw new Error(`Artifact ${integrity} is not in the npm cache; run npm ci before verification`);
	const bytes = readFileSync(found);
	if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
		throw new Error(`Cached artifact fails its sha512 integrity ${integrity}`);
	}
	if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
		throw new Error(`Cached artifact ${integrity} fails the release record sha256 ${sha256}`);
	}
	return bytes;
}

/** Lockfile shape the pin selection reads. */
export type CoreLock = { packages: Record<string, { resolved?: string; integrity?: string } | undefined> };

/** Release record shape the pin selection reads. */
export type CoreRelease = { artifacts?: { url: string; sha256: string }[] };

/**
 * Pair a lockfile pin with the release record digest for exactly the same URL.
 *
 * Raises:
 *   Error: the lock pins no `resolved`/`integrity`, or no release lists the exact URL, or listings disagree on the digest.
 */
export function selectReleaseDigest(
	lock: CoreLock,
	releases: CoreRelease[],
	name: string,
): { resolved: string; integrity: string; sha256: string } {
	const { resolved, integrity } = lock.packages[`node_modules/@earendil-works/${name}`] ?? {};
	if (!resolved || !integrity) throw new Error(`Lockfile pins no resolved/integrity for ${name}`);
	const digests = releases
		.flatMap((release) => release.artifacts ?? [])
		.filter((artifact) => artifact.url === resolved)
		.map((artifact) => artifact.sha256);
	const [sha256] = digests;
	if (!sha256 || new Set(digests).size !== 1) throw new Error(`No unambiguous release digest for ${resolved}`);
	return { resolved, integrity, sha256 };
}

function installedFiles(root: string, relative = ""): Map<string, string> {
	const found = new Map<string, string>();
	for (const entry of readdirSync(join(root, relative)).sort()) {
		const path = relative ? `${relative}/${entry}` : entry;
		// Nested dependency installs are other packages with their own lock entries.
		if (path === "node_modules") continue;
		if (lstatSync(join(root, path)).isDirectory()) {
			for (const [child, value] of installedFiles(root, path)) found.set(child, value);
		} else {
			found.set(path, join(root, path));
		}
	}
	return found;
}

/**
 * Compare every installed file to the tarball: absent, byte-different, non-regular and unshipped files all count.
 *
 * Returns:
 *   ContentDiff: sorted path lists; all empty means byte-identical.
 */
export function diffInstalled(root: string, shipped: Map<string, Buffer>): ContentDiff {
	const installed = installedFiles(root);
	const missing = [...shipped.keys()].filter((path) => !installed.has(path)).sort();
	const extra = [...installed.keys()].filter((path) => !shipped.has(path)).sort();
	const modified = [...shipped]
		.filter(([path, bytes]) => {
			const actual = installed.get(path);
			return actual !== undefined && (!lstatSync(actual).isFile() || !readFileSync(actual).equals(bytes));
		})
		.map(([path]) => path)
		.sort();
	return { missing, modified, extra };
}

/**
 * Prove an installed package equals its authenticated tarball.
 *
 * Raises:
 *   Error: any file differs, with the offending paths named, or a nested `node_modules/@earendil-works` exists.
 */
export function verifyInstalledPackage(root: string, tarball: Buffer): ContentReceipt {
	// Node resolves a package's own `node_modules` before the hoisted copy, so a nested core copy would shadow the verified one.
	const nestedCore = join(root, "node_modules", "@earendil-works");
	if (lstatSync(nestedCore, { throwIfNoEntry: false })) throw new Error(`Unverified nested core copy at ${nestedCore}`);
	const shipped = unpackTarball(tarball);
	const diff = diffInstalled(root, shipped);
	if (diff.missing.length + diff.modified.length + diff.extra.length > 0) {
		throw new Error(`Installed package differs from its release tarball: ${JSON.stringify(diff)}`);
	}
	const tree = createHash("sha256");
	for (const [path, bytes] of [...shipped].sort(([a], [b]) => (a < b ? -1 : 1))) {
		tree.update(`${path}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
	}
	return { files: shipped.size, treeSha256: tree.digest("hex") };
}
