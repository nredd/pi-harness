import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

	it("uses the injected home for a tilde Include without probing the real home", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-dev-tools-home-"));
		const config = join(home, ".ssh", "config");
		const included = join(home, ".ssh", "included.conf");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		writeFileSync(
			config,
			`Include ~/.ssh/included.conf
`,
		);
		writeFileSync(
			included,
			`Host isolated
`,
		);
		try {
			expect(sshConfigPath(home)).toBe(config);
			expect([...readKnownHosts(config, undefined, undefined, undefined, home)]).toEqual(["isolated"]);
		} finally {
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
