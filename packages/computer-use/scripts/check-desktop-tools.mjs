#!/usr/bin/env node
// Whole-desktop tools: input validation and helper wire mapping (no real input is posted).
import assert from "node:assert/strict";

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { executeDesktopInput, validateDesktopInput } = await import("../src/desktop.ts");

for (const bad of [
	{ action: "click", x: Number.NaN, y: 1 },
	{ action: "click", x: 1, y: 1, clickCount: 4 },
	{ action: "scroll", x: 1, y: 1 },
	{ action: "drag", path: [{ x: 1, y: 1 }] },
	{ action: "typeText", text: "" },
	{ action: "keypress", keys: [] },
	{ action: "activateApp" },
	{ action: "activateApp", app: "  " },
	{ action: "writeClipboard", text: "" },
	{ action: "writeClipboard" },
	{ action: "bogus" },
]) assert.throws(() => validateDesktopInput(bad), undefined, JSON.stringify(bad));
for (const good of [
	{ action: "moveMouse", x: -500, y: 20 },
	{ action: "click", x: 1, y: 2, button: "right", clickCount: 2 },
	{ action: "scroll", x: 1, y: 1, scrollY: -3 },
	{ action: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
	{ action: "typeText", text: "hi" },
	{ action: "keypress", keys: ["cmd+space"] },
	{ action: "activateApp", app: "com.apple.TextEdit" },
	{ action: "readClipboard" },
	{ action: "writeClipboard", text: "x" },
]) assert.doesNotThrow(() => validateDesktopInput(good));

const sent = [];
macosHelper.command = async (name, args) => {
	sent.push({ name, args });
	return { performed: args.action, mouse: { x: 0, y: 0 } };
};
await executeDesktopInput("1", { action: "typeText", text: "x" });
await executeDesktopInput("2", { action: "keypress", keys: ["return"] });
await executeDesktopInput("3", { action: "click", x: 3, y: 4 });
assert.deepEqual(sent.map((c) => [c.name, c.args.action]), [["desktopInput", "type"], ["desktopInput", "key"], ["desktopInput", "click"]]);
await assert.rejects(executeDesktopInput("4", { action: "click", x: Number.NaN, y: 0 }));
assert.equal(sent.length, 3, "invalid input must not reach the helper");

// New actions pass through unchanged and render model-facing text.
macosHelper.command = async (name, args) => {
	sent.push({ name, args });
	if (args.action === "activateApp") return { performed: "activateApp", pid: 42, appName: "TextEdit", frontmost: true };
	if (args.action === "readClipboard") return { performed: "readClipboard", text: "clip", truncated: true, length: 100_001 };
	return { performed: args.action, length: args.text.length };
};
const activated = await executeDesktopInput("a", { action: "activateApp", app: "TextEdit" });
assert.deepEqual(sent.at(-1).args, { action: "activateApp", app: "TextEdit" });
assert.match(activated.content[0].text, /TextEdit \(pid 42\) is now the frontmost app/);
assert.equal(activated.details.pid, 42);
const read = await executeDesktopInput("r", { action: "readClipboard" });
assert.match(read.content[0].text, /100001 chars, truncated/);
assert.match(read.content[0].text, /<clipboard>\nclip\n<\/clipboard>$/);
assert.equal(read.details.truncated, true);
assert.match((await executeDesktopInput("w", { action: "writeClipboard", text: "abc" })).content[0].text, /Clipboard set \(3 chars\)/);
macosHelper.command = async () => { throw Object.assign(new Error("No running or installed app named 'Nope'"), { code: "app_not_found" }); };
await assert.rejects(executeDesktopInput("n", { action: "activateApp", app: "Nope" }), /Nope/);
macosHelper.command = async (name, args) => {
	sent.push({ name, args });
	return { performed: args.action, mouse: { x: 0, y: 0 } };
};
// Gating: disabled and headless both refuse before any helper call.
const { loadComputerUseConfig } = await import("../src/config.ts");
const before = sent.length;
process.env.PI_COMPUTER_USE_DESKTOP_CONTROL = "0";
loadComputerUseConfig(process.cwd());
await assert.rejects(executeDesktopInput("5", { action: "click", x: 1, y: 1 }), /disabled/);
delete process.env.PI_COMPUTER_USE_DESKTOP_CONTROL;
process.env.PI_COMPUTER_USE_HEADLESS = "1";
loadComputerUseConfig(process.cwd());
await assert.rejects(executeDesktopInput("6", { action: "click", x: 1, y: 1 }), /headless/);
delete process.env.PI_COMPUTER_USE_HEADLESS;
loadComputerUseConfig(process.cwd());
assert.equal(sent.length, before, "gated calls must not reach the helper");
assert.throws(() => validateDesktopInput({ action: "scroll", x: 1, y: 1, scrollY: 0.5 }), /whole-number/);

// Calls are serialized.
const { withDesktopLock } = await import("../src/desktop.ts");
const order = [];
await Promise.all([
	withDesktopLock(async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 30)); order.push("a2"); }),
	withDesktopLock(async () => { order.push("b1"); order.push("b2"); }),
]);
assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);

// An aborted, still-queued call never runs.
const controller = new AbortController();
const ran = [];
const slow = withDesktopLock(async () => { await new Promise((r) => setTimeout(r, 30)); ran.push("slow"); });
const queued = withDesktopLock(async () => { ran.push("queued"); }, controller.signal);
controller.abort();
await slow;
await assert.rejects(queued, /aborted/);
assert.deepEqual(ran, ["slow"]);

console.log("desktop tool checks passed");
