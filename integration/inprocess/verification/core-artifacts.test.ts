import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	diffInstalled,
	readAuthenticatedTarball,
	selectReleaseDigest,
	unpackTarball,
	verifyInstalledPackage,
} from "./core-artifacts.ts";
import { pinnedCoreTarball } from "./core-pins.ts";

type Entry = { name: string; body?: string; type?: string; prefix?: string; size?: string };

function header(entry: Entry): Buffer {
	const block = Buffer.alloc(512);
	block.write(entry.name, 0, "utf8");
	block.write(entry.size ?? `${(entry.body ?? "").length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
	if (entry.type !== undefined) block.write(entry.type, 156, "latin1");
	if (entry.prefix) block.write(entry.prefix, 345, "utf8");
	return block;
}

/** Build a gzipped tar the way `npm pack` lays it out, plus the odd entries the parser must refuse. */
function tarball(entries: Entry[], trailer = true): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(header(entry));
		const body = Buffer.from(entry.body ?? "");
		parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	if (trailer) parts.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(parts));
}

const roots: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "core-artifacts-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(root: string, files: Record<string, string>): string {
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), body);
	}
	return root;
}

const sampleEntries: Entry[] = [
	{ name: "package/", type: "5", size: "" },
	{ name: "package/package.json", body: '{"version":"1.3.0"}', type: "0" },
	{ name: "agent-session.js", prefix: "package/dist/core", body: "new" },
	{ name: "package/dist/index.js", body: "barrel" },
];
const sampleFiles = {
	"package.json": '{"version":"1.3.0"}',
	"dist/core/agent-session.js": "new",
	"dist/index.js": "barrel",
};

describe("unpackTarball", () => {
	it("maps regular files, strips `package/`, joins ustar prefixes and skips directories", () => {
		const files = unpackTarball(tarball(sampleEntries));
		expect([...files.keys()].sort()).toEqual(["dist/core/agent-session.js", "dist/index.js", "package.json"]);
		expect(files.get("dist/core/agent-session.js")?.toString()).toBe("new");
	});

	it("reads a name that fills the whole 100 byte field and a tar with no end marker", () => {
		const long = `package/${"a".repeat(92)}`;
		expect(long).toHaveLength(100);
		expect([...unpackTarball(tarball([{ name: long, body: "x" }], false)).keys()]).toEqual(["a".repeat(92)]);
	});

	it.each([
		["a symlink", [{ name: "package/link", type: "2" }], /Unsupported tar entry type '2'/],
		["a pax header", [{ name: "pax", type: "x", body: "" }], /Unsupported tar entry type 'x'/],
		["a truncated body", [{ name: "package/a", size: "00000077777\0" }], /Truncated tar entry/],
		["a non-numeric size", [{ name: "package/a", size: "zzzz\0" }], /Invalid tar size/],
		["a negative size", [{ name: "package/a", size: "-0000001\0" }], /Invalid tar size/],
		[
			"a duplicate path",
			[
				{ name: "package/a", body: "x" },
				{ name: "package/a", body: "y" },
			],
			/Duplicate tar entry/,
		],
		["an empty path", [{ name: "package/", body: "x" }], /Unsafe tar path/],
		["a traversal path", [{ name: "package/../evil", body: "x" }], /Unsafe tar path/],
		["a path outside `package/`", [{ name: "other/a", body: "x" }], /Unsafe tar path/],
	] as [string, Entry[], RegExp][])("fails closed on %s", (_label, entries, message) => {
		expect(() => unpackTarball(tarball(entries))).toThrow(message);
	});
});

describe("readAuthenticatedTarball", () => {
	function cache(bytes: Buffer, key: Buffer = bytes): { dir: string; integrity: string; sha256: string } {
		const dir = temp();
		const integrity = `sha512-${createHash("sha512").update(key).digest("base64")}`;
		const hex = createHash("sha512").update(key).digest("hex");
		install(dir, { [`_cacache/content-v2/sha512/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`]: "" });
		writeFileSync(join(dir, "_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), bytes);
		return { dir, integrity, sha256: createHash("sha256").update(bytes).digest("hex") };
	}

	it("returns bytes matching both digests, skipping caches that lack them", () => {
		const bytes = tarball(sampleEntries);
		const { dir, integrity, sha256 } = cache(bytes);
		expect(readAuthenticatedTarball(integrity, sha256, [temp(), dir])).toEqual(bytes);
	});

	it("fails when no cache holds the artifact", () => {
		expect(() => readAuthenticatedTarball("sha512-AAAA", "0", [temp()])).toThrow(/not in the npm cache/);
	});

	it("fails when cached bytes do not hash to the key", () => {
		const { dir, integrity, sha256 } = cache(Buffer.from("swapped"), Buffer.from("expected"));
		expect(() => readAuthenticatedTarball(integrity, sha256, [dir])).toThrow(/fails its sha512 integrity/);
	});

	it("fails when the release record digest disagrees", () => {
		const { dir, integrity } = cache(Buffer.from("bytes"));
		expect(() => readAuthenticatedTarball(integrity, "0".repeat(64), [dir])).toThrow(/fails the release record sha256/);
	});
});

describe("verifyInstalledPackage", () => {
	const shipped = tarball(sampleEntries);

	it("accepts a byte-identical install, ignores nested dependencies and reports a stable receipt", () => {
		const root = install(temp(), { ...sampleFiles, "node_modules/dep/index.js": "other package" });
		const receipt = verifyInstalledPackage(root, shipped);
		expect(receipt.files).toBe(3);
		expect(receipt.treeSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyInstalledPackage(install(temp(), sampleFiles), shipped)).toEqual(receipt);
	});

	it.each([
		["a nested core package", "node_modules/@earendil-works/pi-agent-core/dist/index.js"],
		["an empty nested scope", "node_modules/@earendil-works/.keep"],
	])("rejects %s under a verified package, which Node resolves first", (_label, path) => {
		const root = install(temp(), { ...sampleFiles, [path]: "stale" });
		expect(() => verifyInstalledPackage(root, shipped)).toThrow(/nested core copy.*node_modules\/@earendil-works/);
	});

	it("rejects a dangling symlink at the nested core scope", () => {
		const root = install(temp(), sampleFiles);
		mkdirSync(join(root, "node_modules"));
		symlinkSync(join(root, "gone"), join(root, "node_modules/@earendil-works"));
		expect(() => verifyInstalledPackage(root, shipped)).toThrow(/nested core copy/);
	});

	it("rejects a same-version install whose nested module is stale while barrels are unchanged", () => {
		const root = install(temp(), { ...sampleFiles, "dist/core/agent-session.js": "old" });
		expect(() => verifyInstalledPackage(root, shipped)).toThrow(/"modified":\["dist\/core\/agent-session.js"\]/);
	});

	it("rejects missing, unshipped and non-regular files", () => {
		const root = install(temp(), { "package.json": sampleFiles["package.json"], "dist/index.js": "barrel" });
		symlinkSync("/etc/hosts", join(root, "dist/core-link"));
		mkdirSync(join(root, "dist/core"), { recursive: true });
		symlinkSync("/etc/hosts", join(root, "dist/core/agent-session.js"));
		const diff = diffInstalled(root, unpackTarball(shipped));
		expect(diff).toEqual({
			missing: [],
			modified: ["dist/core/agent-session.js"],
			extra: ["dist/core-link"],
		});
		const bare = install(temp(), { "package.json": sampleFiles["package.json"] });
		expect(diffInstalled(bare, unpackTarball(shipped)).missing).toEqual([
			"dist/core/agent-session.js",
			"dist/index.js",
		]);
	});
});

describe("selectReleaseDigest", () => {
	const url = "https://registry.example/@earendil-works/pi-tui/-/pi-tui-1.3.0.tgz";
	const lock = (entry: object | undefined) => ({ packages: { "node_modules/@earendil-works/pi-tui": entry } });
	const pinned = { resolved: url, integrity: "sha512-abc" };
	const release = (...artifacts: { url: string; sha256: string }[]) => ({ artifacts });

	it("returns the pin and the digest of the exact URL match", () => {
		const other = { url: url.replace("1.3.0", "1.2.0"), sha256: "b" };
		expect(selectReleaseDigest(lock(pinned), [release(other), release({ url, sha256: "a" })], "pi-tui")).toEqual({
			...pinned,
			sha256: "a",
		});
	});

	it("accepts the same digest listed by several releases", () => {
		const same = release({ url, sha256: "a" });
		expect(selectReleaseDigest(lock(pinned), [same, same], "pi-tui").sha256).toBe("a");
	});

	it.each([
		["no lock entry", undefined],
		["no resolved", { integrity: "sha512-abc" }],
		["no integrity", { resolved: url }],
	])("rejects %s", (_label, entry) => {
		expect(() => selectReleaseDigest(lock(entry), [release({ url, sha256: "a" })], "pi-tui")).toThrow(
			/pins no resolved\/integrity/,
		);
	});

	it.each([
		["no release lists the URL", [release({ url: `${url}.other`, sha256: "a" })]],
		["a basename-only match", [release({ url: "pi-tui-1.3.0.tgz", sha256: "a" })]],
		["records without artifacts", [{}]],
		["conflicting digests", [release({ url, sha256: "a" }), release({ url, sha256: "b" })]],
	])("rejects %s", (_label, releases) => {
		expect(() => selectReleaseDigest(lock(pinned), releases, "pi-tui")).toThrow(/No unambiguous release digest/);
	});
});

describe("pinned core release", () => {
	it("rejects a one-byte nested change to the real pinned agent-core package", () => {
		const { tarball: real } = pinnedCoreTarball("pi-agent-core");
		const root = temp();
		for (const [path, bytes] of unpackTarball(real)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), bytes);
		}
		expect(verifyInstalledPackage(root, real).files).toBeGreaterThan(10);
		const nested = "dist/agent-loop.js";
		writeFileSync(join(root, nested), `${readFileSync(join(root, nested), "utf8")}\n`);
		expect(() => verifyInstalledPackage(root, real)).toThrow(new RegExp(nested.replace(".", "\\.")));
	});
});
