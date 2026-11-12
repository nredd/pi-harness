#!/usr/bin/env node
/** Real-source, headless Swift coverage. No production source is copied or rewritten. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const sources = [
	"activity_glow.swift",
	"agent_cursor.swift",
	"agent_cursor_motion.swift",
	"bridge.swift",
	"helper_entry.swift",
].map((name) => `native/macos/${name}`);
const testSource = "native/macos/headless_tests.swift";

function count(value) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid LLVM counter");
	return value;
}

/** Validate full-source LLVM exports and retain only the exact production inventory in LCOV. */
export function convert(json, lcov, packageRoot = root) {
	if (json.type !== "llvm.coverage.json.export" || json.data?.length !== 1) throw new Error("Invalid LLVM export");
	const expected = new Set(sources);
	const files = new Map();
	const normalize = (filename) => {
		const relative = path.relative(packageRoot, filename);
		if (path.resolve(packageRoot, relative) !== filename || ![...sources, testSource].includes(relative))
			throw new Error(`Wrong source path: ${filename}`);
		return relative;
	};
	for (const file of json.data[0].files ?? []) {
		const relative = normalize(file.filename);
		if (files.has(relative)) throw new Error(`Duplicate source: ${relative}`);
		for (const metric of ["lines", "functions", "regions"]) {
			const summary = file.summary?.[metric];
			if (!summary || count(summary.covered) > count(summary.count)) throw new Error(`Invalid ${metric} counters`);
		}
		files.set(relative, file);
	}
	for (const source of expected)
		if (!files.has(source) || files.get(source).summary.lines.count === 0)
			throw new Error(`Missing production source: ${source}`);
	const records = new Map();
	const accounting = new Map();
	for (const block of lcov.trim().split("end_of_record")) {
		if (!block.trim()) continue;
		const rows = block.trim().split("\n");
		const sf = rows.filter((row) => row.startsWith("SF:"));
		if (sf.length !== 1) throw new Error("Missing or duplicate SF");
		const relative = normalize(sf[0].slice(3));
		if (records.has(relative) || !files.has(relative)) throw new Error(`Duplicate or unknown LCOV source: ${relative}`);
		for (const [prefix, metric, key] of [
			["LF:", "lines", "count"],
			["LH:", "lines", "covered"],
			["FNF:", "functions", "count"],
			["FNH:", "functions", "covered"],
		]) {
			const matches = rows.filter((row) => row.startsWith(prefix));
			if (
				matches.length !== 1 ||
				!/^\d+$/.test(matches[0].slice(prefix.length)) ||
				count(Number(matches[0].slice(prefix.length))) !== files.get(relative).summary[metric][key]
			)
				throw new Error(`LCOV ${prefix} disagrees with LLVM JSON: ${relative}`);
		}
		// LLVM's source-view LF/FNF totals can differ from its LCOV DA/FNDA rows (line gaps and
		// instantiations). Validate native summaries above, then count actual LCOV records for fan-in.
		const totals = {};
		for (const [prefix, metric] of [
			["DA:", "lines"],
			["FNDA:", "functions"],
		]) {
			const entries = rows.filter((row) => row.startsWith(prefix)).map((row) => row.slice(prefix.length).split(","));
			const identities = entries.map(([first, second]) => (prefix === "DA:" ? first : second));
			if (
				entries.length === 0 ||
				new Set(identities).size !== entries.length ||
				entries.some(
					(parts) =>
						parts.length !== 2 || !/^\d+$/.test(prefix === "DA:" ? parts[1] : parts[0]) || !parts[0] || !parts[1],
				)
			)
				throw new Error("Malformed or duplicate LCOV counters");
			const covered = entries.filter((parts) => count(Number(prefix === "DA:" ? parts[1] : parts[0])) > 0).length;
			totals[metric] = { total: entries.length, covered, uncovered: entries.length - covered };
		}
		for (const [prefix, metric, key] of [
			["LF:", "lines", "total"],
			["LH:", "lines", "covered"],
			["FNF:", "functions", "total"],
			["FNH:", "functions", "covered"],
		]) {
			const index = rows.findIndex((row) => row.startsWith(prefix));
			rows[index] = `${prefix}${totals[metric][key]}`;
		}
		accounting.set(relative, totals);
		// LLVM Swift has regions, not Istanbul statements or branch outcomes. Never rename them BRDA.
		if (rows.some((row) => row.startsWith("BRDA:")))
			throw new Error("Unexpected Swift branch producer; declare its semantics first");
		records.set(
			relative,
			`${rows.map((row) => (row.startsWith("SF:") ? `SF:${relative}` : row)).join("\n")}\nend_of_record\n`,
		);
	}
	for (const source of expected) if (!records.has(source)) throw new Error(`Missing LCOV source: ${source}`);
	return {
		lcov: sources.map((source) => records.get(source)).join(""),
		files: sources.map((source) => ({
			source,
			lcov: accounting.get(source),
			...Object.fromEntries(
				["lines", "functions", "regions"].map((metric) => {
					const { count: total, covered } = files.get(source).summary[metric];
					return [metric, { total, covered, uncovered: total - covered }];
				}),
			),
		})),
	};
}

/** Reject profiles from another binary, including a previous build of these same sources.
 * Each build has a unique Swift module identity because Mach-O profiles have no LLVM binary IDs.
 */
export function validateProfile(json, profileText, moduleName) {
	const functions = new Set(json.data[0].functions.map(({ name }) => name));
	const names = [...profileText.matchAll(/^ {2}(\S.*):$/gm)].map((match) => match[1].split(":").at(-1));
	if (!names.length || !names.some((name) => name.includes(moduleName)) || names.some((name) => !functions.has(name)))
		throw new Error("Wrong-binary or empty Swift profile");
}

/** Compile once, execute only deterministic assertions, export and validate fresh profiles. */
export function main({
	platform = process.platform,
	arch = process.arch,
	packageRoot = root,
	run = execFileSync,
} = {}) {
	if (platform !== "darwin") {
		console.log("Swift coverage NOT RUN: requires macOS");
		return;
	}
	const directory = path.join(packageRoot, "coverage/swift");
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const actual = readdirSync(path.join(packageRoot, "native/macos"))
		.filter((name) => name.endsWith(".swift") && !name.endsWith("_tests.swift"))
		.map((name) => `native/macos/${name}`)
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(sources))
		throw new Error("Swift production inventory changed; update producer and accounting together");
	const invoke = (tool, args, options = {}) =>
		run("xcrun", [tool, ...args], { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024, ...options });
	const binary = path.join(directory, "headless-tests");
	const profile = path.join(directory, "headless.profraw");
	const merged = path.join(directory, "headless.profdata");
	const moduleName = `CUHeadless_${randomUUID().replaceAll("-", "")}`;
	const args = [
		"-j",
		"1",
		"-module-name",
		moduleName,
		"-target",
		`${arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
		"-D",
		"PI_CU_HEADLESS_TEST",
		"-profile-generate",
		"-profile-coverage-mapping",
		"-Onone",
		"-warnings-as-errors",
		...sources.map((source) => path.join(packageRoot, source)),
		path.join(packageRoot, testSource),
		"-o",
		binary,
	];
	invoke("swiftc", args);
	run(binary, [], { stdio: "inherit", timeout: 30_000, env: { ...process.env, LLVM_PROFILE_FILE: profile } });
	const profiles = readdirSync(directory).filter((name) => name.endsWith(".profraw"));
	if (profiles.length !== 1 || profiles[0] !== "headless.profraw" || readFileSync(profile).length === 0)
		throw new Error("Missing, empty or duplicate Swift profiles");
	invoke("llvm-profdata", ["merge", "-sparse", profile, "-o", merged]);
	const profileText = invoke("llvm-profdata", ["show", "--all-functions", "--counts", merged]);
	const exportArgs = ["export", binary, `-instr-profile=${merged}`, "-check-binary-ids"];
	const raw = invoke("llvm-cov", exportArgs);
	const lcov = invoke("llvm-cov", [...exportArgs, "-format=lcov"]);
	const json = JSON.parse(raw);
	const result = convert(json, lcov, packageRoot);
	validateProfile(json, profileText, moduleName);
	writeFileSync(path.join(directory, "profile.txt"), profileText);
	writeFileSync(path.join(directory, "llvm.json"), raw);
	writeFileSync(path.join(directory, "llvm-lcov.info.txt"), lcov);
	writeFileSync(path.join(directory, "lcov.info"), result.lcov);
	const metadata = {
		toolchain: invoke("swiftc", ["--version"]).trim(),
		moduleName,
		command: ["xcrun", "swiftc", ...args],
		binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
		profileSha256: createHash("sha256").update(readFileSync(merged)).digest("hex"),
		sources: Object.fromEntries(
			sources.map((source) => [
				source,
				createHash("sha256")
					.update(readFileSync(path.join(packageRoot, source)))
					.digest("hex"),
			]),
		),
		files: result.files,
	};
	writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	for (const file of result.files)
		console.log(
			`${file.source}: ${["lines", "functions", "regions"].map((metric) => `${metric}=${file[metric].uncovered}/${file[metric].total} uncovered`).join(", ")}`,
		);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
