#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishCheckCleanup, stopCheckChild, within } from "./check-async.mjs";

if (process.env.PI_CU_LIVE !== "1") {
	throw new Error(
		"Live Linux E2E is disabled. Set PI_CU_LIVE=1 to run it explicitly.",
	);
}
if (process.platform !== "linux")
	throw new Error("Live Linux E2E requires Linux.");

// Budget the complete desktop scenario, including startup, tool calls and inner teardown.
const LIVE_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LIVE_EXPECT_TIMEOUT_MS = 5000;
const LIVE_READINESS_TIMEOUT_MS = 15_000;
const LIVE_POLL_INTERVAL_MS = 150;

const scriptPath = fileURLToPath(import.meta.url);

if (!process.argv.includes("--inside-session")) {
	const child = spawn(
		"dbus-run-session",
		["--", process.execPath, "--import", "tsx", scriptPath, "--inside-session"],
		{
			env: {
				...process.env,
				PI_COMPUTER_USE_HEADLESS: "1",
				PI_COMPUTER_USE_BROWSER_USE: "0",
			},
			detached: true,
			stdio: "inherit",
		},
	);
	const closed = new Promise(
		/** @returns Subscribes to session stream closure. @throws No intentional errors. */
		(resolve) => child.once("close", resolve),
	);
	const exited = new Promise(
		/** @returns Registers the session exit outcome. @throws Spawn and signal failures reject the promise. */
		(resolve, reject) => {
			child.once("error", reject);
			child.once(
				"exit",
				/** @returns Settles the session outcome. @throws No errors; signal exits reject the promise. */
				(code, signal) =>
					signal
						? reject(new Error(`Live Linux E2E session exited on ${signal}.`))
						: resolve(code ?? 1),
			);
		},
	);
	let sessionFailure;
	try {
		process.exitCode = await within(
			exited,
			"live Linux E2E D-Bus session",
			LIVE_SESSION_TIMEOUT_MS,
		);
	} catch (error) {
		sessionFailure = error;
		throw error;
	} finally {
		await finishCheckCleanup(
			"live Linux E2E session",
			[
				/**
				 * A completed leader permits probes only; a running leader retains cleanup ownership.
				 * @returns {Promise<void>} Bounded observation or owned-group cancellation.
				 * @throws {Error} On quiescence or cancellation failure.
				 */
				() =>
					stopCheckChild(child, closed, "live Linux E2E D-Bus session", true),
			],
			sessionFailure,
		);
	}
} else {
	await runInsideSession();
}

/**
 * Run opt-in desktop assertions inside an isolated D-Bus session.
 * @returns {Promise<void>} Completion of live assertions and teardown.
 * @throws {Error} On missing dependencies, readiness or assertion failure.
 */
async function runInsideSession() {
	const required = [
		"/usr/bin/Xvfb",
		"/usr/bin/xfwm4",
		"/usr/bin/xfce4-appfinder",
		"/usr/bin/xfce4-terminal",
		"/usr/libexec/at-spi-bus-launcher",
	];
	for (const executable of required)
		await fs.access(executable, fsConstants.X_OK);

	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "pi-computer-use-linux-live-"),
	);
	const processes = [];
	const display = await unusedDisplay();
	const env = {
		...process.env,
		DISPLAY: display,
		NO_AT_BRIDGE: "0",
		GTK_MODULES: process.env.GTK_MODULES
			? `${process.env.GTK_MODULES}:gail:atk-bridge`
			: "gail:atk-bridge",
		PI_COMPUTER_USE_HEADLESS: "1",
		PI_COMPUTER_USE_BROWSER_USE: "0",
	};
	Object.assign(process.env, env);
	const {
		executeAct,
		executeFind,
		executeInspectUi,
		executeObserve,
		executeReadText,
		executeSearchUi,
		shutdownComputerUseSession,
	} = await import("../src/bridge.ts");
	const ctx = {
		cwd: process.cwd(),
		sessionManager: {
			/**
			 * Supply an empty transcript for the live fixture.
			 * @returns {object[]} Empty branch.
			 * @throws {never} The fixture mock cannot fail.
			 */
			getBranch: () => [],
		},
	};
	let calls = 0;
	/**
	 * Invoke a real executor with a unique fixture call ID.
	 * @param {Function} executor Tool executor under test.
	 * @param {object} params Tool request.
	 * @returns {Promise<object>} Tool response.
	 * @throws {Error} Propagates executor failures.
	 */
	const tool = async (executor, params) =>
		await executor(`linux-live-${++calls}`, params, undefined, undefined, ctx);

	try {
		processes.push(
			start(
				"/usr/bin/Xvfb",
				[display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"],
				env,
			),
		);
		await waitFor(
			() =>
				fs.access(`/tmp/.X11-unix/X${display.slice(1)}`).then(
					() => true,
					() => false,
				),
			"Xvfb socket",
		);
		processes.push(
			start(
				"/usr/libexec/at-spi-bus-launcher",
				["--launch-immediately", "--a11y=1"],
				env,
			),
		);
		processes.push(
			start("/usr/bin/xfwm4", ["--replace", "--compositor=off"], env),
		);
		// Start concurrently; the bounded accessible-root poll below observes actual session readiness.

		processes.push(
			start("/usr/bin/xfce4-appfinder", ["--disable-server"], env),
		);
		const appFinder = await waitForRoot(
			tool,
			executeFind,
			(root) =>
				/application finder/i.test(root.windowTitle) ||
				/appfinder/i.test(root.app),
		);

		const sentinelProcess = start(
			"/usr/bin/xfce4-appfinder",
			["--disable-server", "--collapsed"],
			env,
		);
		processes.push(sentinelProcess);
		const sentinel = await waitForRoot(
			tool,
			executeFind,
			(root) =>
				root.pid === sentinelProcess.pid &&
				root.windowRef !== appFinder.windowRef,
		);
		await waitFor(async () => {
			const roots = await rootsFrom(tool, executeFind);
			return (
				roots.some(
					(root) => root.windowRef === sentinel.windowRef && root.isFocused,
				) &&
				roots.some(
					(root) => root.windowRef === appFinder.windowRef && !root.isFocused,
				)
			);
		}, "sentinel focus");

		assertRoot(appFinder);
		assertRoot(sentinel);

		const semantic = await tool(executeObserve, {
			root: appFinder.windowRef,
			mode: "semantic",
		});
		let stateId = semantic.details?.capture?.stateId;
		assert(stateId, "semantic observation did not return a stateId");
		assert.equal(semantic.details?.target?.windowTitle, appFinder.windowTitle);
		assert.equal(semantic.details?.helper?.accessibility, true);
		assert.equal(semantic.details?.helper?.protocolVersion, 4);
		assert(
			countOutlineNodes(semantic.details?.outline?.root) > 1,
			"semantic observation returned no accessible descendants",
		);

		const visual = await tool(executeObserve, {
			root: appFinder.windowRef,
			mode: "visual",
		});
		stateId = visual.details?.capture?.stateId;
		assert(stateId, "visual observation did not return a stateId");
		assert(
			visual.content.some((item) => item.type === "image"),
			"X11 visual observation returned no image",
		);
		assert(
			(visual.details?.capture?.width ?? 0) > 0 &&
				(visual.details?.capture?.height ?? 0) > 0,
			"X11 visual capture dimensions were empty",
		);
		await assertFocusPreserved(
			tool,
			executeFind,
			appFinder.windowRef,
			sentinel.windowRef,
		);
		console.log(
			`PASS discovery and background semantic/visual observation (${appFinder.windowRef}, sentinel ${sentinel.windowRef})`,
		);

		const editableSearch = await tool(executeSearchUi, {
			stateId,
			capability: "setValue",
		});
		const editable = editableSearch.details?.matches?.find(
			(match) => match.ref,
		);
		assert(editable?.ref, "Application Finder exposed no editable AT-SPI ref");
		const inspected = await tool(executeInspectUi, {
			stateId,
			ref: editable.ref,
		});
		assert.equal(
			inspected.details?.target?.canSetValue,
			true,
			"editable ref lost canSetValue",
		);

		const beforeText = await tool(executeReadText, {
			stateId,
			ref: editable.ref,
		});
		assert.equal(typeof beforeText.details?.text, "string");
		const token = `Terminal ${Date.now()}`;
		const typed = await tool(executeAct, {
			stateId,
			actions: [{ action: "typeText", ref: editable.ref, text: token }],
			expect: {
				ref: editable.ref,
				value: token,
				timeoutMs: LIVE_EXPECT_TIMEOUT_MS,
			},
		});
		stateId = typed.details?.capture?.stateId;
		assert(stateId, "background typing did not return a successor state");
		assert.equal(typed.details?.execution?.outcome, "worked");
		assertAxOnly(typed.details?.execution);
		const afterText = await tool(executeReadText, {
			stateId,
			ref: editable.ref,
		});
		assert.equal(afterText.details?.text, token);
		await assertFocusPreserved(
			tool,
			executeFind,
			appFinder.windowRef,
			sentinel.windowRef,
		);
		console.log(
			`PASS unique-token background type/readback (${stateId}, ax_only/ax, focus preserved)`,
		);

		const exactTerminal = await tool(executeAct, {
			stateId,
			actions: [{ action: "typeText", ref: editable.ref, text: "Terminal" }],
			expect: {
				ref: editable.ref,
				value: "Terminal",
				timeoutMs: LIVE_EXPECT_TIMEOUT_MS,
			},
		});
		stateId = exactTerminal.details?.capture?.stateId;
		assert(stateId, "exact Terminal typing did not return a successor state");
		assertAxOnly(exactTerminal.details?.execution);
		const exactText = await tool(executeReadText, {
			stateId,
			ref: editable.ref,
		});
		assert.equal(exactText.details?.text, "Terminal");
		await assertFocusPreserved(
			tool,
			executeFind,
			appFinder.windowRef,
			sentinel.windowRef,
		);
		console.log(
			`PASS exact Terminal background type/readback (${stateId}, ax_only/ax, focus preserved)`,
		);

		const terminalSearch = await tool(executeSearchUi, {
			stateId,
			text: "Terminal",
			capability: "press",
		});
		debug("Terminal result matches", terminalSearch.details?.matches);
		const terminalResult = terminalSearch.details?.matches?.find(
			(match) =>
				match.ref &&
				match.role.toLowerCase() === "table cell" &&
				/^xfce terminal(?:\n|$)/i.test(match.label ?? ""),
		);
		assert(
			terminalResult?.ref,
			"Application Finder exposed no actionable Terminal result row",
		);
		const terminalInspection = await tool(executeInspectUi, {
			stateId,
			ref: terminalResult.ref,
		});
		debug("Terminal result inspection", terminalInspection.details?.target);
		assert.equal(
			terminalInspection.details?.target?.canPress,
			true,
			"Terminal result row lost canPress",
		);

		const selected = await tool(executeAct, {
			stateId,
			actions: [{ action: "press", ref: terminalResult.ref }],
		});
		debug("Terminal result execution", selected.details?.execution);
		assertAxOnly(selected.details?.execution);
		stateId = selected.details?.capture?.stateId;
		assert(
			stateId,
			"Terminal result activation did not return a successor state",
		);
		await assertFocusPreserved(
			tool,
			executeFind,
			appFinder.windowRef,
			sentinel.windowRef,
		);
		console.log(
			`PASS activated real Terminal result row ${terminalResult.ref} via ax_only/ax with focus preserved`,
		);
		process.env.PI_COMPUTER_USE_HEADLESS = "0";
		const foregroundLook = await tool(executeObserve, {
			root: appFinder.windowRef,
			mode: "visual",
		});
		stateId = foregroundLook.details?.capture?.stateId;
		assert(
			stateId,
			"foreground selection observation did not return a stateId",
		);
		const foregroundSearch = await tool(executeSearchUi, {
			stateId,
			text: "Terminal",
			capability: "press",
		});
		const foregroundResult = foregroundSearch.details?.matches?.find(
			(match) =>
				match.ref &&
				match.role.toLowerCase() === "table cell" &&
				/^xfce terminal(?:\n|$)/i.test(match.label ?? ""),
		);
		assert(
			foregroundResult?.ref,
			"Fresh visual state exposed no Xfce Terminal result row",
		);
		const foregroundInspection = await tool(executeInspectUi, {
			stateId,
			ref: foregroundResult.ref,
		});
		const rowRect = foregroundInspection.details?.target?.rect;
		assert(
			rowRect?.w > 0 && rowRect?.h > 0,
			"Xfce Terminal row had no grounded click rectangle",
		);
		const foregroundSelected = await tool(executeAct, {
			stateId,
			actions: [
				{
					action: "click",
					x: rowRect.x + rowRect.w / 2,
					y: rowRect.y + rowRect.h / 2,
				},
			],
		});
		debug("foreground row selection", foregroundSelected.details?.execution);
		assertForegroundX11(foregroundSelected.details?.execution);
		stateId = foregroundSelected.details?.capture?.stateId;
		assert(
			stateId,
			"foreground row selection did not return a successor state",
		);
		const rootsAfterSelection = await rootsFrom(tool, executeFind);
		assert.equal(
			rootsAfterSelection.find((root) => root.windowRef === appFinder.windowRef)
				?.isFocused,
			true,
			"foreground row click did not focus Application Finder",
		);
		assert.equal(
			rootsAfterSelection.find((root) => root.windowRef === sentinel.windowRef)
				?.isFocused,
			false,
			"sentinel retained focus after foreground row click",
		);
		console.log(
			`PASS grounded foreground X11 row selection (${foregroundResult.ref}, hid, outcome ${foregroundSelected.details?.execution?.outcome})`,
		);
		process.env.PI_COMPUTER_USE_HEADLESS = "1";

		const launchSearch = await tool(executeSearchUi, {
			stateId,
			text: "Launch",
			capability: "press",
		});
		debug("Launch matches", launchSearch.details?.matches);
		const launchButton = launchSearch.details?.matches?.find(
			(match) =>
				match.ref &&
				match.role.toLowerCase() === "push button" &&
				match.label === "Launch",
		);
		assert(
			launchButton?.ref,
			"Selected Terminal state exposed no exact actionable Launch button",
		);
		const launchInspection = await tool(executeInspectUi, {
			stateId,
			ref: launchButton.ref,
		});
		debug("Launch inspection", launchInspection.details?.target);
		assert.equal(
			launchInspection.details?.target?.canPress,
			true,
			"Launch button lost canPress",
		);

		const rootsBefore = await rootsFrom(tool, executeFind);
		const identities = new Set(rootsBefore.map(rootIdentity));
		const launchStateId = stateId;
		const launched = await tool(executeAct, {
			stateId: launchStateId,
			actions: [{ action: "press", ref: launchButton.ref }],
		});
		debug("Launch execution", launched.details?.execution);
		assertAxOnly(launched.details?.execution);
		assert.equal(
			launched.details?.status,
			"target_closed",
			"root-closing Launch action did not return target_closed",
		);
		assert.equal(launched.details?.baseStateId, launchStateId);
		assert.equal(
			launched.details?.capture,
			undefined,
			"target_closed action fabricated a successor capture",
		);
		assert.equal(
			launched.details?.outline,
			undefined,
			"target_closed action fabricated a successor outline",
		);
		const closedDelta = (launched.details?.execution?.rootDelta ?? []).find(
			(delta) => delta.change === "closed",
		);
		assert.deepEqual(
			{
				ref: closedDelta?.ref,
				pid: closedDelta?.pid,
				title: closedDelta?.title,
			},
			{
				ref: appFinder.windowRef,
				pid: appFinder.pid,
				title: appFinder.windowTitle,
			},
			"target_closed delta did not identify the exact public source root",
		);
		await assert.rejects(
			tool(executeAct, {
				stateId: launchStateId,
				actions: [{ action: "press", ref: launchButton.ref }],
			}),
			/The current controlled window is no longer available/,
		);
		// Observe the new Terminal root directly rather than guessing how long launch takes.
		debug("roots after launch", await rootsFrom(tool, executeFind));
		const newTerminal = await waitFor(async () => {
			const roots = await rootsFrom(tool, executeFind);
			return roots.find(
				(root) =>
					!identities.has(rootIdentity(root)) &&
					/terminal/i.test(`${root.app} ${root.windowTitle}`),
			);
		}, "Application Finder to launch Terminal");
		assertRoot(newTerminal);
		await waitFor(async () => {
			const roots = await rootsFrom(tool, executeFind);
			return roots.find(
				(root) => rootIdentity(root) === rootIdentity(newTerminal),
			)?.isFocused;
		}, "launched Terminal focus");
		const rootsAfterLaunch = await rootsFrom(tool, executeFind);
		assert.equal(
			rootsAfterLaunch.find(
				(root) => rootIdentity(root) === rootIdentity(newTerminal),
			)?.isFocused,
			true,
			"launched Terminal did not receive application-driven focus",
		);
		assert.equal(
			rootsAfterLaunch.find((root) => root.windowRef === sentinel.windowRef)
				?.isFocused,
			false,
			"sentinel unexpectedly retained focus after Terminal launch",
		);
		assert.equal(
			rootsAfterLaunch.some((root) => root.windowRef === appFinder.windowRef),
			false,
			"closed Application Finder root remained discoverable after Terminal launch",
		);
		console.log(
			`PASS pressed ${launchButton.ref} via ax_only/ax and observed a new focused Terminal root ${newTerminal.windowRef}`,
		);

		console.log(
			"PASS live Linux X11 discovery, semantic/visual observation, background typing, and focus preservation",
		);
	} finally {
		await shutdownComputerUseSession().catch(() => {});
		for (const child of processes.reverse()) stop(child);
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Start an owned live fixture in the outer D-Bus session's cleanup group.
 * @param {string} command Verified executable.
 * @param {string[]} args Executable arguments.
 * @param {NodeJS.ProcessEnv} env Isolated desktop environment.
 * @returns {import('node:child_process').ChildProcess} Spawned fixture.
 * @throws {Error} On invalid spawn arguments; asynchronous errors surface on the child.
 */
function start(command, args, env) {
	const child = spawn(command, args, {
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		if (process.env.PI_CU_LIVE_DEBUG === "1") process.stderr.write(chunk);
	});
	return child;
}

/**
 * Best-effort TERM of a fixture; the outer session enforces group teardown.
 * @param {import('node:child_process').ChildProcess} child Owned leader.
 * @returns {void} Completion of the signal attempt.
 * @throws {never} Already-gone/unavailable groups are ignored during teardown.
 */
function stop(child) {
	if (child.exitCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {}
}

/**
 * Find an unused display in the reserved X11 range.
 * @returns {Promise<string>} Available display name.
 * @throws {Error} If every reserved display is occupied.
 */
async function unusedDisplay() {
	for (let number = 90; number < 120; number += 1) {
		try {
			await fs.access(`/tmp/.X11-unix/X${number}`);
		} catch {
			return `:${number}`;
		}
	}
	throw new Error("No unused X11 display was available in :90..:119.");
}

/**
 * Discover roots through the real find tool.
 * @param {Function} tool Invocation adapter.
 * @param {Function} executeFind Discovery executor.
 * @returns {Promise<object[]>} Current roots, empty when omitted.
 * @throws {Error} Propagates discovery failures.
 */
async function rootsFrom(tool, executeFind) {
	return (await tool(executeFind, {})).details?.windows ?? [];
}

/**
 * Await a discoverable root satisfying the fixture predicate.
 * @param {Function} tool Invocation adapter.
 * @param {Function} executeFind Discovery executor.
 * @param {Function} predicate Root acceptance predicate.
 * @returns {Promise<object>} Matching root.
 * @throws {Error} If readiness expires.
 */
async function waitForRoot(tool, executeFind, predicate) {
	return await waitFor(
		async () => (await rootsFrom(tool, executeFind)).find(predicate),
		"accessible root",
	);
}

/**
 * Poll actual state, retaining the last probe error for diagnostics.
 * @param {Function} check Asynchronous truthy-readiness predicate.
 * @param {string} label Readiness context.
 * @param {number} [timeoutMs=LIVE_READINESS_TIMEOUT_MS] Maximum wait.
 * @returns {Promise<unknown>} First truthy result.
 * @throws {Error} If readiness never becomes observable.
 */
async function waitFor(check, label, timeoutMs = LIVE_READINESS_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await delay(LIVE_POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ""}`,
	);
}

/**
 * Verify the target stayed unfocused and sentinel focused.
 * @param {Function} tool Invocation adapter.
 * @param {Function} executeFind Discovery executor.
 * @param {string} targetRef Background target.
 * @param {string} sentinelRef Foreground sentinel.
 * @returns {Promise<void>} Successful validation.
 * @throws {Error} On discovery or focus assertion failure.
 */
async function assertFocusPreserved(tool, executeFind, targetRef, sentinelRef) {
	const roots = await rootsFrom(tool, executeFind);
	assert.equal(
		roots.find((root) => root.windowRef === targetRef)?.isFocused,
		false,
		"background target unexpectedly gained focus",
	);
	assert.equal(
		roots.find((root) => root.windowRef === sentinelRef)?.isFocused,
		true,
		"sentinel lost focus during background operation",
	);
}

/**
 * Validate public root identity and geometry.
 * @param {object} root Discovered root.
 * @returns {void} Successful validation.
 * @throws {Error} If identity or geometry is incomplete.
 */
function assertRoot(root) {
	assert(
		root?.windowRef?.startsWith("@r"),
		"root did not have a public @r ref",
	);
	assert(Number.isFinite(root.pid) && root.pid > 0, "root did not have a PID");
	assert(
		root.framePoints?.w > 0 && root.framePoints?.h > 0,
		"root did not have positive geometry",
	);
}

/**
 * Require successful accessibility-only delivery.
 * @param {object} execution Tool execution details.
 * @returns {void} Successful validation.
 * @throws {Error} On delivery, policy or foreground assertion failure.
 */
function assertAxOnly(execution) {
	assert.equal(execution?.outcome, "worked");
	const step = execution?.steps?.[0] ?? execution;
	assert.equal(step?.deliveryPolicy, "ax_only");
	assert.equal(step?.performed?.delivery, "ax");
	assert.notEqual(execution?.escalatedToForeground, true);
}

/**
 * Require guarded foreground X11 delivery.
 * @param {object} execution Tool execution details.
 * @returns {void} Successful validation.
 * @throws {Error} On policy, delivery or grounding failure.
 */
function assertForegroundX11(execution) {
	assert(
		["unknown", "worked"].includes(execution?.outcome),
		`unexpected foreground outcome ${execution?.outcome}`,
	);
	const step = execution?.steps?.[0] ?? execution;
	assert.equal(step?.deliveryPolicy, "foreground");
	assert.equal(step?.performed?.delivery, "hid");
	assert.equal(step?.performed?.grounding, "coordinates");
}

/**
 * Build the identity used to distinguish newly launched roots.
 * @param {object} root Discovered root.
 * @returns {string} Process/window identity.
 * @throws {TypeError} If the root is missing.
 */
function rootIdentity(root) {
	return `${root.pid}:${root.windowId ?? root.nativeWindowRef ?? root.windowTitle}`;
}

/**
 * Count an accessible-outline fixture tree.
 * @param {object|undefined} node Optional outline root.
 * @returns {number} Node count, zero for a missing root.
 * @throws {RangeError} On cyclic or excessively deep input.
 */
function countOutlineNodes(node) {
	if (!node) return 0;
	return (
		1 +
		(node.children ?? []).reduce(
			(sum, child) => sum + countOutlineNodes(child),
			0,
		)
	);
}

/**
 * Yield between state probes, never as proof of readiness.
 * @param {number} ms Named polling interval.
 * @returns {Promise<void>} Resolution after the interval.
 * @throws {never} Valid fixture intervals do not reject.
 */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Emit optional fixture diagnostics.
 * @param {string} label Diagnostic context.
 * @param {unknown} value JSON-serializable value.
 * @returns {void} Completion of optional logging.
 * @throws {TypeError} If enabled diagnostics are unserializable.
 */
function debug(label, value) {
	if (process.env.PI_CU_LIVE_DEBUG === "1")
		console.error(`[linux-live] ${label}: ${JSON.stringify(value)}`);
}
