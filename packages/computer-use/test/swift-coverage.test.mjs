import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { convert, main, sources, validateProfile } from "../scripts/swift-coverage.mjs";

const root = "/fixture";
function fixture(packageRoot = root) {
	const summary = {
		lines: { count: 1, covered: 0 },
		functions: { count: 1, covered: 0 },
		regions: { count: 2, covered: 1 },
	};
	return {
		json: {
			type: "llvm.coverage.json.export",
			data: [
				{
					files: sources.map((source) => ({
						filename: path.join(packageRoot, source),
						summary: structuredClone(summary),
					})),
					functions: [{ name: "$sCUHeadless_test" }],
				},
			],
		},
		lcov: sources
			.map(
				(source) =>
					`SF:${packageRoot}/${source}\nFN:1,f\nFNDA:0,f\nFNF:1\nFNH:0\nDA:1,0\nLF:1\nLH:0\nBRF:0\nBRH:0\nend_of_record\n`,
			)
			.join(""),
	};
}

test("Swift converter preserves all production zeroes and region units without branches", () => {
	const { json, lcov } = fixture();
	const result = convert(json, lcov, root);
	assert.deepEqual(
		result.files.map((file) => file.source),
		sources,
	);
	assert.deepEqual(result.files[0].regions, { total: 2, covered: 1, uncovered: 1 });
	assert.ok(result.lcov.includes("SF:native/macos/helper_entry.swift"));
	assert.ok(!result.lcov.includes("BRDA:"));
});

test("Swift native source-view counters stay distinct from LCOV record counters", () => {
	const f = fixture();
	f.json.data[0].files[0].summary.lines.count = 2;
	f.lcov = f.lcov.replace("LF:1", "LF:2");
	const result = convert(f.json, f.lcov, root);
	assert.equal(result.files[0].lines.total, 2);
	assert.equal(result.files[0].lcov.lines.total, 1);
	assert.ok(result.lcov.includes("LF:1"));
});

test("Swift converter resolves its default source root", () => {
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	const { json, lcov } = fixture(packageRoot.slice(0, -1));
	assert.equal(convert(json, lcov).files.length, sources.length);
});

test("Swift converter refuses missing, duplicate, foreign, empty and invalid counters", () => {
	for (const mutate of [
		({ json }) => {
			delete json.data;
		},
		({ json }) => {
			delete json.data[0].files;
		},
		({ json }) => {
			delete json.data[0].files[0].summary;
		},
		({ json }) => {
			json.data[0].files[0].summary = {};
		},
		(f) => {
			f.lcov = f.lcov.replace(/^SF:[^\n]+\n/, "");
		},
		(f) => {
			f.lcov = f.lcov.replace("DA:1,0", "DA:1,0\nDA:1,0");
		},
		(f) => {
			f.lcov = f.lcov.replace("DA:1,0", "DA:1,-1");
		},
		(f) => {
			f.lcov = f.lcov.replace("DA:1,0", "DA:1");
		},
		(f) => {
			f.lcov = f.lcov.replace("FNDA:0,f", "FNDA:0,");
		},
		(f) => {
			f.lcov = f.lcov.replace("DA:1,0", "");
		},

		({ json }) => {
			json.data = [];
		},
		({ json }) => {
			json.type = "unknown";
		},
		({ json }) => {
			json.data[0].files.pop();
		},
		({ json }) => {
			json.data[0].files.push(json.data[0].files[0]);
		},
		({ json }) => {
			json.data[0].files[0].filename = "/other/bridge.swift";
		},
		({ json }) => {
			json.data[0].files[0].summary.lines.count = 0;
		},
		({ json }) => {
			json.data[0].files[0].summary.regions.count = -1;
		},
		({ json }) => {
			json.data[0].files[0].summary.functions.covered = 2;
		},
		({ json }) => {
			json.data[0].files[0].summary.lines.count = 1.5;
		},
		(f) => {
			f.lcov = "";
		},
		(f) => {
			f.lcov += f.lcov;
		},
		(f) => {
			f.lcov = f.lcov.replace("FNF:1", "FNF:2");
		},
		(f) => {
			f.lcov = f.lcov.replace("LF:1", "LF:NaN");
		},
		(f) => {
			f.lcov = f.lcov.replace("DA:1,0", "BRDA:1,0,0,1\nDA:1,0");
		},
	]) {
		const f = fixture();
		mutate(f);
		assert.throws(() => convert(f.json, f.lcov, root));
	}
});

test("Swift profiles must belong to the unique compiled module, not another build", () => {
	const { json } = fixture();
	validateProfile(json, "Counters:\n  $sCUHeadless_test:\n    Counters: 1\n", "CUHeadless_test");
	for (const text of ["", "Counters:\n  $sOtherBuild:\n", "Counters:\n  $sCUHeadless_test:\n  $sForeign:\n"])
		assert.throws(() => validateProfile(json, text, "CUHeadless_test"), /Wrong-binary/);
	assert.throws(() => validateProfile(json, "  $sCUHeadless_test:\n", "CUHeadless_other"), /Wrong-binary/);
});

test("Swift producer refuses absent, empty, duplicate profiles and tool failure", () => {
	for (const mode of ["missing", "empty", "duplicate", "tool", "export", "wrong-binary", "success", "inventory"]) {
		const packageRoot = mkdtempSync(path.join(os.tmpdir(), "cu-swift-producer-"));
		mkdirSync(path.join(packageRoot, "native/macos"), { recursive: true });
		for (const source of sources) writeFileSync(path.join(packageRoot, source), "fixture\n");
		writeFileSync(path.join(packageRoot, "native/macos/headless_tests.swift"), "fixture");
		writeFileSync(path.join(packageRoot, "native/macos/README.md"), "fixture");
		if (mode === "inventory") writeFileSync(path.join(packageRoot, "native/macos/new.swift"), "fixture");
		let moduleName;
		const run = (command, args) => {
			const dir = path.join(packageRoot, "coverage/swift");
			if (command !== "xcrun") {
				if (mode !== "missing") writeFileSync(path.join(dir, "headless.profraw"), mode === "empty" ? "" : "profile");
				if (mode === "duplicate") writeFileSync(path.join(dir, "other.profraw"), "profile");
				return "";
			}
			if (mode === "tool") throw new Error("compiler tool failed");
			if (args[0] === "swiftc") {
				if (args.includes("--version")) return "Swift fixture";
				assert.ok(args.includes("-profile-coverage-mapping"));
				assert.ok(args.includes(path.join(packageRoot, "native/macos/helper_entry.swift")));
				moduleName = args[args.indexOf("-module-name") + 1];
				writeFileSync(path.join(dir, "headless-tests"), "binary");
				return "";
			}
			if (args[0] === "llvm-profdata") {
				if (args[1] === "show") return `  $s${mode === "wrong-binary" ? "Foreign" : moduleName}:\n`;
				writeFileSync(path.join(dir, "headless.profdata"), "profile");
				return "";
			}
			if (mode === "export") return "{}";
			const f = fixture(packageRoot);
			f.json.data[0].functions = [{ name: `$s${moduleName}` }];
			return args.includes("-format=lcov") ? f.lcov : JSON.stringify(f.json);
		};
		try {
			if (mode === "success") {
				main({ platform: "darwin", arch: "x64", packageRoot, run });
				assert.equal(
					JSON.parse(readFileSync(path.join(packageRoot, "coverage/swift/summary.json"))).files.length,
					sources.length,
				);
			} else assert.throws(() => main({ platform: "darwin", arch: "arm64", packageRoot, run }));
		} finally {
			rmSync(packageRoot, { recursive: true, force: true });
		}
	}
});

test("Swift CLI uses host policy and missing argv is not an entry point", async () => {
	const argv = process.argv;
	const platform = process.platform;
	try {
		Object.defineProperty(process, "platform", { value: "linux" });
		process.argv = [argv[0], fileURLToPath(new URL("../scripts/swift-coverage.mjs", import.meta.url))];
		vi.resetModules();
		await import("../scripts/swift-coverage.mjs");
		process.argv = [argv[0]];
		vi.resetModules();
		await import("../scripts/swift-coverage.mjs");
	} finally {
		process.argv = argv;
		Object.defineProperty(process, "platform", { value: platform });
	}
});

test("non-macOS Swift coverage is explicitly NOT RUN, never an empty report", () => {
	main({
		platform: "linux",
		run: () => {
			throw new Error("must not launch a child");
		},
	});
});
