/** Private SDK preparation for compiler invariants, never a persistent or shared cache. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCheckCommand } from "../../scripts/check-async.mjs";

// SDK-only imports took 135.65s locally under concurrent gates; one interrupted at 180s.
// Preparation has its own visible 240s failure bound, not INV-8's 90s source-validation budget.
export const SDK_PREPARE_TIMEOUT_MS = 240_000;
export const SDK_HOOK_TIMEOUT_MS = 300_000;
const IDENTITY_TIMEOUT_MS = 10_000;
export const SDK_IMPORTS = Object.freeze([
	"ApplicationServices",
	"AppKit",
	"CoreGraphics",
	"Darwin",
	"Foundation",
	"ImageIO",
	"Observation",
	"QuartzCore",
	"ScreenCaptureKit",
	"SwiftUI",
	"Vision",
]);
const IMPORTS = SDK_IMPORTS.map((name) => `import ${name}\n`).join("");

/** Hash exact identity bytes without depending on a global compiler cache key. */
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

/** Bind the resolved compiler file and SDK settings, not just their path strings. */
async function inputsIdentity(compiler, sdk) {
	const stat = await fs.stat(compiler, { bigint: true });
	return {
		compilerFile: [
			stat.dev,
			stat.ino,
			stat.size,
			stat.mtimeNs,
			stat.ctimeNs,
		].map(String),
		sdkSettings: digest(await fs.readFile(path.join(sdk, "SDKSettings.json"))),
	};
}

/** Preserve bounded compiler diagnostics when the shared subprocess runner wraps a failure. */
async function compilerCommand(compiler, args, options) {
	try {
		return await runCheckCommand(compiler, args, options);
	} catch (error) {
		throw new Error(
			`${error.message}\n${error.cause?.stdout ?? ""}${error.cause?.stderr ?? ""}`,
			{ cause: error },
		);
	}
}

/** Bypass Vitest's captured console so successful cold preparation is visible in gate logs too. */
function reportPreparation(message) {
	process.stderr.write(`${message}\n`);
}

/**
 * Populate one run-owned cache using ONLY SDK imports, and publish identity only on success.
 * The caller owns/removes scratch (including on failure). No shared paths, locks or cross-run reuse.
 * The identity probes have individual 10s bounds; compilation has its own 240s bound and bounded
 * process-group cleanup from runCheckCommand. The enclosing hook reserves 300s for both.
 */
export async function prepareSwiftSdk({
	scratch,
	target,
	xcrun = "/usr/bin/xcrun",
	prepareTimeoutMs = SDK_PREPARE_TIMEOUT_MS,
	report = reportPreparation,
}) {
	const started = performance.now();
	const probe = async (args) =>
		(
			await compilerCommand(xcrun, args, {
				label: "Swift SDK identity",
				timeoutMs: IDENTITY_TIMEOUT_MS,
			})
		).stdout.trim();
	const compiler = await probe(["--sdk", "macosx", "--find", "swiftc"]);
	const sdk = await probe(["--sdk", "macosx", "--show-sdk-path"]);
	const version = (
		await compilerCommand(compiler, ["--version"], {
			label: "Swift compiler identity",
			timeoutMs: IDENTITY_TIMEOUT_MS,
		})
	).stdout.trim();
	const moduleCache = path.join(scratch, "module-cache");
	await fs.mkdir(moduleCache, { mode: 0o700 });
	const args = Object.freeze([
		"-target",
		target,
		"-sdk",
		sdk,
		"-parse-as-library",
		"-module-cache-path",
		moduleCache,
	]);
	const identity = Object.freeze({
		compiler,
		sdk,
		version,
		target,
		imports: digest(IMPORTS),
		...(await inputsIdentity(compiler, sdk)),
	});
	const key = digest(JSON.stringify(identity));
	const receipt = path.join(scratch, "sdk-ready.json");
	const source = path.join(scratch, "sdk-imports.swift");
	await fs.writeFile(source, IMPORTS);
	report(
		`Swift SDK prepare start key=${key} cache=${moduleCache} target=${target} compiler=${compiler} sdk=${sdk} deadline=${prepareTimeoutMs}ms`,
	);
	try {
		await compilerCommand(compiler, [...args, "-typecheck", source], {
			label: "Swift SDK preparation",
			timeoutMs: prepareTimeoutMs,
		});
		// A compiler/SDK replacement while preparation runs cannot authorize later source validation.
		if (
			JSON.stringify(await inputsIdentity(compiler, sdk)) !==
			JSON.stringify({
				compilerFile: identity.compilerFile,
				sdkSettings: identity.sdkSettings,
			})
		)
			throw new Error("SDK preparation identity mismatch");
		await fs.writeFile(
			receipt,
			JSON.stringify({ key, moduleCache, identity }),
			{ flag: "wx", mode: 0o600 },
		);
		report(
			`Swift SDK prepare ready key=${key} elapsed=${Math.round(performance.now() - started)}ms`,
		);
		return Object.freeze({
			compiler,
			moduleCache,
			args,
			identity,
			key,
			receipt,
		});
	} catch (error) {
		report(
			`Swift SDK prepare failed key=${key} elapsed=${Math.round(performance.now() - started)}ms`,
		);
		throw error;
	}
}

/** Validate preparation identity before compiling fresh source with the same target/SDK/cache. */
export async function runPreparedSwift(prepared, args, options) {
	const receipt = JSON.parse(await fs.readFile(prepared.receipt, "utf8"));
	const current = {
		...prepared.identity,
		...(await inputsIdentity(prepared.compiler, prepared.identity.sdk)),
	};
	if (
		receipt.key !== prepared.key ||
		receipt.moduleCache !== prepared.moduleCache ||
		digest(JSON.stringify(current)) !== prepared.key ||
		JSON.stringify(receipt.identity) !== JSON.stringify(prepared.identity)
	)
		throw new Error("SDK preparation identity mismatch");
	return compilerCommand(
		prepared.compiler,
		[...prepared.args, ...args],
		options,
	);
}
