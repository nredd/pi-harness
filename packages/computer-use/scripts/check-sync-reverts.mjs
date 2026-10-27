#!/usr/bin/env node
// Negative controls for the carried patch groups. Only deterministic, non-GUI checks run.
// Source-wiring assertions are not live native verification; UPSTREAM.md records that boundary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(os.tmpdir(), "cu-sync-reverts-"));
const nodeModules = path.resolve(root, "../../node_modules");
const cases = [
	{
		name: "helper replacement restart (1eabebd)",
		file: "scripts/setup-helper.mjs",
		before: "await stopRunningHelper();",
		after: "/* old helper left running */",
		check: "check-local-signing.mjs",
		failure: /replacement must stop the helper/,
	},
	{
		name: "daemon age guard (1eabebd/50cbfe2)",
		file: "src/platform/macos/helper.ts",
		before: "processStartMs + 1_000 < binaryChangeMs",
		after: "false",
		check: "check-macos-observe-target.mjs",
		failure: /older daemon must be stale/,
	},
	{
		name: "ctime freshness after preserved-mtime replacement (50cbfe2)",
		file: "src/platform/macos/helper.ts",
		before: "const { ctimeMs } = await stat(HELPER_APP_EXECUTABLE_PATH)",
		after: "const { mtimeMs: ctimeMs } = await stat(HELPER_APP_EXECUTABLE_PATH)",
		check: "check-macos-observe-target.mjs",
		failure: /binary freshness must use ctime, not preserved mtime/,
	},
	{
		name: "whole-desktop native dispatch (b009179)",
		file: "native/macos/bridge.swift",
		before: 'case "captureDisplay":',
		after: 'case "captureDisplayDropped":',
		check: "check-desktop-tools.mjs",
		failure: /native display capture dispatch must remain/,
	},
	{
		name: "cursor readback and interpolated dragging (e33ab31)",
		file: "native/macos/bridge.swift",
		before: "let cursor = CGEvent(source: nil)?.location",
		after: "let cursor = NSEvent.mouseLocation",
		check: "check-desktop-tools.mjs",
		failure: /cursor readback must use top-left global coordinates/,
	},
	{
		name: "desktop headless policy (c6a27ca)",
		file: "src/desktop.ts",
		before: "if (config.headless)",
		after: "if (false)",
		check: "check-desktop-tools.mjs",
		failure: /Missing expected rejection/,
		darwinOnly: true,
	},
	{
		name: "desktop_control opt-out (c6a27ca)",
		file: "src/desktop.ts",
		before: "if (!config.desktop_control)",
		after: "if (false)",
		check: "check-desktop-tools.mjs",
		failure: /Missing expected rejection/,
		darwinOnly: true,
	},
	{
		name: "transaction-scoped desktop lease (c6a27ca/50cbfe2/400f784/3fd2fe3)",
		file: "src/desktop.ts",
		before: "return await desktopLeaseStorage.run(lease, work);",
		after: "return await work();",
		check: "check-unpaired-act.mjs",
		failure: /desktop_input must not interleave inside a physical act_ui transaction/,
	},
	{
		name: "look ownership transfer and eviction (400f784/50cbfe2/3fd2fe3)",
		file: "native/macos/bridge.swift",
		before: "guard from != to else { return }",
		after: "guard false else { return }",
		check: "check-macos-native-pure.mjs",
		failure: /refs handed to a successor look survive the base look's eviction/,
		darwinOnly: true,
	},
	{
		name: "per-process ref epoch (50cbfe2/3fd2fe3)",
		file: "native/macos/bridge.swift",
		before: "String(UInt32.random(in: 0x1000...0xFFFF_FFFF), radix: 16)",
		after: '"1000"',
		check: "check-macos-native-pure.mjs",
		failure: /another store \(helper process\) never reissues the same ref/,
		darwinOnly: true,
	},
	{
		name: "bounded unowned ref FIFO (400f784/3fd2fe3)",
		file: "native/macos/bridge.swift",
		before: "if unowned.count > unownedCapacity {",
		after: "if false {",
		check: "check-macos-native-pure.mjs",
		failure: /unowned refs capped at 3/,
		darwinOnly: true,
	},
	{
		name: "look-owned ref eviction (400f784/50cbfe2)",
		file: "native/macos/bridge.swift",
		before: "for ref in refsByOwner.removeValue(forKey: owner) ?? [] { removeElement(ref) }",
		after: "/* owned refs leaked */",
		check: "check-macos-native-pure.mjs",
		failure: /dropping a look frees only its refs/,
		darwinOnly: true,
	},
	{
		name: "single root delta mapping (50cbfe2/4d596ca)",
		file: "src/bridge.ts",
		before: "if (!execution.rootDelta?.length) return;",
		after: "return;",
		check: "check-unpaired-act.mjs",
		failure: /delta line missing an @r ref/,
	},
	{
		name: "coded stale root outcome (50cbfe2)",
		file: "src/bridge.ts",
		before:
			'const rootExpired = exactRootAvailable === true && (error as { code?: string } | undefined)?.code === "root_not_found";',
		after: "const rootExpired = false;",
		check: "check-act-outcomes.mjs",
		failure: /coded stale root must report root_stale/,
	},
	{
		name: "replacement root kind filtering (50cbfe2)",
		file: "src/bridge.ts",
		before: "REPLACEMENT_ROOT_KINDS.has(delta.kind)",
		after: "true",
		check: "check-act-outcomes.mjs",
		failure: /menus, dead and foreign roots must not count as replacements/,
	},
	{
		name: "ranked app activation (400f784/3fd2fe3)",
		file: "native/macos/bridge.swift",
		before: "{ $0.bundleIdentifier }, { $0.localizedName }",
		after: "{ $0.localizedName }, { $0.bundleIdentifier }",
		check: "check-desktop-tools.mjs",
		failure: /activation must rank bundle id before name before executable/,
	},
	{
		name: "untrusted clipboard fence (400f784/3fd2fe3)",
		file: "src/desktop.ts",
		before: "</clipboard>",
		after: "clipboard-end",
		check: "check-desktop-tools.mjs",
		failure: /clipboard content must be fenced as untrusted data/,
		darwinOnly: true,
	},
	{
		name: "Linux writable cache target (harness c59eb11)",
		file: "scripts/setup-helper.mjs",
		before: '"--target-dir", linuxBuildTargetDir',
		after: '"--target-dir-dropped", linuxBuildTargetDir',
		check: "check-linux-build-scripts.mjs",
		failure: /target-dir/,
	},
	{
		name: "Linux compiler group escalation (harness c59eb11)",
		file: "scripts/setup-helper.mjs",
		before: 'signalGroup("SIGKILL");',
		after: "/* compiler group not killed */",
		check: "check-linux-build-scripts.mjs",
		failure: /compiler cleanup must escalate to group SIGKILL/,
	},
	{
		name: "cursor source packaging (harness 6207189)",
		file: "package.json",
		before: '"native/macos/agent_cursor_motion.swift",',
		after: "",
		check: "check-package-assets.mjs",
		failure: /missing package\/native\/macos\/agent_cursor_motion.swift/,
	},
];

try {
	// Test sources/fixtures are intentionally NOT the npm payload: package.json `files` excludes
	// them. Keep this self-contained package-root fixture list aligned with the checks selected above.
	for (const entry of [
		"src",
		"extensions",
		"native",
		"scripts",
		"docs",
		"prebuilt",
		"assets",
		"package.json",
		"README.md",
		"UPSTREAM.md",
		"LICENSE",
	]) {
		cpSync(path.join(root, entry), path.join(sandbox, entry), {
			recursive: true,
			filter: (source) => !source.split(path.sep).includes("target"),
		});
	}
	symlinkSync(nodeModules, path.join(sandbox, "node_modules"), "dir");
	const env = { ...process.env, PI_CU_LIVE: "", PI_COMPUTER_USE_LIVE: "", HOME: sandbox };
	for (const test of cases) {
		if (test.darwinOnly && process.platform !== "darwin") {
			console.log(`NOT RUN revert proof: ${test.name} (requires macOS)`);
			continue;
		}
		const file = path.join(sandbox, test.file);
		const source = readFileSync(file, "utf8");
		assert.ok(source.includes(test.before), `Revert anchor missing for ${test.name}`);
		writeFileSync(file, source.replace(test.before, test.after));
		try {
			const result = spawnSync(
				process.execPath,
				[path.join(nodeModules, "tsx/dist/cli.mjs"), path.join(sandbox, "scripts", test.check)],
				{ cwd: sandbox, env, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
			);
			assert.ifError(result.error);
			assert.notEqual(result.status, 0, `Dropped patch survived: ${test.name}`);
			assert.match(`${result.stdout}\n${result.stderr}`, test.failure, `Wrong failure for ${test.name}`);
			console.log(`REVERT PROVEN: ${test.name} -> ${test.check}`);
		} finally {
			writeFileSync(file, source);
		}
	}
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
