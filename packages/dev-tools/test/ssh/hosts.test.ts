import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const homeProbe = vi.hoisted(() => ({ home: "" }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const rejectRealHomeProbe = (path: unknown): void => {
		const home = homeProbe.home;
		if (home && typeof path === "string" && (path === home || path.startsWith(`${home}/`)))
			throw new Error(`probed real home: ${path}`);
	};
	return {
		...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) => {
			rejectRealHomeProbe(path);
			return fs.existsSync(path);
		},
		globSync: (...args: Parameters<typeof fs.globSync>) => {
			rejectRealHomeProbe(args[0]);
			return fs.globSync(...args);
		},
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			rejectRealHomeProbe(args[0]);
			return fs.readFileSync(...args);
		},
	};
});

import { readKnownHosts, sshConfigPath, validateHost } from "../../src/ssh/hosts.ts";

const CONFIG = join(import.meta.dirname, "..", "fixtures", "ssh", "config");

describe("readKnownHosts", () => {
	it("collects concrete aliases, follows includes, skips wildcards and negations", () => {
		const hosts = readKnownHosts(CONFIG);
		expect([...hosts].sort()).toEqual([
			"colima",
			"colima-work",
			"deep-host",
			"eqform",
			"github.com",
			"ha",
			"home",
			"homeassistant",
			"nas",
			"nested-host",
			"pi",
			"quoted",
			"trailing",
		]);
	});
	it("resolves relative includes against the config directory, like OpenSSH, not the including file", () => {
		const hosts = readKnownHosts(CONFIG);
		expect(hosts.has("nested-host")).toBe(true);
		expect(hosts.has("wrong-relative-host")).toBe(false);
	});
	it("ignores trailing comments, handles Host=, quotes and CRLF", () => {
		const hosts = readKnownHosts(CONFIG);
		expect(hosts.has("comment")).toBe(false);
		expect(hosts.has("a")).toBe(false);
		for (const h of ["trailing", "eqform", "quoted"]) expect(hosts.has(h), h).toBe(true);
	});
	it("is empty for a missing file", () => {
		expect(readKnownHosts("/nonexistent/config").size).toBe(0);
	});

	it("uses the injected home for recursive tilde Includes without probing the real home", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-dev-tools-home-"));
		const config = join(home, ".ssh", "config");
		const first = join(home, ".ssh", "first.conf");
		const second = join(home, ".ssh", "second.conf");
		homeProbe.home = homedir();
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(config, "Include ~/.ssh/first.conf\n");
		writeFileSync(first, "Include ~/.ssh/second.conf\n");
		writeFileSync(second, "Host isolated\n");
		try {
			expect(sshConfigPath(home)).toBe(config);
			expect([...readKnownHosts(config, undefined, undefined, undefined, home)]).toEqual(["isolated"]);
		} finally {
			homeProbe.home = "";
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("validateHost", () => {
	const known = readKnownHosts(CONFIG);
	it("accepts known aliases", () => {
		expect(validateHost("home", known)).toBeUndefined();
		expect(validateHost("github.com", known)).toBeUndefined();
	});
	it.each(["-oProxyCommand=id", "root@home", "home nas", "", "home;id", "100.1.2.3", "evil", "HOME"])(
		"rejects %j",
		(host) => {
			expect(validateHost(host, known)).toBeDefined();
		},
	);
	it("lists the known hosts in the rejection", () => {
		expect(validateHost("evil", known)).toContain("known: colima, colima-work, deep-host");
	});
});
