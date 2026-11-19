import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, test, vi } from "vitest";
import { checkTestTempdirs, dispatch } from "../check-test-tempdirs.mjs";

function fixtureRepo(onTestFinished) {
	const cwd = makeTestTempDir("pi-test-temp-contract-", onTestFinished);
	const write = (file, text) => {
		const path = join(cwd, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git("init", "-q");
	const saveBase = () => {
		git("add", ".");
		const sha = git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit-tree",
			"--no-gpg-sign",
			git("write-tree"),
			"-m",
			"Base",
		);
		git("update-ref", "HEAD", sha);
		return sha;
	};
	return { cwd, write, saveBase };
}

const baselinePath = "scripts/test-tempdirs-baseline.json";
// Spell the raw identifier in generated files, not in this test source.
const api = "mkd" + "temp";

test("rejects new allocations even in untracked test files and reports stale baseline entries", ({
	onTestFinished,
}) => {
	const { cwd, write, saveBase } = fixtureRepo(onTestFinished);
	write("tests/deleted.ts", "");
	const base = saveBase();
	rmSync(join(cwd, "tests/deleted.ts"));
	write(baselinePath, JSON.stringify({ "tests/old.ts": 1, "tests/reduced.ts": 1, "tests/deleted.ts": 1 }));
	write("tests/old.ts", `fs.${api}()\n`);
	write("tests/reduced.ts", "makeTestTempDir(prefix, cleanup)\n");
	write("test/alias.mjs", `import { ${api}Sync as allocate } from "node:fs";`);
	write("feature.spec.ts", `fs["${api}"]()`);
	write("src/runtime.ts", `fs.${api}()`);
	write("tests/template.txt", `fs.${api}()`);
	write("tests/lib/src/temp-dir.ts", `fs.${api}Sync()`);
	write("forks/pi/tests/fork.test.ts", `fs.${api}()`);
	expect(checkTestTempdirs(cwd, base)).toEqual([
		`feature.spec.ts: 1 new raw ${api}/${api}Sync reference(s); use makeTestTempDir`,
		`test/alias.mjs: 1 new raw ${api}/${api}Sync reference(s); use makeTestTempDir`,

		"tests/reduced.ts: reduce the baseline count from 1 to 0 (remove the entry at zero)",
		"tests/deleted.ts: remove the stale test temp directory baseline entry",
	]);
});

test("allows the initial baseline when the merge base has none", ({ onTestFinished }) => {
	const { cwd, write, saveBase } = fixtureRepo(onTestFinished);
	const base = saveBase();
	write(baselinePath, JSON.stringify({ "tests/current.ts": 1 }));
	write("tests/current.ts", `fs.${api}()`);
	expect(checkTestTempdirs(cwd, base)).toEqual([]);
});

test("rejects increased counts and new entries but permits removal", ({ onTestFinished }) => {
	const { cwd, write, saveBase } = fixtureRepo(onTestFinished);
	write(baselinePath, JSON.stringify({ "tests/current.ts": 1, "tests/migrated.ts": 1 }));
	write("tests/current.ts", `fs.${api}()`);
	write("tests/migrated.ts", `fs.${api}()`);
	const base = saveBase();
	write("tests/migrated.ts", "makeTestTempDir(prefix, cleanup)");
	write(baselinePath, JSON.stringify({ "tests/current.ts": 1 }));
	expect(checkTestTempdirs(cwd, base)).toEqual([]);

	write(baselinePath, JSON.stringify({ "tests/current.ts": 2, "tests/new.ts": 1 }));
	write("tests/current.ts", `fs.${api}(); fs.${api}()`);
	write("tests/new.ts", `fs.${api}()`);
	expect(checkTestTempdirs(cwd, base)).toEqual([
		`tests/current.ts: temp directory baseline grew from 1 to 2 vs ${base}`,
		`tests/new.ts: new temp directory baseline entry vs ${base}`,
	]);
});

test("sets the CLI exit status and passes the comparison ref", () => {
	const previous = process.exitCode;
	const argv = process.argv;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const check = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce(["invalid"]);
		dispatch(false, check);
		expect(check).not.toHaveBeenCalled();
		dispatch(false); // Exercise the default scanner binding without running against the outer checkout.
		process.argv = argv.slice(0, 2);
		dispatch(true, check);
		expect(check).toHaveBeenLastCalledWith(expect.any(String), "origin/main");
		expect(process.exitCode).toBe(0);
		process.argv.push("custom-base");
		dispatch(true, check);
		expect(check).toHaveBeenLastCalledWith(expect.any(String), "custom-base");
		expect(process.exitCode).toBe(1);
		expect(error).toHaveBeenCalledWith("invalid");
	} finally {
		process.argv = argv;
		process.exitCode = previous;
		error.mockRestore();
	}
});
