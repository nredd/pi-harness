import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	cdpClickForContext,
	cdpDragForContext,
	cdpEvaluateForContext,
	cdpKeypressForContext,
	cdpMouseForContext,
	cdpNavigateContext,
	cdpScrollForContext,
	cdpSnapshotForContext,
	cdpTabForWindow,
	cdpTypeFocusedForContext,
	cdpTypeForContext,
	disconnectCdp,
	listCdpPageContexts,
} from "../src/cdp.ts";
import { CLOSE, DISCONNECT, MALFORMED, NO_REPLY, cdpError, startFakeCdp } from "./fixtures/fake-cdp.mjs";

const realSetTimeout = globalThis.setTimeout;
const fakes = [];

/**
 * Start a tracked fake endpoint and point the client at it.
 * @param {object} [options] `startFakeCdp` options.
 * @returns {Promise<import('./fixtures/fake-cdp.mjs').FakeCdp>} The endpoint.
 * @throws {Error} If the endpoint cannot bind.
 */
async function fakeBrowser(options) {
	const fake = await startFakeCdp(options);
	fakes.push(fake);
	vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", String(fake.port));
	return fake;
}

/**
 * Connect to the fake's default tab.
 * @param {string} [title="Fake"] Window title to match.
 * @returns {Promise<import('../src/cdp.ts').CdpTab>} Connected tab.
 * @throws {assert.AssertionError} If no tab connects.
 */
async function connectedTab(title = "Fake") {
	const tab = await cdpTabForWindow(title);
	assert(tab, "tab did not connect");
	return tab;
}

/**
 * Round-trip a command so every earlier server message has been processed.
 * @param {import('../src/cdp.ts').CdpTab} tab Connected tab.
 * @returns {Promise<void>} Settles after the reply.
 * @throws {Error} If the command fails.
 */
async function flush(tab) {
	await tab.evaluate("1");
}

/**
 * @param {import('./fixtures/fake-cdp.mjs').FakeCdp} fake Endpoint.
 * @param {string} method CDP method.
 * @returns {object[]} Params of every `method` command, oldest first.
 * @throws {never} Pure filter.
 */
const paramsOf = (fake, method) => fake.commands.filter((command) => command.method === method).map((command) => command.params);

/**
 * Script the node/window commands every backend-node action needs.
 * @param {import('./fixtures/fake-cdp.mjs').FakeCdp} fake Endpoint.
 * @returns {void}
 * @throws {never} Registration only.
 */
function resolvableNodes(fake) {
	fake.handle("DOM.resolveNode", (params) => ({ object: { objectId: `object-${params.backendNodeId}` } }));
}

beforeEach(() => {
	// Shrink the 5 s command and 10 s load budgets so timeout paths run in tens of milliseconds.
	vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
		realSetTimeout(callback, delay === 5_000 || delay === 10_000 ? 40 : delay, ...args),
	);
});

afterEach(async () => {
	disconnectCdp();
	await Promise.all(fakes.splice(0).map((fake) => fake.close()));
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("CDP enablement", () => {
	test.each([["unset", undefined], ["empty", ""], ["not numeric", "9222x"], ["zero", "0"], ["out of range", "70000"]])("port %s keeps CDP inert", async (_name, value) => {
		const fake = await fakeBrowser();
		vi.stubEnv("PI_COMPUTER_USE_CDP_PORT", value);
		assert.equal(await cdpTabForWindow("Fake"), undefined);
		assert.deepEqual(await listCdpPageContexts(), []);
		assert.equal(fake.listRequests, 0);
	});

	test("a runtime without WebSocket keeps CDP inert", async () => {
		const fake = await fakeBrowser();
		vi.stubGlobal("WebSocket", undefined);
		assert.equal(await cdpTabForWindow("Fake"), undefined);
		assert.equal(fake.listRequests, 0);
	});
});

describe("target discovery", () => {
	test("lists only local page targets that expose a debugger socket", async () => {
		const fake = await fakeBrowser();
		const own = `ws://127.0.0.1:${fake.port}/devtools/page/`;
		fake.discoveryBody(
			JSON.stringify([
				{ id: "ok", type: "page", title: "Ok", url: "https://example.test/", webSocketDebuggerUrl: `${own}ok` },
				{ id: "no-url", type: "page", title: "No url", webSocketDebuggerUrl: `${own}no-url` },
				{ id: "worker", type: "service_worker", title: "Worker", webSocketDebuggerUrl: `${own}worker` },
				{ id: "no-socket", type: "page", title: "Detached" },
				{ id: "foreign-port", type: "page", title: "Foreign", webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port + 1}/devtools/page/x` },
				{ id: "foreign-host", type: "page", title: "Remote", webSocketDebuggerUrl: `ws://example.test:${fake.port}/devtools/page/x` },
				{ id: "http", type: "page", title: "Http", webSocketDebuggerUrl: `http://127.0.0.1:${fake.port}/devtools/page/x` },
				{ id: "garbage", type: "page", title: "Garbage", webSocketDebuggerUrl: "not a url" },
				{ id: "ipv6", type: "page", title: "Loopback v6", url: "about:blank", webSocketDebuggerUrl: `ws://[::1]:${fake.port}/devtools/page/ipv6` },
			]),
		);
		assert.deepEqual(await listCdpPageContexts(), [
			{ contextId: "browser:ok", targetId: "ok", title: "Ok", url: "https://example.test/" },
			{ contextId: "browser:no-url", targetId: "no-url", title: "No url", url: "" },
			{ contextId: "browser:ipv6", targetId: "ipv6", title: "Loopback v6", url: "about:blank" },
		]);
	});

	test("follows target list changes between calls", async () => {
		const fake = await fakeBrowser({ id: "a", title: "A" });
		assert.deepEqual((await listCdpPageContexts()).map((page) => page.targetId), ["a"]);
		fake.setTargets([{ id: "b", title: "B" }, { id: "c", title: "C" }]);
		assert.deepEqual((await listCdpPageContexts()).map((page) => page.targetId), ["b", "c"]);
		fake.setTargets([]);
		assert.deepEqual(await listCdpPageContexts(), []);
	});

	test("a non-JSON discovery body rejects the listing", async () => {
		const fake = await fakeBrowser();
		fake.discoveryBody("<html>not json</html>");
		await assert.rejects(listCdpPageContexts(), SyntaxError);
	});
});

describe("connection lifecycle", () => {
	test("an upgrade the browser refuses fails the connect", async () => {
		const fake = await fakeBrowser();
		fake.rejectUpgrade(403);
		await assert.rejects(cdpEvaluateForContext("browser:fake", "1"), /Failed to connect to CDP target/);
	});

	test("an upgrade that never answers times out", async () => {
		const fake = await fakeBrowser();
		fake.hangUpgrade(true);
		await assert.rejects(cdpEvaluateForContext("browser:fake", "1"), /Timed out connecting to CDP target/);
	});

	test.each([["with a message", cdpError("Runtime is gone"), /CDP error: Runtime is gone/], ["without one", { __rawError: true }, /CDP error: unknown/]])("an `error` reply to the enable handshake %s aborts and closes the socket", async (_name, reply, expected) => {
		const fake = await fakeBrowser();
		fake.handle("Runtime.enable", (_params, ctx) => {
			if (reply.__rawError) {
				ctx.connection.send({ id: ctx.request.id, error: {} });
				return NO_REPLY;
			}
			return reply;
		});
		await assert.rejects(cdpEvaluateForContext("browser:fake", "1"), expected);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("a command that gets no reply times out and its late reply is ignored", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => NO_REPLY);
		await assert.rejects(tab.evaluate("1"), /CDP command 'Runtime\.evaluate' timed out after 5000ms\./);
		const stalled = fake.connections[0].requests.findLast((request) => request.method === "Runtime.evaluate");
		fake.connections[0].send({ id: stalled.id, result: { result: { value: "late" } } });
		fake.handle("Runtime.evaluate", () => ({ result: { value: 2 } }));
		assert.equal(await tab.evaluate("2"), 2);
	});

	test("protocol `error` replies reject only their own command", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", (params) => (params.expression === "boom" ? cdpError("Cannot evaluate", -32601) : { result: { value: "fine" } }));
		const [bad, good] = await Promise.allSettled([tab.evaluate("boom"), tab.evaluate("ok")]);
		assert.equal(bad.status, "rejected");
		assert.match(bad.reason.message, /CDP error: Cannot evaluate/);
		assert.deepEqual(good, { status: "fulfilled", value: "fine" });
	});

	test("a throwing handler surfaces as a protocol error", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => {
			throw new Error("handler blew up");
		});
		await assert.rejects(tab.evaluate("1"), /CDP error: handler blew up/);
	});

	test("malformed frames and unknown events are ignored", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		const connection = fake.connections[0];
		connection.sendRaw("{not json");
		connection.emit("Some.unknownEvent", { anything: true });
		connection.send({ id: 987_654, result: {} });
		fake.handle("Runtime.evaluate", (_params, ctx) => {
			ctx.connection.sendRaw("]]");
			return { result: { value: "still alive" } };
		});
		assert.equal(await tab.evaluate("1"), "still alive");
		assert.deepEqual(tab.drainConsole(), []);
	});

	test("a reply that is not JSON never settles the command", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => MALFORMED);
		await assert.rejects(tab.evaluate("1"), /timed out/);
		assert.equal(tab.isOpen, true);
	});

	test("a clean server close rejects pending commands and flips `isOpen`", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => CLOSE);
		await assert.rejects(tab.evaluate("1"), /CDP connection closed\./);
		await vi.waitFor(() => assert.equal(tab.isOpen, false));
	});

	test("a dropped TCP connection rejects pending commands", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => DISCONNECT);
		await assert.rejects(tab.evaluate("1"), /CDP connection (closed|error)\./);
		await vi.waitFor(() => assert.equal(tab.isOpen, false));
	});

	test("a protocol violation from the browser surfaces as a connection error", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", (_params, ctx) => {
			// Invalid UTF-8 in a text frame fails the WebSocket connection (RFC 6455 section 8.1).
			ctx.connection.sendFrame(1, Buffer.from([0xff, 0xfe]));
			return NO_REPLY;
		});
		await assert.rejects(tab.evaluate("1"), /CDP connection (closed|error)\./);
	});

	test("`close` rejects pending commands and is idempotent", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Runtime.evaluate", () => NO_REPLY);
		const pending = tab.evaluate("1");
		await fake.connections[0].waitForRequest("Runtime.evaluate");
		tab.close();
		await assert.rejects(pending, /CDP connection closed\./);
		tab.close();
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("a command the client cannot serialize rejects instead of hanging", async () => {
		await fakeBrowser();
		await connectedTab();
		await assert.rejects(cdpMouseForContext("browser:fake", 1n, 2, "mousePressed"), TypeError);
	});

	test("the server answers client pings and echoes the close handshake", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.connections[0].sendFrame(9, "hi");
		await flush(tab);
		tab.close();
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
		assert(fake.connections[0].received.some((frame) => frame.opcode === 8));
	});
});

describe("events", () => {
	test("console output and exceptions are buffered and drained", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		const connection = fake.connections[0];
		connection.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ value: 7 }, { description: "Error: shaped" }, {}, null] });
		connection.emit("Runtime.consoleAPICalled", { args: [{ value: "defaults to log" }] });
		connection.emit("Runtime.consoleAPICalled", { type: "log" });
		connection.emit("Runtime.consoleAPICalled", { type: "log", args: [{}] });
		connection.emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: x" }, text: "ignored" } });
		connection.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught" } });
		connection.emit("Runtime.exceptionThrown", {});
		await flush(tab);
		assert.deepEqual(tab.drainConsole(), [
			{ level: "warning", text: "7 Error: shaped" },
			{ level: "log", text: "defaults to log" },
			{ level: "exception", text: "TypeError: x" },
			{ level: "exception", text: "Uncaught" },
			{ level: "exception", text: "Uncaught exception" },
		]);
		assert.deepEqual(tab.drainConsole(), []);
	});

	test("the console buffer keeps only the newest 20 entries", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		for (let index = 0; index < 25; index += 1) fake.connections[0].emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: `m${index}` }] });
		await flush(tab);
		const entries = tab.drainConsole();
		assert.equal(entries.length, 20);
		assert.equal(entries[0].text, "m5");
		assert.equal(entries.at(-1).text, "m24");
	});

	test("a load event outside a navigation is ignored", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.broadcast("Page.loadEventFired", {});
		await flush(tab);
		assert.equal(tab.isOpen, true);
	});

	test("the connect handshake enables the Runtime and Page domains in order", async () => {
		const fake = await fakeBrowser();
		await connectedTab();
		assert.deepEqual(fake.commands.map((command) => command.method), ["Runtime.enable", "Page.enable"]);
	});
});

describe("navigation", () => {
	test("returns when the load event fires", async () => {
		const fake = await fakeBrowser();
		fake.handle("Page.navigate", (_params, ctx) => {
			setImmediate(() => ctx.connection.emit("Page.loadEventFired", {}));
			return { frameId: "f" };
		});
		const started = Date.now();
		const tab = await connectedTab();
		await tab.navigate("https://example.test/");
		assert(Date.now() - started < 30, "should not wait for the load budget");
		assert.deepEqual(paramsOf(fake, "Page.navigate"), [{ url: "https://example.test/" }]);
	});

	test("stops waiting after the load budget when load never fires", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		const started = Date.now();
		await tab.navigate("https://spa.test/");
		assert(Date.now() - started >= 30, "should have waited for the load budget");
		assert.equal(paramsOf(fake, "Page.navigate").length, 1);
	});

	test("closing the tab releases a navigation that is waiting for load", async () => {
		const fake = await fakeBrowser();
		fake.handle("Page.navigate", (_params, ctx) => {
			setImmediate(() => ctx.connection.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "replied" }] }));
			return {};
		});
		const tab = await connectedTab();
		const navigation = tab.navigate("https://example.test/");
		await vi.waitFor(() => assert.equal(tab.drainConsole().length, 1));
		tab.close();
		await navigation;
	});

	test("a failed navigation rejects and later loads are ignored", async () => {
		const fake = await fakeBrowser();
		fake.handle("Page.navigate", () => cdpError("Cannot navigate to invalid URL"));
		const tab = await connectedTab();
		await assert.rejects(tab.navigate("nope"), /Cannot navigate to invalid URL/);
		fake.broadcast("Page.loadEventFired", {});
		await flush(tab);
	});

	test("`cdpNavigateContext` navigates a fresh connection and closes it", async () => {
		const fake = await fakeBrowser();
		fake.handle("Page.navigate", (_params, ctx) => {
			setImmediate(() => ctx.connection.emit("Page.loadEventFired", {}));
			return {};
		});
		assert.equal(await cdpNavigateContext("browser:fake", "https://example.test/"), true);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});
});

describe("page actions", () => {
	test("click resolves the node then calls the click function on it", async () => {
		const fake = await fakeBrowser();
		resolvableNodes(fake);
		assert.equal(await cdpClickForContext("browser:fake", 42), true);
		assert.deepEqual(paramsOf(fake, "DOM.resolveNode"), [{ backendNodeId: 42 }]);
		const [call] = paramsOf(fake, "Runtime.callFunctionOn");
		assert.equal(call.objectId, "object-42");
		assert.match(call.functionDeclaration, /\.click\(\)/);
		assert.deepEqual(call.arguments, []);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("typing passes the text and replace flag as call arguments", async () => {
		const fake = await fakeBrowser();
		resolvableNodes(fake);
		assert.equal(await cdpTypeForContext("browser:fake", 7, "hello", true), true);
		const [call] = paramsOf(fake, "Runtime.callFunctionOn");
		assert.deepEqual(call.arguments, [{ value: "hello" }, { value: true }]);
		assert.match(call.functionDeclaration, /dispatchEvent\(new InputEvent\('input'/);
	});

	test("scrolling a node and scrolling the window use different commands", async () => {
		const fake = await fakeBrowser();
		resolvableNodes(fake);
		assert.equal(await cdpScrollForContext("browser:fake", 0, 120, 9), true);
		assert.equal(await cdpScrollForContext("browser:fake", 5, -10), true);
		assert.deepEqual(paramsOf(fake, "Runtime.callFunctionOn").map((call) => call.arguments), [[{ value: 0 }, { value: 120 }]]);
		assert.deepEqual(paramsOf(fake, "Runtime.evaluate").map((call) => call.expression), ["window.scrollBy(5, -10)"]);
	});

	test("a node id of zero scrolls the window rather than a node", async () => {
		const fake = await fakeBrowser();
		await cdpScrollForContext("browser:fake", 1, 2, 0);
		assert.equal(paramsOf(fake, "DOM.resolveNode").length, 0);
		assert.deepEqual(paramsOf(fake, "Runtime.evaluate").map((call) => call.expression), ["window.scrollBy(1, 2)"]);
	});

	test("typing into the focused element inserts text", async () => {
		const fake = await fakeBrowser();
		assert.equal(await cdpTypeFocusedForContext("browser:fake", "abc"), true);
		assert.deepEqual(paramsOf(fake, "Input.insertText"), [{ text: "abc" }]);
	});

	test("keypress folds modifiers into bits and dispatches down/up pairs", async () => {
		const fake = await fakeBrowser();
		assert.equal(await cdpKeypressForContext("browser:fake", ["Cmd", "Shift", "a"]), true);
		assert.equal(await cdpKeypressForContext("browser:fake", ["b", "Enter"]), true);
		assert.equal(await cdpKeypressForContext("browser:fake", ["ctrl"]), true);
		const events = paramsOf(fake, "Input.dispatchKeyEvent").map(({ type, key, text, modifiers }) => ({ type, key, text, modifiers }));
		assert.deepEqual(events, [
			{ type: "keyDown", key: "a", text: undefined, modifiers: 12 },
			{ type: "keyUp", key: "a", text: undefined, modifiers: 12 },
			{ type: "keyDown", key: "b", text: "b", modifiers: 0 },
			{ type: "keyUp", key: "b", text: undefined, modifiers: 0 },
			{ type: "keyDown", key: "Enter", text: undefined, modifiers: 0 },
			{ type: "keyUp", key: "Enter", text: undefined, modifiers: 0 },
		]);
	});

	test("every modifier alias maps to its CDP bit", async () => {
		const fake = await fakeBrowser();
		for (const alias of ["alt", "option", "control", "ctrl", "meta", "command", "cmd", "shift"]) await cdpKeypressForContext("browser:fake", [alias, "x"]);
		const bits = paramsOf(fake, "Input.dispatchKeyEvent").filter((event) => event.type === "keyDown").map((event) => event.modifiers);
		assert.deepEqual(bits, [1, 1, 2, 2, 4, 4, 4, 8]);
	});

	test("mouse events carry button and click count, and moves have no button", async () => {
		const fake = await fakeBrowser();
		assert.equal(await cdpMouseForContext("browser:fake", 10, 20, "mousePressed"), true);
		assert.equal(await cdpMouseForContext("browser:fake", 11, 21, "mouseMoved", "right", 2), true);
		assert.equal(await cdpMouseForContext("browser:fake", 12, 22, "mouseReleased", "middle", 3), true);
		assert.deepEqual(paramsOf(fake, "Input.dispatchMouseEvent"), [
			{ type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
			{ type: "mouseMoved", x: 11, y: 21, button: "none", clickCount: 2 },
			{ type: "mouseReleased", x: 12, y: 22, button: "middle", clickCount: 3 },
		]);
	});

	test("drag presses at the start, moves through the path, releases at the end", async () => {
		const fake = await fakeBrowser();
		assert.equal(await cdpDragForContext("browser:fake", [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }]), true);
		assert.deepEqual(paramsOf(fake, "Input.dispatchMouseEvent").map(({ type, x, y, buttons }) => ({ type, x, y, buttons })), [
			{ type: "mousePressed", x: 1, y: 1, buttons: undefined },
			{ type: "mouseMoved", x: 5, y: 5, buttons: 1 },
			{ type: "mouseMoved", x: 9, y: 9, buttons: 1 },
			{ type: "mouseReleased", x: 9, y: 9, buttons: undefined },
		]);
	});

	test("a drag with fewer than two points is refused before any input", async () => {
		const fake = await fakeBrowser();
		await assert.rejects(cdpDragForContext("browser:fake", [{ x: 1, y: 1 }]), /at least two points/);
		assert.equal(paramsOf(fake, "Input.dispatchMouseEvent").length, 0);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test.each([
		["click", (id) => cdpClickForContext(id, 1)],
		["type", (id) => cdpTypeForContext(id, 1, "x", false)],
		["scroll", (id) => cdpScrollForContext(id, 0, 1)],
		["typeFocused", (id) => cdpTypeFocusedForContext(id, "x")],
		["keypress", (id) => cdpKeypressForContext(id, ["a"])],
		["mouse", (id) => cdpMouseForContext(id, 1, 1, "mousePressed")],
		["drag", (id) => cdpDragForContext(id, [{ x: 0, y: 0 }, { x: 1, y: 1 }])],
		["navigate", (id) => cdpNavigateContext(id, "https://example.test/")],
		["evaluate", (id) => cdpEvaluateForContext(id, "1")],
	])("%s reports no result for non-browser, unknown or detached contexts and never connects", async (_name, run) => {
		const fake = await fakeBrowser({ targets: [{ id: "detached", webSocketDebuggerUrl: null }] });
		const outcomes = await Promise.all([run("tab:1"), run("browser:gone"), run("browser:detached")]);
		const expected = _name === "evaluate" ? undefined : false;
		assert.deepEqual(outcomes, [expected, expected, expected]);
		assert.equal(fake.upgraded.length, 0);
	});

	test.each([
		["click", (id) => cdpClickForContext(id, 1)],
		["type", (id) => cdpTypeForContext(id, 1, "x", false)],
		["scroll", (id) => cdpScrollForContext(id, 0, 1)],
		["typeFocused", (id) => cdpTypeFocusedForContext(id, "x")],
		["keypress", (id) => cdpKeypressForContext(id, ["a"])],
		["mouse", (id) => cdpMouseForContext(id, 1, 1, "mousePressed")],
		["drag", (id) => cdpDragForContext(id, [{ x: 0, y: 0 }, { x: 1, y: 1 }])],
		["navigate", (id) => cdpNavigateContext(id, "https://example.test/")],
	])("%s propagates a protocol error and still closes its connection", async (_name, run) => {
		const fake = await fakeBrowser();
		for (const method of ["DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.evaluate", "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Page.navigate"]) fake.handle(method, () => cdpError(`${method} refused`));
		await assert.rejects(run("browser:fake"), /CDP error: \S+ refused/);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("an unresolvable backend node fails the action", async () => {
		const fake = await fakeBrowser();
		fake.handle("DOM.resolveNode", () => ({}));
		await assert.rejects(cdpClickForContext("browser:fake", 77), /could not resolve backend node 77/);
		assert.equal(paramsOf(fake, "Runtime.callFunctionOn").length, 0);
	});
});

describe("evaluate", () => {
	test("returns the by-value result on a fresh connection and closes it", async () => {
		const fake = await fakeBrowser();
		fake.handle("Runtime.evaluate", () => ({ result: { type: "number", value: 3 } }));
		assert.deepEqual(await cdpEvaluateForContext("browser:fake", "1 + 2"), { contextId: "browser:fake", value: 3 });
		assert.deepEqual(paramsOf(fake, "Runtime.evaluate"), [{ expression: "1 + 2", returnByValue: true, timeout: 5000, awaitPromise: true }]);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("page exceptions and non-serializable results yield no value", async () => {
		const fake = await fakeBrowser();
		fake.handle("Runtime.evaluate", (params) =>
			params.expression === "throw"
				? { result: { type: "object", subtype: "error" }, exceptionDetails: { text: "Uncaught" } }
				: { result: { type: "number", unserializableValue: "NaN" } },
		);
		assert.deepEqual(await cdpEvaluateForContext("browser:fake", "throw"), { contextId: "browser:fake", value: undefined });
		assert.deepEqual(await cdpEvaluateForContext("browser:fake", "0/0"), { contextId: "browser:fake", value: undefined });
	});

	test("a protocol error rejects and the connection is still closed", async () => {
		const fake = await fakeBrowser();
		fake.handle("Runtime.evaluate", () => cdpError("Execution context was destroyed."));
		await assert.rejects(cdpEvaluateForContext("browser:fake", "1"), /Execution context was destroyed\./);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});
});

describe("tab lookup by window", () => {
	test("reuses the cached connection while it matches", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		const first = await connectedTab("Docs");
		assert.equal(await cdpTabForWindow("Docs - Google Chrome"), first);
		assert.equal(await cdpTabForWindow("  docs  "), first);
		assert.equal(fake.upgraded.length, 1);
		assert.equal(fake.listRequests, 1);
	});

	test("a new title on the same target refreshes the cached tab", async () => {
		const fake = await fakeBrowser({ title: "Inbox (1)" });
		const tab = await connectedTab("Inbox");
		fake.setTargets([{ id: "fake", title: "Inbox (2)" }]);
		assert.equal(await cdpTabForWindow("Inbox (2)"), tab);
		assert.equal(tab.title, "Inbox (2)");
		assert.equal(fake.upgraded.length, 1);
	});

	test("a closed cached connection is replaced", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		const first = await connectedTab("Docs");
		fake.connections[0].close();
		await vi.waitFor(() => assert.equal(first.isOpen, false));
		const second = await connectedTab("Docs");
		assert.notEqual(second, first);
		assert.equal(fake.upgraded.length, 2);
	});

	test("concurrent lookups share one connection attempt", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		const [a, b] = await Promise.all([cdpTabForWindow("Docs"), cdpTabForWindow("Docs")]);
		assert(a);
		assert.equal(a, b);
		assert.equal(fake.upgraded.length, 1);
	});

	test("a lone page matches any window title, several unmatched pages match none", async () => {
		const fake = await fakeBrowser({ title: "Only" });
		assert.equal((await connectedTab("Something else entirely")).targetId, "fake");
		disconnectCdp();
		fake.setTargets([{ id: "a", title: "A" }, { id: "b", title: "B" }]);
		assert.equal(await cdpTabForWindow("Neither"), undefined);
		assert.equal(await cdpTabForWindow(""), undefined);
	});

	test("an exact title beats prefix matches", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "prefix", title: "Report 2025" }, { id: "exact", title: "Report" }] });
		const tab = await cdpTabForWindow("Report");
		assert.equal(tab?.targetId, "exact");
		assert.equal(fake.upgraded.length, 1);
	});

	test("a failed lookup is cached for five seconds", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		fake.rejectUpgrade(500);
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		assert.equal(await cdpTabForWindow("Docs"), undefined);
		fake.rejectUpgrade(undefined);
		now += 4_999;
		assert.equal(await cdpTabForWindow("Docs"), undefined);
		assert.equal(fake.listRequests, 1);
		now += 2;
		assert((await cdpTabForWindow("Docs"))?.isOpen);
		assert.equal(fake.listRequests, 2);
	});

	test("unreachable discovery yields no tab", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		await fake.close();
		assert.equal(await cdpTabForWindow("Docs"), undefined);
	});

	test("`disconnectCdp` closes tabs and clears the failure cache", async () => {
		const fake = await fakeBrowser({ title: "Docs" });
		const tab = await connectedTab("Docs");
		disconnectCdp();
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
		assert.equal(tab.isOpen, false);
		fake.rejectUpgrade(500);
		assert.equal(await cdpTabForWindow("Docs"), undefined);
		fake.rejectUpgrade(undefined);
		disconnectCdp();
		assert((await cdpTabForWindow("Docs"))?.isOpen);
	});
});

describe("same-titled tabs", () => {
	const frame = { x: 100, y: 100, w: 800, h: 600 };

	/**
	 * Script per-target window bounds and visibility.
	 * @param {import('./fixtures/fake-cdp.mjs').FakeCdp} fake Endpoint.
	 * @param {Record<string, { bounds?: object, visible?: boolean }>} byTarget Per-target answers.
	 * @returns {void}
	 * @throws {never} Registration only.
	 */
	function scriptWindows(fake, byTarget) {
		fake.handle("Browser.getWindowForTarget", (params) => {
			const bounds = byTarget[params.targetId]?.bounds;
			return bounds ? { windowId: 1, bounds } : {};
		});
		fake.handle("Runtime.evaluate", (_params, ctx) => ({ result: { value: byTarget[ctx.targetId]?.visible ? "visible" : "hidden" } }));
	}

	const twins = [{ id: "one", title: "Same" }, { id: "two", title: "Same" }];
	const here = { left: 100, top: 100, width: 800, height: 600 };
	const there = { left: 1500, top: 100, width: 800, height: 600 };

	test("the tab in the controlled window wins", async () => {
		const fake = await fakeBrowser({ targets: twins });
		scriptWindows(fake, { one: { bounds: there, visible: true }, two: { bounds: here, visible: true } });
		assert.equal((await cdpTabForWindow("Same", frame))?.targetId, "two");
	});

	test("within the window the visible tab wins; a hidden in-frame tab is the fallback", async () => {
		const fake = await fakeBrowser({ targets: [...twins, { id: "three", title: "Same" }] });
		scriptWindows(fake, { one: { bounds: here, visible: false }, two: { bounds: here, visible: true }, three: { bounds: here, visible: false } });
		assert.equal((await cdpTabForWindow("Same", frame))?.targetId, "two");
		disconnectCdp();
		scriptWindows(fake, { one: { bounds: here, visible: false }, two: { bounds: there, visible: true }, three: { bounds: here, visible: false } });
		assert.equal((await cdpTabForWindow("Same", frame))?.targetId, "one");
	});

	test("without a frame the first visible tab wins", async () => {
		const fake = await fakeBrowser({ targets: twins });
		scriptWindows(fake, { one: { visible: false }, two: { visible: true } });
		assert.equal((await cdpTabForWindow("Same"))?.targetId, "two");
	});

	test("with nothing to tell them apart the first listed tab wins", async () => {
		const fake = await fakeBrowser({ targets: twins });
		scriptWindows(fake, { one: { visible: false }, two: { visible: false } });
		assert.equal((await cdpTabForWindow("Same"))?.targetId, "one");
		disconnectCdp();
		scriptWindows(fake, { one: { bounds: there }, two: { bounds: there } });
		assert.equal((await cdpTabForWindow("Same", frame))?.targetId, "one");
	});

	test("several prefix matches and no exact title are all candidates", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "one", title: "Same A" }, { id: "two", title: "Same B" }] });
		scriptWindows(fake, { two: { visible: true } });
		assert.equal((await cdpTabForWindow("Same"))?.targetId, "two");
	});

	test("a visibility query that errors counts as not visible", async () => {
		const fake = await fakeBrowser({ targets: twins });
		fake.handle("Runtime.evaluate", () => cdpError("Inspected target navigated or closed"));
		assert.equal((await cdpTabForWindow("Same"))?.targetId, "one");
	});

	test("an unreachable candidate is skipped", async () => {
		const fake = await fakeBrowser();
		fake.setTargets([{ id: "dead", title: "Same", webSocketDebuggerUrl: `ws://127.0.0.1:${fake.port}/devtools/missing/dead` }, { id: "two", title: "Same" }]);
		scriptWindows(fake, { two: { visible: true } });
		assert.equal((await cdpTabForWindow("Same"))?.targetId, "two");
	});

	test("unreadable bounds are trusted for a cached tab but not for candidate selection", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "solo", title: "Solo" }] });
		scriptWindows(fake, { solo: { visible: true } });
		const tab = await cdpTabForWindow("Solo", frame);
		assert.equal(await cdpTabForWindow("Solo", frame), tab, "cache verification trusts unknown bounds");
		assert.equal(fake.upgraded.length, 1);
		fake.handle("Browser.getWindowForTarget", () => cdpError("Browser window not found"));
		assert.equal(await cdpTabForWindow("Solo", frame), tab, "an erroring bounds query is also trusted");
	});

	test("a cached tab that left the controlled window is not reused", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "solo", title: "Solo" }] });
		scriptWindows(fake, { solo: { bounds: here, visible: true } });
		const tab = await cdpTabForWindow("Solo", frame);
		scriptWindows(fake, { solo: { bounds: there, visible: true } });
		assert.equal(await cdpTabForWindow("Solo", frame), tab, "same target is re-selected and its open connection reused");
		assert.equal(fake.upgraded.length, 1);
		assert(fake.listRequests >= 2);
	});

	test("window bounds convert to a frame and malformed bounds are dropped", async () => {
		const fake = await fakeBrowser();
		const tab = await connectedTab();
		fake.handle("Browser.getWindowForTarget", () => ({ bounds: { left: 1, top: 2, width: 3, height: 4 } }));
		assert.deepEqual(await tab.windowBounds(), { x: 1, y: 2, w: 3, h: 4 });
		assert.deepEqual(paramsOf(fake, "Browser.getWindowForTarget").at(-1), { targetId: "fake" });
		fake.handle("Browser.getWindowForTarget", () => ({ bounds: { left: "1", width: 3 } }));
		assert.equal(await tab.windowBounds(), undefined);
		fake.handle("Browser.getWindowForTarget", () => ({ bounds: { left: 1, width: "3" } }));
		assert.equal(await tab.windowBounds(), undefined);
	});

	test("a frame center within 50 points keeps the cached tab, further forces a re-pick", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "solo", title: "Solo" }] });
		const bounds = (left, top) => ({ left, top, width: 800, height: 600 });
		scriptWindows(fake, { solo: { bounds: bounds(100, 100), visible: true } });
		const tab = await cdpTabForWindow("Solo", frame);
		assert(tab);
		for (const [left, top, cached] of [[150, 100, true], [151, 100, false], [100, 150, true], [100, 151, false], [50, 100, true], [49, 100, false]]) {
			scriptWindows(fake, { solo: { bounds: bounds(left, top), visible: true } });
			const listed = fake.listRequests;
			assert.equal(await cdpTabForWindow("Solo", frame), tab);
			assert.equal(fake.listRequests - listed, cached ? 0 : 1, `bounds ${left},${top}`);
		}
	});
});

describe("snapshots", () => {
	/**
	 * Script the evaluate and AX tree answers for a snapshot.
	 * @param {import('./fixtures/fake-cdp.mjs').FakeCdp} fake Endpoint.
	 * @param {unknown} text `document.body.innerText` result.
	 * @param {object[]} nodes `Accessibility.getFullAXTree` nodes.
	 * @returns {void}
	 * @throws {never} Registration only.
	 */
	function script(fake, text, nodes) {
		fake.handle("Runtime.evaluate", () => ({ result: { value: text } }));
		fake.handle("Accessibility.getFullAXTree", () => ({ nodes }));
	}

	const ax = (nodeId, role, name, extra = {}) => ({ nodeId, role: { type: "role", value: role }, name: { type: "computedString", value: name }, ...extra });

	test("returns no snapshot for unknown or detached contexts", async () => {
		const fake = await fakeBrowser({ targets: [{ id: "detached", webSocketDebuggerUrl: null }] });
		assert.equal(await cdpSnapshotForContext("tab:1"), undefined);
		assert.equal(await cdpSnapshotForContext("browser:gone"), undefined);
		assert.equal(await cdpSnapshotForContext("browser:detached"), undefined);
		assert.equal(fake.upgraded.length, 0);
	});

	test("a page without a url snapshots with an empty url", async () => {
		const fake = await fakeBrowser();
		fake.discoveryBody(JSON.stringify([{ id: "fake", type: "page", title: "Bare", webSocketDebuggerUrl: fake.url("page/fake") }]));
		assert.equal((await cdpSnapshotForContext("browser:fake"))?.url, "");
	});

	test("builds targets and an outline from a single-rooted tree", async () => {
		const fake = await fakeBrowser({ id: "fake", title: "Form", url: "https://example.test/form" });
		script(fake, "Hello page", [
			ax("1", "RootWebArea", "Form", { childIds: ["2", "3", "4", "5", "9"], backendDOMNodeId: 1 }),
			ax("2", "button", "Save", { parentId: "1", backendDOMNodeId: 11.9 }),
			ax("3", "textbox", "Email", { parentId: "1", backendDOMNodeId: 12, value: { type: "string", value: " a@b.c " }, description: { value: "work" } }),
			ax("4", "button", "No backend node", { parentId: "1" }),
			ax("5", "button", "", { parentId: "1", backendDOMNodeId: 14 }),
			ax("6", "StaticText", "plain", { parentId: "1", backendDOMNodeId: 15 }),
		]);
		const snapshot = await cdpSnapshotForContext("browser:fake");
		assert(snapshot);
		assert.equal(snapshot.contextId, "browser:fake");
		assert.equal(snapshot.targetId, "fake");
		assert.equal(snapshot.title, "Form");
		assert.equal(snapshot.url, "https://example.test/form");
		assert.equal(snapshot.text, "Hello page");
		assert.deepEqual(snapshot.diagnostics, { cdp: "connected", targetCount: 2 });
		assert.deepEqual(snapshot.targets.map(({ role, name, value, actions, backendNodeId }) => ({ role, name, value, actions, backendNodeId })), [
			{ role: "button", name: "Save", value: undefined, actions: ["click"], backendNodeId: 11 },
			{ role: "textbox", name: "Email", value: "a@b.c", actions: ["click", "set_text"], backendNodeId: 12 },
		]);
		assert(snapshot.targets.every((target) => target.source === "browser_ax" && !target.ref.startsWith("cdp:")), "wire refs are mapped to model refs");
		assert.match(JSON.stringify(snapshot.outline), /Save/);
		await vi.waitFor(() => assert.equal(fake.connections[0].closed, true));
	});

	test("several roots, cycles, repeated ids and id-less nodes still serialize", async () => {
		const fake = await fakeBrowser();
		script(fake, "", [
			ax("a", "link", "First", { backendDOMNodeId: 1, childIds: ["b"] }),
			ax("b", "checkbox", "Loop", { parentId: "a", backendDOMNodeId: 2, childIds: ["a", "b", "ghost"] }),
			{ role: { value: "radio" }, name: { value: "Anonymous" }, backendDOMNodeId: 3 },
			ax("c", "slider", "Orphan", { parentId: "missing", backendDOMNodeId: 4 }),
			null,
		]);
		const snapshot = await cdpSnapshotForContext("browser:fake");
		assert(snapshot);
		assert.deepEqual(snapshot.targets.map((target) => target.name).sort(), ["Anonymous", "First", "Loop", "Orphan"]);
		assert.match(snapshot.outline.text ?? JSON.stringify(snapshot.outline), /Browser page|First/);
	});

	test("every interactive role is classified and others are not", async () => {
		const fake = await fakeBrowser();
		const roles = ["button", "Link", "checkbox", "radio", "menuitem", "tab", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "heading", "", "paragraph"];
		script(fake, "", roles.map((role, index) => ax(String(index + 1), role, `n${index}`, { backendDOMNodeId: index + 1 })));
		const snapshot = await cdpSnapshotForContext("browser:fake");
		assert(snapshot);
		assert.deepEqual(snapshot.targets.map((target) => target.actions.join("+")), [
			...Array(6).fill("click"),
			...Array(3).fill("click+set_text"),
			...Array(3).fill("click"),
		]);
	});

	test("a failing text or tree query degrades to empty rather than failing the snapshot", async () => {
		const fake = await fakeBrowser();
		fake.handle("Runtime.evaluate", () => cdpError("no document"));
		fake.handle("Accessibility.getFullAXTree", () => cdpError("AX disabled"));
		const snapshot = await cdpSnapshotForContext("browser:fake");
		assert(snapshot);
		assert.equal(snapshot.text, "");
		assert.deepEqual(snapshot.targets, []);
	});

	test.each([[null, ""], [undefined, ""], [42, "42"], [{ nested: true }, "[object Object]"]])("page text %j is coerced to %j", async (value, expected) => {
		const fake = await fakeBrowser();
		script(fake, value, [{ nodeId: "1", role: { value: "document" }, name: { value: "" } }]);
		assert.equal((await cdpSnapshotForContext("browser:fake"))?.text, expected);
	});

	test("a non-array tree result is treated as empty", async () => {
		const fake = await fakeBrowser();
		fake.handle("Accessibility.getFullAXTree", () => ({ nodes: "oops" }));
		const snapshot = await cdpSnapshotForContext("browser:fake");
		assert.deepEqual(snapshot?.targets, []);
	});
});
