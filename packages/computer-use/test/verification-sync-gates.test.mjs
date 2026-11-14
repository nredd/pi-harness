import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { main as commits } from "../scripts/check-commit-messages.mjs";
import { validateLedger } from "../scripts/check-sync-ledger.mjs";
import { cases, main as reverts } from "../scripts/check-sync-reverts.mjs";
import { main as upstream } from "../scripts/check-upstream-sync.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = [];
const quiet = { log() {}, error() {} };
function scratch() {
	const root = mkdtempSync(path.join(os.tmpdir(), "sync-gates-"));
	temporary.push(root);
	return root;
}
function write(root, name, value) {
	const file = path.join(root, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, value);
}
function git(root, ...args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function repo(root) {
	mkdirSync(root, { recursive: true });
	git(root, "init", "--quiet");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.invalid");
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("commit policy measures real disposable history success and refusal in process", () => {
	const root = scratch();
	repo(root);
	for (const subject of ["Initial commit", "bad subject"]) {
		git(root, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", subject);
		assert.equal(
			commits(["HEAD"], {
				...quiet,
				env: {},
				read: readFileSync,
				exec: (command, args, options) => execFileSync(command, ["-C", root, ...args], options),
			}),
			subject === "Initial commit" ? 0 : 1,
		);
	}
});

test("commit policy fails closed across event, history and command failures", () => {
	const base = "a".repeat(40);
	const head = "b".repeat(64);
	const calls = [];
	const deps = {
		...quiet,
		env: {},
		read: () =>
			JSON.stringify({ before: base, after: head, pull_request: { base: { sha: base }, head: { sha: head } } }),
		exec: (_command, args) => {
			calls.push(args);
			return args[0] === "log" ? "Merge bad\nRevert bad\nValid subject\nrtl: Valid area\n" : "false";
		},
	};
	assert.equal(commits([], deps), 0);
	assert.equal(calls.at(-1)[2], "HEAD~1..HEAD");
	assert.equal(commits([], { ...deps, env: { COMMIT_RANGE: "explicit" } }), 0);
	assert.equal(calls.at(-1)[2], "explicit");
	for (const event of ["push", "pull_request", "pull_request_target"]) {
		const env = { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: "event.json" };
		assert.equal(commits([], { ...deps, env }), 0);
		assert.equal(calls.at(-1)[2], `${base}..${head}`);
		assert.equal(commits([], { ...deps, env: { GITHUB_EVENT_NAME: event } }), 1);
		for (const payload of [
			"invalid",
			"null",
			"{}",
			JSON.stringify({ before: "0".repeat(40), after: head }),
			JSON.stringify({ before: "branch", after: head }),
		])
			assert.equal(commits([], { ...deps, env, read: () => payload }), 1);
	}
	for (const range of ["", "--all"]) assert.equal(commits([range], deps), 1);
	assert.equal(commits([], { ...deps, exec: () => "true" }), 1);
	for (const error of [new Error("not a repository"), "non-Error refusal"])
		assert.equal(
			commits([], {
				...deps,
				exec: () => {
					throw error;
				},
			}),
			1,
		);
	assert.equal(
		commits([], { ...deps, exec: (_command, args) => (args[0] === "log" ? "lowercase\nTrailing period.\n" : "false") }),
		1,
	);
	assert.equal(commits([], { ...deps, exec: (_command, args) => (args[0] === "log" ? "" : "false") }), 0);
});

function ledgerFixture() {
	const root = path.join(scratch(), "packages/computer-use");
	mkdirSync(root, { recursive: true });
	const control = {
		name: "A control",
		file: "src/a.mjs",
		before: "original",
		after: "mutated",
		check: "scripts/probe.mjs",
		failure: /expected mutation/,
	};
	const ledger = {
		upstream: "a".repeat(40),
		files: ["src/a.mjs"],
		absorbed: [],
		release: {
			upstream: { status: "release-requested", reference: "https://github.com/injaneity/pi-computer-use/issues/116" },
		},
		patches: [
			{
				id: "a",
				purpose: "Retain fixture",
				check: control.check,
				files: [control.file],
				dropControls: [control.name],
				rows: ["Fixture"],
				upstream: { status: "harness-only", reference: "UPSTREAM.md" },
			},
		],
	};
	write(root, "sync-patches.json", JSON.stringify(ledger));
	write(root, "UPSTREAM.md", "| Fixture | x | y | z |\n");
	write(root, "scripts/check-sync-reverts.mjs", '\t\tname: "A control",\n');
	return { root, control, ledger };
}

test("upstream gate compares real tracked trees and rejects dirty, wrong-base and undeclared drift", () => {
	const { root, ledger } = ledgerFixture();
	const source = scratch();
	repo(source);
	write(source, "same", "identical");
	write(root, "same", "identical");
	write(source, "deleted", "removed");
	write(root, "added", "new");
	write(source, "changed", "old");
	write(root, "changed", "new");
	git(source, "add", ".");
	git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "Initial fixture");
	ledger.upstream = git(source, "rev-parse", "HEAD");
	// The comparison itself reads all bytes; the fixture owns its metadata differences explicitly.
	ledger.files = ["UPSTREAM.md", "added", "changed", "deleted", "scripts/check-sync-reverts.mjs", "sync-patches.json"];
	write(root, "sync-patches.json", JSON.stringify(ledger));
	repo(root);
	const deps = { ...quiet, root, env: {}, exec: execFileSync };
	assert.equal(upstream([source], deps), 0);
	write(source, "same", "dirty");
	assert.throws(() => upstream([source], deps), /must be clean/);
	git(source, "checkout", "--", "same");
	write(root, "unowned", "drift");
	assert.throws(() => upstream([source], deps), /undeclared drift/);
	rmSync(path.join(root, "unowned"));
	ledger.upstream = "0".repeat(40);
	write(root, "sync-patches.json", JSON.stringify(ledger));
	assert.throws(() => upstream([source], deps), /wrong upstream base/);
});

test("upstream fetch retry, exhaustion, cleanup and disabled paths remain offline", () => {
	const { root, ledger } = ledgerFixture();
	const dirs = [];
	let attempts = 0;
	const deps = {
		...quiet,
		root,
		env: { PI_CU_UPSTREAM_SYNC: "1" },
		exec: (_command, args, options) => {
			if (args[0] === "init") {
				dirs.push(args.at(-1));
				assert.equal(options.timeout, 120_000);
				return "";
			}
			if (args.includes("fetch")) {
				attempts++;
				if (attempts < 3) throw new Error("offline\nprivate detail");
				return "";
			}
			if (args.includes("checkout")) return "";
			if (args.includes("rev-parse")) return ledger.upstream;
			if (args.includes("status")) return "";
			return "";
		},
	};
	// A successful fetch enters actual byte comparison; an incomplete synthetic checkout is refused.
	assert.throws(() => upstream(["--fetch-if-enabled"], deps), /undeclared drift/);
	assert.equal(attempts, 3);
	for (const dir of dirs) assert.equal(existsSync(path.dirname(dir)), false);
	assert.throws(
		() =>
			upstream(["--fetch"], {
				...deps,
				exec: () => {
					throw new Error("offline");
				},
			}),
		/upstream fetch failed \(not drift\)/,
	);
	assert.equal(upstream(["--fetch-if-enabled"], { ...deps, env: {}, exec: () => assert.fail("network used") }), 0);
	assert.throws(() => upstream([], deps), /Usage/);
});

function revertFixture() {
	const fixture = ledgerFixture();
	const { root } = fixture;
	for (const directory of ["src", "test", "extensions", "native", "docs", "prebuilt", "assets"])
		mkdirSync(path.join(root, directory), { recursive: true });
	for (const name of ["vitest.config.ts", "package.json", "README.md", "CONTRIBUTING.md", "LICENSE"])
		write(root, name, "fixture");
	write(root, "package.json", '{"type":"module"}');
	write(root, "src/a.mjs", "original");
	write(
		root,
		"scripts/probe.mjs",
		'import { readFileSync } from "node:fs";\nif (readFileSync("src/a.mjs", "utf8") === "mutated") { console.error("expected mutation"); process.exitCode = 1; }\n',
	);
	const repository = path.resolve(root, "../..");
	symlinkSync(path.resolve(packageRoot, "../../node_modules"), path.join(repository, "node_modules"), "dir");
	mkdirSync(path.join(repository, "integration"));
	mkdirSync(path.join(repository, "coverage"));
	return fixture;
}

test("revert gate validates real inventory and executes an actual expected-failure child", () => {
	assert.equal(reverts(["--validate-only"]), 0);
	const { root, control } = revertFixture();
	assert.equal(reverts([], { root, cases: [control], platform: "darwin", spawn: spawnSync, ...quiet }), 0);
	assert.equal(readFileSync(path.join(root, control.file), "utf8"), "original");
});

function isDocumentationControl(args, cwd) {
	return args[1] === path.join(cwd, "scripts/check-docs.mjs");
}

test("documentation subprocess selection survives inserted and reordered controls", () => {
	const cwd = "/synthetic/sandbox";
	const documentation = ["/synthetic/tsx", path.join(cwd, "scripts/check-docs.mjs")];
	const cdp = ["/synthetic/run-vitest.ts", "node", "test/cdp-client.test.mjs"];
	const inserted = ["/synthetic/run-vitest.ts", "node", "test/build-native.test.mjs"];
	for (const commands of [[inserted, cdp, documentation], [documentation, cdp, inserted], [cdp, documentation, inserted]])
		assert.deepEqual(commands.filter((args) => isDocumentationControl(args, cwd)), [documentation]);
});

test("real documentation drop control rejects the mutant through a symlinked sandbox CLI", () => {
	let documentationSeen = false;
	assert.throws(
		() =>
			reverts([], {
				root: packageRoot,
				cases,
				platform: process.platform,
				...quiet,
				spawn: (command, args, options) => {
					if (documentationSeen) throw new Error("documentation control completed");
					if (isDocumentationControl(args, options.cwd)) {
						documentationSeen = true;
						const alias = path.join(scratch(), "package-alias");
						symlinkSync(options.cwd, alias, "dir");
						args[1] = path.join(alias, "scripts/check-docs.mjs");
					}
					return spawnSync(command, args, options);
				},
			}),
		/documentation control completed/,
	);
	assert.equal(documentationSeen, true);
});

test("revert gate refuses surviving mutations, wrong failures, launch errors and missing anchors, cleaning every sandbox", () => {
	const { root, control } = revertFixture();
	for (const result of [
		{ status: 0 },
		{ status: 1, stdout: "wrong", stderr: "" },
		{ error: new Error("spawn failed") },
	]) {
		let sandbox;
		assert.throws(() =>
			reverts([], {
				root,
				cases: [control],
				platform: "linux",
				...quiet,
				spawn: (_cmd, _args, options) => {
					sandbox = options.cwd;
					assert.equal(readFileSync(path.join(sandbox, control.file), "utf8"), "mutated");
					assert.equal(options.timeout, 90_000);
					assert.equal(options.env.PI_CU_LIVE, "");
					assert.equal(options.env.PI_COMPUTER_USE_LIVE, "");
					return result;
				},
			}),
		);
		assert.equal(existsSync(sandbox), false);
	}
	const deps = {
		root,
		cases: [{ ...control, darwinOnly: true }],
		platform: "linux",
		...quiet,
		spawn: () => assert.fail("skipped case spawned"),
	};
	assert.equal(reverts([], deps), 0);
	assert.throws(
		() => reverts([], { ...deps, platform: "darwin", cases: [{ ...control, before: "missing" }] }),
		/anchor missing/,
	);
	// Both launch branches are exercised; the fake result is only used to inspect the Vitest command.
	const ledger = JSON.parse(readFileSync(path.join(root, "sync-patches.json")));
	ledger.patches[0].check = "test/probe.test.mjs";
	write(root, "sync-patches.json", JSON.stringify(ledger));
	assert.equal(
		reverts([], {
			...deps,
			platform: "darwin",
			cases: [{ ...control, check: "test/probe.test.mjs" }],
			spawn: (_cmd, args, options) => {
				assert.equal(options.timeout, 90_000);
				const parity = cases.filter((entry) => entry.check === "test/strict-headless-invariant.test.mjs");
				assert.equal(parity.length, 2);
				for (const entry of parity) assert.equal(entry.timeoutMs, undefined);
				assert.match(args[0], /run-vitest.ts$/);
				assert.equal(args.at(-1), "--coverage.enabled=false");
				return { status: 1, stdout: "expected mutation", stderr: "" };
			},
		}),
		0,
	);
});

test("ledger gate rejects duplicate ids, undeclared sources and unowned controls", () => {
	const { ledger, control } = ledgerFixture();
	validateLedger(ledger, [control]);
	assert.throws(
		() => validateLedger({ ...ledger, patches: [...ledger.patches, ledger.patches[0]] }, [control]),
		/unique/,
	);
	assert.throws(() => validateLedger({ ...ledger, files: [] }, [control]), /undeclared/);
	assert.throws(() => validateLedger(ledger, [control, { name: "unowned" }]), /unowned/);
	assert.throws(() => validateLedger({ ...ledger, absorbed: null }, [control]), /absorbed/);
	assert.ok(cases.length > 0);
});

test("sync and commit CLIs dispatch through symlinked paths", () => {
	for (const [name, args, expected] of [
		["check-commit-messages", ["HEAD..HEAD"], /Checked 0 commit/],
		["check-sync-reverts", ["--validate-only"], /Sync ledger and actual revert cases validated/],
		["check-upstream-sync", ["--fetch-if-enabled"], /NOT RUN upstream sync/],
	]) {
		const link = path.join(scratch(), `${name}.mjs`);
		symlinkSync(path.join(packageRoot, `scripts/${name}.mjs`), link);
		const result = spawnSync(process.execPath, [link, ...args], {
			cwd: packageRoot,
			env: { ...process.env, PI_CU_UPSTREAM_SYNC: "" },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, expected);
	}
});

test("verification gate CLI dispatch is measured and imports without argv remain inert", async () => {
	const argv = process.argv;
	const env = process.env;
	const exitCode = process.exitCode;
	try {
		process.env = { ...env, COMMIT_RANGE: "HEAD..HEAD", PI_CU_UPSTREAM_SYNC: "" };
		for (const [name, args] of [
			["check-commit-messages", []],
			["check-sync-reverts", ["--validate-only"]],
			["check-upstream-sync", ["--fetch-if-enabled"]],
		]) {
			const url = new URL(`../scripts/${name}.mjs`, import.meta.url);
			process.argv = [process.execPath];
			vi.resetModules();
			await import(url.href);
			process.argv = [process.execPath, fileURLToPath(url), ...args];
			vi.resetModules();
			await import(url.href);
		}
	} finally {
		process.argv = argv;
		process.env = env;
		process.exitCode = exitCode;
	}
});
