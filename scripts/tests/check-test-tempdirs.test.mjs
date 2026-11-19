import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, test, vi } from "vitest";
import { checkTestTempdirs, dispatch } from "../check-test-tempdirs.mjs";

test("rejects new allocations even in untracked test files and reports stale baseline entries", ({
	onTestFinished,
}) => {
	const cwd = makeTestTempDir("pi-test-temp-contract-", onTestFinished);
	const write = (file, text) => {
		const path = join(cwd, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	const git = (...args) => execFileSync("git", args, { cwd });
	git("init", "-q");
	write("tests/deleted.ts", "");
	git("add", "tests/deleted.ts");
	rmSync(join(cwd, "tests/deleted.ts"));
	write(
		"scripts/test-tempdirs-baseline.json",
		JSON.stringify({ "tests/old.ts": 1, "tests/reduced.ts": 1, "tests/deleted.ts": 1 }),
	);
	// Spell the raw identifier in the generated files, not in this test source.
	const api = "mkd" + "temp";
	write("tests/old.ts", `fs.${api}()\n`);
	write("tests/reduced.ts", "makeTestTempDir(prefix, cleanup)\n");
	write("test/alias.mjs", `import { ${api}Sync as allocate } from "node:fs";`);
	write("feature.spec.ts", `fs["${api}"]()`);
	write("src/runtime.ts", `fs.${api}()`);
	write("tests/template.txt", `fs.${api}()`);
	write("tests/lib/src/temp-dir.ts", `fs.${api}Sync()`);
	expect(checkTestTempdirs(cwd)).toEqual([
		`feature.spec.ts: 1 new raw ${api}/${api}Sync reference(s); use makeTestTempDir`,
		`test/alias.mjs: 1 new raw ${api}/${api}Sync reference(s); use makeTestTempDir`,

		"tests/reduced.ts: reduce the baseline count from 1 to 0 (remove the entry at zero)",
		"tests/deleted.ts: remove the stale test temp directory baseline entry",
	]);
});

test("sets the CLI exit status based on the check result", () => {
	const previous = process.exitCode;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const check = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce(["invalid"]);
		dispatch(false, check);
		expect(check).not.toHaveBeenCalled();
		dispatch(false); // Exercise the default scanner binding without running against the outer checkout.
		dispatch(true, check);
		expect(process.exitCode).toBe(0);
		dispatch(true, check);
		expect(process.exitCode).toBe(1);
		expect(error).toHaveBeenCalledWith("invalid");
	} finally {
		process.exitCode = previous;
		error.mockRestore();
	}
});
