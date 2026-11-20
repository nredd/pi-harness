import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { onTestFinished, test } from "vitest";
import { showPlanLaunchMenu } from "../src/plan-launch-menu.ts";
import { showPlanModeSettings } from "../src/settings-menu.ts";
import { createPlanContext } from "./fixtures/support.ts";

test("launch Settings refreshes an untouched selection but preserves an edited draft", async () => {
	for (const edited of [false, true]) {
		let selected = new Set(["read"]);
		let settingsCalls = 0;
		let started: string[] | undefined;
		const rpc = createRpcHarness([
			...(edited
				? [
						{ kind: "select" as const, response: "Choose tools, then start…" },
						{ kind: "select" as const, response: "[x] read" },
						{ kind: "select" as const, response: "Back" },
					]
				: []),
			{ kind: "select", response: "Settings" },
			{ kind: "select", response: "Choose tools, then start…" },
			{ kind: "select", response: "Done — start with this policy" },
		]);
		const context = createPlanContext({ hasUI: true, mode: "rpc", ...rpc.ui });
		await showPlanLaunchMenu(context.ctx, {
			statusText: "off",
			toolSummary: (names) => [...names].join(","),
			getSelectedNames: () => selected,
			tools: [{ name: "read", description: "Read", searchText: "read", disabled: false }],
			signal: new AbortController().signal,
			isCurrent: () => true,
			start: () => assert.fail("must start with the reviewed policy"),
			startWithTools: (names) => {
				started = names;
			},
			settings: async () => {
				settingsCalls++;
				selected = new Set(["find"]);
				return false;
			},
		});
		rpc.assertConsumed();
		assert.equal(settingsCalls, 1);
		assert.deepEqual(started, edited ? [] : ["find"]);
	}
});

test("launch Settings can close its parent menu without starting Plan mode", async () => {
	const rpc = createRpcHarness([{ kind: "select", response: "Settings" }]);
	const context = createPlanContext({ hasUI: true, mode: "rpc", ...rpc.ui });
	let settingsCalls = 0;
	await showPlanLaunchMenu(context.ctx, {
		statusText: "off",
		toolSummary: () => "read",
		getSelectedNames: () => new Set(),
		tools: [],
		signal: new AbortController().signal,
		isCurrent: () => true,
		start: () => assert.fail("unexpected start"),
		startWithTools: () => assert.fail("unexpected start"),
		settings: async () => {
			settingsCalls++;
			return true;
		},
	});
	rpc.assertConsumed();
	assert.equal(settingsCalls, 1);
});

test("settings resets fresh thinking to same as plan and rejects an invalid pasted shortcut", async () => {
	const directory = makeTestTempDir("pm-settings-input-", onTestFinished);
	const settingsPath = join(directory, "settings.json");
	await writeFile(settingsPath, JSON.stringify({ defaultImplementationThinkingLevel: "max" }));
	const rpc = createRpcHarness([
		{ kind: "select", response: "Fresh thinking (max)" },
		{ kind: "select", response: "Plan mode shortcut (none)" },
		{ kind: "input", response: "ctrl+ctrl+p" },
		{ kind: "input", response: undefined },
		{ kind: "select", response: undefined },
	]);
	const context = createPlanContext({ hasUI: true, mode: "rpc", ...rpc.ui });
	let saves = 0;
	await showPlanModeSettings(context.ctx, {
		settingsPath,
		tools: [],
		signal: new AbortController().signal,
		isCurrent: () => true,
		onSaved: () => {
			saves++;
		},
	});
	rpc.assertConsumed();
	assert.equal(saves, 1);
	assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {});
	assert.ok(context.notifications.some((notice) => /Invalid key identifier/.test(notice.message)));
});
