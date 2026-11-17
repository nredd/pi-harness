// Persistent managed browser profiles (#674): disposable homes and fake browser children only.
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { shutdownComputerUseSession, testing } from "../src/bridge.ts";
import { loadComputerUseConfig } from "../src/config.ts";
import { browserSnapshot } from "../test/support/fake-browser.mjs";

const gate = vi.hoisted(() => ({
	statTarget: "",
	statCalls: 0,
	statFailureAt: 0,
	afterMkdir: undefined as ((directory: string) => void) | undefined,
	afterLstatSync: undefined as ((directory: string) => void) | undefined,
	afterStat: undefined as ((directory: string) => void) | undefined,
	foreignAncestor: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		stat: async (...args: Parameters<typeof actual.stat>) => {
			if (String(args[0]) === gate.statTarget && ++gate.statCalls === gate.statFailureAt) {
				throw Object.assign(new Error("synthetic metadata permission failure"), { code: "EACCES" });
			}
			const info = await actual.stat(...args);
			gate.afterStat?.(String(args[0]));
			return info;
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
			const result = actual.mkdirSync(...args);
			gate.afterMkdir?.(String(args[0]));
			return result;
		},
		lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
			const info = actual.lstatSync(...args) as import("node:fs").Stats;
			gate.afterLstatSync?.(String(args[0]));
			// Non-root runners cannot chown fixtures to another UID; only this metadata owner field is simulated.
			if (String(args[0]) === gate.foreignAncestor) return Object.assign(info, { uid: (process.getuid?.() ?? 0) + 1 });
			return info;
		},
	};
});

// Only disposable homes and fake browser processes are used for persistent-profile acceptance.
describe("persistent profile opt-in", () => {
	const executable = fileURLToPath(new URL("../test/fixtures/fake-browser.mjs", import.meta.url));
	// A canonical sticky system temp root, not an unchecked volume or caller-selected TMPDIR ancestor.
	const secureTemp = fs.realpathSync("/tmp");
	let root: string;
	let profile: string;
	let saved: Record<string, string | undefined>;
	let home: string;
	const keys = [
		"PI_CODING_AGENT_DIR",
		"PI_COMPUTER_USE_CHROME_EXECUTABLE",
		"PI_COMPUTER_USE_CDP_PORT",
		"FAKE_BROWSER_LOG",
		"FAKE_BROWSER_NO_CDP",
		"XDG_CONFIG_HOME",
		"CHROME_CONFIG_HOME",
	];

	/** Write the isolated user-global opt-in, then reload it. */
	function configure(value = profile) {
		const file = path.join(root, "agent/extensions/pi-computer-use.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ managed_browser_profile: value }));
		loadComputerUseConfig(root);
	}

	beforeEach(() => {
		gate.afterMkdir = undefined;
		gate.afterLstatSync = undefined;
		gate.afterStat = undefined;
		gate.foreignAncestor = "";
		saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		for (const key of keys) delete process.env[key];
		root = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-persistent-")));
		home = path.join(root, "home");
		fs.mkdirSync(home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		// Platform seam: POSIX validation runs on every host; the Windows refusal is its own explicit case.
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		profile = path.join(home, "dedicated-profile");
		fs.mkdirSync(profile, { mode: 0o700 });
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = executable;
		process.env.FAKE_BROWSER_LOG = path.join(root, "argv.json");
		configure();
	});

	afterEach(async () => {
		await shutdownComputerUseSession();
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		loadComputerUseConfig(path.join(root, "reset"));
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe("persistent managed profile", () => {
		test("reuses an explicit profile, reports executable provenance and preserves contents on shutdown", async () => {
			const sentinel = path.join(profile, "synthetic-session");
			fs.writeFileSync(sentinel, "disposable");
			for (let run = 0; run < 2; run++) {
				const result = await testing.performLaunchBrowser({});
				assert.equal(result.details.executable, executable);
				assert.match(result.content.at(-1).text, /Managed browser executable/);
				assert.equal(JSON.parse(fs.readFileSync(process.env.FAKE_BROWSER_LOG)).profile, profile);
				assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
				await shutdownComputerUseSession();
				assert.equal(fs.readFileSync(sentinel, "utf8"), "disposable");
				assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			}
		});

		test.each(["persistent-first", "temporary-first"])(
			"%s keeps each launch's ownership and cleanup independent",
			async (order) => {
				const marker = path.join(profile, "synthetic-session");
				fs.writeFileSync(marker, "preserve");
				const launch = async (persistent) => {
					configure(persistent ? profile : null);
					await testing.performLaunchBrowser({});
					const used = JSON.parse(fs.readFileSync(process.env.FAKE_BROWSER_LOG, "utf8")).profile;
					assert.equal(used === profile, persistent);
					await shutdownComputerUseSession();
					assert.equal(fs.existsSync(used), persistent);
					assert.equal(fs.readFileSync(marker, "utf8"), "preserve");
				};
				await launch(order === "persistent-first");
				await launch(order !== "persistent-first");
			},
		);

		test.each([
			["port", "symlink"],
			["shutdown", "symlink"],
			["lease", "symlink"],
			["port", "directory"],
			["shutdown", "directory"],
			["lease", "directory"],
		])("refuses profile replacement at %s allocation (%s) without writing through it", async (stage, kind) => {
			if (stage === "shutdown") {
				configure(null);
				await testing.performLaunchBrowser({});
				fs.unlinkSync(process.env.FAKE_BROWSER_LOG);
				configure();
			}
			const replacement = path.join(home, "replacement");
			fs.mkdirSync(replacement, { mode: kind === "symlink" ? 0o777 : 0o700 });
			fs.chmodSync(replacement, kind === "symlink" ? 0o777 : 0o700);
			fs.writeFileSync(path.join(replacement, "sentinel"), "unchanged");
			const swap = () => {
				fs.renameSync(profile, `${profile}-original`);
				if (kind === "symlink") fs.symlinkSync(replacement, profile);
				else fs.renameSync(replacement, profile);
			};
			if (stage === "port") {
				const createServer = net.createServer.bind(net);
				vi.spyOn(net, "createServer").mockImplementationOnce((...args) => {
					swap();
					return createServer(...args);
				});
			} else if (stage === "shutdown") {
				const kill = ChildProcess.prototype.kill;
				vi.spyOn(ChildProcess.prototype, "kill").mockImplementationOnce(function (...args) {
					swap();
					return kill.apply(this, args);
				});
			} else {
				gate.afterMkdir = (directory) => {
					if (directory !== path.join(profile, ".pi-computer-use.lock")) return;
					gate.afterMkdir = undefined;
					swap();
				};
			}
			await assert.rejects(testing.performLaunchBrowser({}), /symlink|changed/);
			const actual = kind === "symlink" ? replacement : profile;
			assert.deepEqual(fs.readdirSync(actual), ["sentinel"]);
			assert.equal(fs.readFileSync(path.join(actual, "sentinel"), "utf8"), "unchanged");
			assert.equal(fs.statSync(actual).mode & 0o777, kind === "symlink" ? 0o777 : 0o700);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test.each(["checkout", "chromium-lock", "lease-symlink", "lease-mode", "profile-mode", "ancestor-mode"])(
			"rechecks %s after lease creation without starting the browser or repairing permissions",
			async (change) => {
				const lease = path.join(profile, ".pi-computer-use.lock");
				const victim = path.join(home, "lease-victim");
				fs.mkdirSync(victim, { mode: 0o700 });
				fs.writeFileSync(path.join(victim, "sentinel"), "unchanged");
				gate.afterMkdir = (directory) => {
					if (directory !== lease) return;
					gate.afterMkdir = undefined;
					if (change === "checkout") fs.writeFileSync(path.join(profile, ".git"), "synthetic worktree");
					else if (change === "chromium-lock")
						fs.symlinkSync("synthetic-host-123", path.join(profile, "SingletonLock"));
					else if (change === "lease-symlink") {
						fs.rmdirSync(lease);
						fs.symlinkSync(victim, lease);
					} else if (change === "lease-mode") fs.chmodSync(lease, 0o755);
					else if (change === "profile-mode") fs.chmodSync(profile, 0o755);
					else fs.chmodSync(home, 0o775);
				};
				await assert.rejects(
					testing.performLaunchBrowser({}),
					/Git checkout|Chromium lock|lease changed|0700|ancestor/,
				);
				assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
				assert(!fs.existsSync(path.join(profile, "Local State")));
				assert.deepEqual(fs.readdirSync(victim), ["sentinel"]);
				assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "unchanged");
				if (change === "chromium-lock") assert(fs.lstatSync(path.join(profile, "SingletonLock")).isSymbolicLink());
				if (change === "lease-symlink") assert(fs.lstatSync(lease).isSymbolicLink());
				if (change === "lease-mode") assert.equal(fs.statSync(lease).mode & 0o777, 0o755);
				if (change === "profile-mode") {
					assert.equal(fs.statSync(profile).mode & 0o777, 0o755);
					assert(fs.existsSync(lease), "post-creation permission uncertainty must retain the lease");
				}
				if (change === "ancestor-mode") {
					assert.equal(fs.statSync(home).mode & 0o777, 0o775);
					assert(fs.existsSync(lease), "post-creation ancestry uncertainty must retain the lease");
				}
			},
		);

		test.each(["directory", "symlink"])("detects a %s swap during the post-lease refusal policy", async (kind) => {
			const replacement = path.join(home, "late-replacement");
			fs.mkdirSync(replacement, { mode: 0o700 });
			gate.afterStat = (directory) => {
				if (directory !== home || !fs.existsSync(path.join(profile, ".pi-computer-use.lock"))) return;
				gate.afterStat = undefined;
				fs.renameSync(profile, `${profile}-original`);
				if (kind === "symlink") fs.symlinkSync(replacement, profile);
				else fs.renameSync(replacement, profile);
			};
			await assert.rejects(testing.performLaunchBrowser({}), /changed|symlink/);
			assert.deepEqual(fs.readdirSync(kind === "symlink" ? replacement : profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
			assert(fs.existsSync(path.join(`${profile}-original`, ".pi-computer-use.lock")));
		});

		test("does not use or release a replacement lease with otherwise valid metadata", async () => {
			const lease = path.join(profile, ".pi-computer-use.lock");
			gate.afterLstatSync = (directory) => {
				if (directory !== lease) return;
				gate.afterLstatSync = undefined;
				fs.renameSync(lease, `${lease}-original`);
				fs.mkdirSync(lease, { mode: 0o700 });
			};
			await assert.rejects(testing.performLaunchBrowser({}), /lease changed/);
			assert(fs.existsSync(`${lease}-original`));
			assert(fs.existsSync(lease));
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses foreign lease ownership metadata without removing it", async () => {
			const lease = path.join(profile, ".pi-computer-use.lock");
			gate.foreignAncestor = lease;
			await assert.rejects(testing.performLaunchBrowser({}), /lease changed/);
			assert(fs.existsSync(lease));
			assert.equal(fs.statSync(lease).uid, process.getuid());
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses changed profile ownership metadata without touching the fixture", async () => {
			gate.foreignAncestor = profile;
			await assert.rejects(testing.performLaunchBrowser({}), /0700/);
			assert.equal(fs.statSync(profile).uid, process.getuid());
			assert.deepEqual(fs.readdirSync(profile), []);
		});

		test.each([0o775, 0o777])("refuses writable non-sticky ancestors (mode %s) without chmod", async (mode) => {
			fs.chmodSync(home, mode);
			await assert.rejects(testing.performLaunchBrowser({}), /ancestor/);
			assert.equal(fs.statSync(home).mode & 0o7777, mode);
			assert.deepEqual(fs.readdirSync(profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("refuses foreign-owned ancestry metadata without touching the fixture", async () => {
			gate.foreignAncestor = home;
			await assert.rejects(testing.performLaunchBrowser({}), /ancestor/);
			assert.equal(fs.statSync(home).uid, process.getuid());
			assert.deepEqual(fs.readdirSync(profile), []);
			assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
		});

		test("accepts a current-user sticky writable ancestor without chmod", async () => {
			fs.chmodSync(home, 0o1777);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
			assert.equal(fs.statSync(home).mode & 0o7777, 0o1777);
		});

		test("another Pi process cannot share a live persistent profile", async () => {
			await testing.performLaunchBrowser({});
			const script = `import { loadComputerUseConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)}; import { testing } from ${JSON.stringify(new URL("../src/bridge.ts", import.meta.url).href)}; loadComputerUseConfig(process.env.TEST_CWD); try { await testing.performLaunchBrowser({}); process.exitCode = 1; } catch (error) { if (!/locked/.test(error.message)) throw error; }`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: { ...process.env, TEST_CWD: root },
				stdio: ["ignore", "ignore", "pipe"],
				timeout: 15000,
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const code = await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			assert.equal(code, 0, stderr);
			assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
		});

		test("validates permissions, symlinks, non-directory and checkout paths without changing them", async () => {
			fs.chmodSync(profile, 0o755);
			await assert.rejects(testing.persistentBrowserProfile(profile), /0700/);
			assert.equal(fs.statSync(profile).mode & 0o777, 0o755);
			fs.chmodSync(profile, 0o700);
			const alias = path.join(home, "alias");
			fs.symlinkSync(profile, alias);
			await assert.rejects(testing.persistentBrowserProfile(alias), /symlink/);
			const nested = path.join(profile, "nested");
			fs.mkdirSync(nested, { mode: 0o700 });
			await assert.rejects(testing.persistentBrowserProfile(path.join(alias, "nested")), /symlink/);
			const file = path.join(home, "file");
			fs.writeFileSync(file, "", { mode: 0o700 });
			await assert.rejects(testing.persistentBrowserProfile(file), /real directory/);
			fs.writeFileSync(path.join(home, ".git"), "synthetic worktree marker");
			await assert.rejects(testing.persistentBrowserProfile(profile), /Git checkout/);
		});

		test("refuses native Windows persistence rather than guessing ACL security", async () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			await assert.rejects(testing.persistentBrowserProfile(profile), /Windows ACL/);
		});

		test("a lease that cannot be released remains fail-closed without deleting profile data", async () => {
			await testing.performLaunchBrowser({});
			const lease = path.join(profile, ".pi-computer-use.lock");
			const blocker = path.join(lease, "synthetic-blocker");
			fs.writeFileSync(blocker, "");
			await shutdownComputerUseSession();
			assert(fs.existsSync(profile));
			assert(fs.existsSync(blocker));
			fs.unlinkSync(blocker);
		});

		test("refuses relative paths, home, default profile trees and their ancestors", async () => {
			await assert.rejects(testing.persistentBrowserProfile("relative"), /absolute/);
			fs.chmodSync(home, 0o700);
			await assert.rejects(testing.persistentBrowserProfile(home), /default browser/);
			const standard = path.join(home, ".config/google-chrome");
			fs.mkdirSync(path.join(standard, "Default"), { recursive: true, mode: 0o700 });
			for (const directory of [path.dirname(standard), standard, path.join(standard, "Default")]) {
				fs.chmodSync(directory, 0o700);
				await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
			}
			assert.equal(await testing.persistentBrowserProfile("~/dedicated-profile"), profile);
		});

		test.each(["Chrome", "Chrome Canary", "Chrome Beta", "Chrome Dev"])(
			"rejects macOS %s default and descendants",
			async (channel) => {
				const directory = path.join(home, "Library/Application Support/Google", channel);
				const child = path.join(directory, "Default");
				fs.mkdirSync(child, { recursive: true, mode: 0o700 });
				for (const candidate of [directory, child]) {
					fs.chmodSync(candidate, 0o700);
					await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
				}
			},
		);

		test.each(["parent", "directory"])("rejects canonical macOS defaults through a %s alias", async (aliasKind) => {
			const actual = path.join(home, "relocated");
			fs.mkdirSync(actual, { mode: 0o700 });
			const parent = path.join(home, "Library/Application Support/Google");
			fs.mkdirSync(path.dirname(parent), { recursive: true });
			let candidate: string;
			if (aliasKind === "parent") {
				fs.symlinkSync(actual, parent);
				candidate = path.join(actual, "Chrome");
				fs.mkdirSync(candidate, { mode: 0o700 });
			} else {
				fs.mkdirSync(parent);
				fs.symlinkSync(actual, path.join(parent, "Chrome"));
				candidate = actual;
			}
			await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME", "implicit"])(
			"rejects %s ancestry even when every browser child is relocated",
			async (variable) => {
				const parent = path.join(home, "config-parent");
				const configRoot = variable === "implicit" ? path.join(home, ".config") : path.join(parent, "config");
				fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
				fs.chmodSync(path.dirname(configRoot), 0o700);
				const relocated = path.join(root, "relocated-browsers");
				fs.mkdirSync(relocated, { mode: 0o700 });
				for (const name of ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "helium"]) {
					fs.symlinkSync(relocated, path.join(configRoot, name));
				}
				if (variable !== "implicit") process.env[variable] = configRoot;
				const nested = path.join(configRoot, "nested");
				fs.mkdirSync(nested, { mode: 0o700 });
				for (const candidate of [configRoot, path.dirname(configRoot), nested, `${configRoot}/nested/../`]) {
					await assert.rejects(testing.persistentBrowserProfile(candidate), /default browser/);
				}
				const alias = path.join(root, "config-root-alias");
				fs.symlinkSync(configRoot, alias);
				await assert.rejects(testing.persistentBrowserProfile(alias), /symlink/);
				if (variable !== "implicit") {
					process.env[variable] = `${alias}/nested/../`;
					await assert.rejects(testing.persistentBrowserProfile(configRoot), /default browser/);
				}
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			},
		);

		test.each([true, false])(
			"preserves filesystem parent traversal through a symlink (root exists: %s)",
			async (exists) => {
				const declaredParent = path.join(root, "declared-parent");
				const resolvedParent = path.join(root, "resolved-parent");
				fs.mkdirSync(declaredParent, { mode: 0o700 });
				fs.mkdirSync(path.join(resolvedParent, "deep"), { recursive: true, mode: 0o700 });
				fs.chmodSync(resolvedParent, 0o700);
				const alias = path.join(declaredParent, "link");
				fs.symlinkSync(path.join(resolvedParent, "deep"), alias);
				if (exists) fs.mkdirSync(path.join(resolvedParent, "config"), { mode: 0o700 });
				process.env.XDG_CONFIG_HOME = `${alias}/../config`;
				await assert.rejects(testing.persistentBrowserProfile(resolvedParent), /default browser/);
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			},
		);

		test("resolves relative configuration roots by filesystem ancestry", async () => {
			const configRoot = path.join(home, "relative-config");
			fs.mkdirSync(configRoot, { mode: 0o700 });
			process.env.CHROME_CONFIG_HOME = path.relative(process.cwd(), configRoot);
			await assert.rejects(testing.persistentBrowserProfile(configRoot), /default browser/);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
		});

		test("retains macOS default-parent protection when all children are symlinked elsewhere", async () => {
			const parent = path.join(home, "Library/Application Support/Google");
			const target = path.join(root, "relocated-macos");
			fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
			fs.mkdirSync(target, { mode: 0o700 });
			for (const channel of ["Chrome", "Chrome Canary", "Chrome Beta", "Chrome Dev"]) {
				fs.symlinkSync(target, path.join(parent, channel));
			}
			await assert.rejects(testing.persistentBrowserProfile(parent), /default browser/);
			assert.equal(await testing.persistentBrowserProfile(profile), profile);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])(
			"honours filesystem case identity for %s",
			async (variable) => {
				const configuredRoot = path.join(home, "Config");
				const alternate = path.join(home, "config");
				fs.mkdirSync(configuredRoot, { mode: 0o700 });
				process.env[variable] = configuredRoot;
				if (fs.existsSync(alternate)) {
					await assert.rejects(testing.persistentBrowserProfile(alternate), /default browser/);
				} else {
					fs.mkdirSync(alternate, { mode: 0o700 });
					assert.equal(await testing.persistentBrowserProfile(alternate), alternate);
				}
			},
		);

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME", "HOME"])(
			"preserves %s alias-parent ancestry",
			async (variable) => {
				const external = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-alias-parent-")));
				const originalParent = path.join(root, "alias-parent");
				fs.mkdirSync(originalParent, { mode: 0o700 });
				const alias = path.join(originalParent, "linked-root");
				fs.symlinkSync(external, alias);
				try {
					if (variable === "HOME") vi.spyOn(os, "homedir").mockReturnValue(alias);
					else process.env[variable] = alias;
					await assert.rejects(testing.persistentBrowserProfile(originalParent), /default browser/);
					const dedicated = path.join(external, "fresh-profile");
					fs.mkdirSync(dedicated, { mode: 0o700 });
					if (variable === "HOME") assert.equal(await testing.persistentBrowserProfile(dedicated), dedicated);
					else assert.equal(await testing.persistentBrowserProfile(profile), profile);
				} finally {
					fs.rmSync(external, { recursive: true, force: true });
				}
			},
		);

		test("refuses HOME ancestors even when all default browser directories point outside them", async () => {
			const external = fs.realpathSync(fs.mkdtempSync(path.join(secureTemp, "cu-external-defaults-")));
			try {
				const defaults = [
					".config/google-chrome",
					".config/google-chrome-beta",
					".config/google-chrome-unstable",
					".config/chromium",
					".config/helium",
					"Library/Application Support/Google/Chrome",
					"Library/Application Support/Google/Chrome Canary",
					"Library/Application Support/Google/Chrome Beta",
					"Library/Application Support/Google/Chrome Dev",
					"Library/Application Support/Chromium",
					"Library/Application Support/net.imput.helium",
				];
				for (const relative of defaults) {
					const directory = path.join(home, relative);
					fs.mkdirSync(path.dirname(directory), { recursive: true });
					fs.symlinkSync(external, directory);
				}
				await assert.rejects(testing.persistentBrowserProfile(root), /default browser/);
				assert.equal(await testing.persistentBrowserProfile(profile), profile);
			} finally {
				fs.rmSync(external, { recursive: true, force: true });
			}
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])(
			"rejects Chrome channel default roots under %s",
			async (variable) => {
				const configRoot = path.join(home, variable);
				process.env[variable] = configRoot;
				for (const channel of ["google-chrome", "google-chrome-beta", "google-chrome-unstable"]) {
					const directory = path.join(configRoot, channel);
					fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
					await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
				}
			},
		);

		// Call 1 fails inside the ancestry comparison (`profilePathContains` rethrow); call 2 fails the direct `stat`
		// of the protected root. Both must refuse rather than treat an unreadable root as absent.
		test.each([
			[1, "ancestry comparison"],
			[2, "protected-root stat"],
		])("fails closed on non-ENOENT metadata failure %s (%s)", async (failureAt) => {
			const directory = path.join(home, "metadata-error");
			fs.mkdirSync(directory, { mode: 0o700 });
			process.env.XDG_CONFIG_HOME = directory;
			gate.statTarget = directory;
			gate.statCalls = 0;
			gate.statFailureAt = failureAt;
			try {
				await assert.rejects(testing.persistentBrowserProfile(profile), { code: "EACCES" });
				assert.equal(gate.statCalls, failureAt);
			} finally {
				gate.statTarget = "";
			}
		});

		test("fails closed when a configured root cannot be resolved for a reason other than absence", async () => {
			const file = path.join(home, "not-a-directory");
			fs.writeFileSync(file, "synthetic");
			process.env.XDG_CONFIG_HOME = path.join(file, "child");
			await assert.rejects(testing.persistentBrowserProfile(profile), { code: "ENOTDIR" });
		});

		test("rejects defaults under an aliased implicit configuration directory", async () => {
			const realRoot = path.join(home, "real-config");
			const directory = path.join(realRoot, "google-chrome");
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.symlinkSync(realRoot, path.join(home, ".config"));
			delete process.env.XDG_CONFIG_HOME;
			delete process.env.CHROME_CONFIG_HOME;
			await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
		});

		test.each(["XDG_CONFIG_HOME", "CHROME_CONFIG_HOME"])("rejects defaults under an aliased %s", async (variable) => {
			const realRoot = path.join(home, "real-config");
			const alias = path.join(home, "config-alias");
			const directory = path.join(realRoot, "google-chrome");
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			fs.symlinkSync(realRoot, alias);
			process.env[variable] = alias;
			await assert.rejects(testing.persistentBrowserProfile(directory), /default browser/);
		});

		test.each([".pi-computer-use.lock", "SingletonLock", "SingletonCookie", "SingletonSocket"])(
			"refuses existing %s without removing it or starting a browser",
			async (name) => {
				const lock = path.join(profile, name);
				// Chromium's SingletonLock can be a dangling symlink; lstat, not exists, must detect it.
				if (name === "SingletonLock") fs.symlinkSync("synthetic-host-123", lock);
				else fs.mkdirSync(lock);
				await assert.rejects(testing.performLaunchBrowser({}), /locked|in use/);
				assert(fs.lstatSync(lock));
				assert(!fs.existsSync(process.env.FAKE_BROWSER_LOG));
			},
		);

		test("failed synchronous spawn preserves the profile and releases only Pi's lease", async () => {
			await assert.rejects(testing.performLaunchBrowser({ url: "http://example.test/\0" }), {
				code: "ERR_INVALID_ARG_VALUE",
			});
			assert(fs.existsSync(profile));
			assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, undefined);
		});

		test("aborted readiness preserves the profile and restores the previous port", async () => {
			process.env.FAKE_BROWSER_NO_CDP = "1";
			process.env.PI_COMPUTER_USE_CDP_PORT = "9222";
			const controller = new AbortController();
			const launch = testing.performLaunchBrowser({}, controller.signal);
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(process.env.FAKE_BROWSER_LOG) && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			await assert.rejects(launch, /aborted/);
			assert(fs.existsSync(profile));
			assert(!fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
			assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, "9222");
		});

		test("exit hook preserves persistent data and leaves a fail-closed lease", async () => {
			await testing.performLaunchBrowser({});
			testing.removeProfileDirsOnExit();
			assert(fs.existsSync(profile));
			assert(fs.existsSync(path.join(profile, ".pi-computer-use.lock")));
		});
	});

	test.each([
		{ title: "Sign in", url: "http://127.0.0.1/" },
		{ title: "Home", url: "http://127.0.0.1/login" },
	])("launch_browser flags a possible login wall through the real launch path ($title $url)", async (page) => {
		process.env.FAKE_BROWSER_TITLE = page.title;
		process.env.FAKE_BROWSER_URL = page.url;
		try {
			const result = await testing.performLaunchBrowser({});
			assert.equal(result.details.warning, "authentication_required");
			assert.match(result.content[0].text, /Ask the user before any sign-in/);
		} finally {
			delete process.env.FAKE_BROWSER_TITLE;
			delete process.env.FAKE_BROWSER_URL;
		}
	});

	test("synthetic login walls are marked as heuristics, ordinary pages are not claimed authenticated", async () => {
		const page = await browserSnapshot("synthetic-login", []);
		for (const fields of [
			{ title: "Sign in" },
			{ url: "http://127.0.0.1/signin" },
			{ targets: [{ role: "textbox", name: "Password" }] },
		]) {
			const result = testing.browserObservationResult({ ...page, ...fields }, "cdp:synthetic", 0, "navigate_browser");
			assert.equal(result.details.warning, "authentication_required");
			assert.match(result.content[0].text, /Ask the user before any sign-in/);
		}
		const normal = testing.browserObservationResult(
			{ ...page, snapshotId: "synthetic-normal" },
			"cdp:synthetic",
			0,
			"observe_ui",
		);
		assert.equal(normal.details.warning, undefined);
	});
});
