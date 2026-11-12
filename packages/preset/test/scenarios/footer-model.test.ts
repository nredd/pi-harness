/** Physical request metadata reaches the real replacement footer without changing selection. */
import { type ExtensionFactory, type ModelRouteContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import type { InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { deferred, FooterFixture, WIDTHS } from "./support.ts";

let fixture: FooterFixture;
afterEach(async () => fixture?.dispose());

/** The stats row, not a transcript match, proves the installed replacement is rendering identity. */
function stats(host: InteractiveHarness): string {
	const rows = host.viewport().filter((row) => row.includes("(auto)"));
	expect(rows).toHaveLength(1);
	return rows[0] ?? "";
}

/** Require fixture registry entries without manufacturing a physical model when resolution fails. */
function model(ctx: Pick<ModelRouteContext, "modelRegistry">, provider: string, id: string) {
	const found = ctx.modelRegistry.find(provider, id);
	if (!found) throw new Error(`Missing fixture model ${provider}/${id}`);
	return found;
}

/** Select only on a fresh session: reload/resume must restore the branch, not append a model change. */
function selectProfile(id: string): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.model?.api !== "pi-virtual") {
				await pi.setModel(model(ctx, "router", id));
				pi.setThinkingLevel("medium");
			}
		});
	};
}

it.each(["default", "deep"])("shows the actual model and thinking without replacing router/%s", async (id) => {
	const route: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			provider: "router",
			id,
			name: "Fixture profile",
			thinkingLevels: ["medium"],
			route: (_request, ctx) => ({ model: model(ctx, "faux", "alpha"), thinkingLevel: "low" }),
		});
	};
	fixture = new FooterFixture();
	const host = await fixture.start({
		columns: 240,
		models: [{ id: "alpha", reasoning: true }],
		useModelRuntimeStream: true,
		settings: { defaultProvider: "router", defaultModel: id },
		extensionFactories: [route, selectProfile(id)],
	});
	expect(stats(host)).toContain(`${id} • medium (unresolved)`);
	host.harness.setResponses([fauxAssistantMessage("fixture answer")]);
	await host.harness.session.prompt("offline fixture");
	await host.settle();
	expect(stats(host)).toContain(`${id} • medium -> (faux) alpha • low`);
	expect(host.harness.session.model?.id).toBe(id);
	expect(host.harness.settingsManager.getDefaultModel()).toBe(id);
	const response = host.harness.session.state.messages.find((message) => message.role === "assistant");
	expect(response).toMatchObject({ provider: "faux", model: "alpha", thinkingLevel: "low" });

	for (const width of WIDTHS) {
		host.resize(width, 40);
		await host.settle();
		for (const row of host.viewport()) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	host.resize(240, 40);
	host.input("/reload");
	host.input("\r");
	await host.settle();
	expect(stats(host)).toContain(`${id} • medium -> (faux) alpha • low`);
	const previousSession = host.harness.session;
	host.input("/new");
	host.input("\r");
	await host.settle();
	expect(host.harness.session).not.toBe(previousSession);
	expect(stats(host)).toContain(`${id} • medium (unresolved)`);
	expect(stats(host)).not.toContain("alpha");
});

it("never guesses while routing, clears prior dispatch, and renders live physical metadata", async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	const streamed = deferred<void>();
	const finishStream = deferred<void>();
	let pauseRoute = false;
	let pauseStream = false;
	const route: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			provider: "router",
			id: "deep",
			name: "Fixture",
			thinkingLevels: ["medium"],
			async route(_request, ctx) {
				if (pauseRoute) {
					entered.resolve();
					await release.promise;
				}
				return { model: model(ctx, "faux", "alpha"), thinkingLevel: "low" };
			},
		});
		pi.on("message_update", async () => {
			if (pauseStream) {
				streamed.resolve();
				await finishStream.promise;
			}
		});
	};
	fixture = new FooterFixture();
	const host = await fixture.start({
		columns: 240,
		models: [{ id: "alpha", reasoning: true }],
		useModelRuntimeStream: true,
		extensionFactories: [route, selectProfile("deep")],
	});
	host.harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await host.harness.session.prompt("first request");
	pauseRoute = true;
	pauseStream = true;
	const turn = host.harness.session.prompt("second request");
	try {
		await entered.promise;
		await host.settle();
		expect(stats(host)).toContain("deep • medium (routing)");
		expect(stats(host)).not.toContain("alpha");
		release.resolve();
		await streamed.promise;
		await host.settle();
		expect(stats(host)).toContain("deep • medium -> (faux) alpha");
		// Core records dispatched thinking on the final message, not provider partials. Do not invent it.
		expect(stats(host)).not.toContain("alpha • medium");
		finishStream.resolve();
		await turn;
		await host.settle();
		expect(stats(host)).toContain("alpha • low");
	} finally {
		release.resolve();
		finishStream.resolve();
		await turn;
	}
});

it("clears the previous physical label while a tool continuation routes to another model", async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	let requests = 0;
	const route: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			provider: "router",
			id: "deep",
			name: "Fixture",
			thinkingLevels: ["medium"],
			async route(_request, ctx) {
				if (++requests === 2) {
					entered.resolve();
					await release.promise;
				}
				return {
					model: model(ctx, "faux", requests === 1 ? "alpha" : "beta"),
					thinkingLevel: requests === 1 ? "low" : "high",
				};
			},
		});
		pi.registerTool({
			name: "fixture_tool",
			label: "Fixture tool",
			description: "Complete one offline tool call",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fixture result" }], details: undefined }),
		});
	};
	fixture = new FooterFixture();
	const host = await fixture.start({
		columns: 240,
		models: [
			{ id: "alpha", reasoning: true },
			{ id: "beta", reasoning: true },
		],
		useModelRuntimeStream: true,
		extensionFactories: [route, selectProfile("deep")],
	});
	host.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture_tool", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("continued answer"),
	]);
	const turn = host.harness.session.prompt("one tool then continue");
	try {
		await entered.promise;
		await host.settle();
		expect(host.harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		expect(stats(host)).toContain("deep • medium (routing)");
		expect(stats(host)).not.toContain("alpha");
		expect(stats(host)).not.toContain("beta");
		release.resolve();
		await turn;
		await host.settle();
		expect(stats(host)).toContain("-> (faux) beta • high");
	} finally {
		release.resolve();
		await turn;
	}
});

it.each([
	["virtual to virtual", false, false, "stop", false],
	["direct to virtual", true, false, "stop", false],
	["virtual away and back", false, true, "stop", false],
	["virtual through direct and back", false, true, "stop", true],
	["cancelled old response", false, false, "aborted", false],
	["tool continuation under new selection", false, false, "toolUse", false],
] as const)(
	"does not attribute a previous selection's late response: %s",
	async (name, direct, bounce, stopReason, viaDirect) => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const ended = deferred<void>();
		const finish = deferred<void>();
		let held = false;
		let heldEnd = false;
		const routes: ExtensionFactory = (pi) => {
			for (const [id, physical] of [
				["deep", "alpha"],
				["fast", "beta"],
			]) {
				if (!id || !physical) throw new Error("Invalid fixture pair");
				pi.registerVirtualModel({
					provider: "router",
					id,
					name: id,
					thinkingLevels: ["medium"],
					route: (_request, ctx) => ({ model: model(ctx, "faux", physical), thinkingLevel: "low" }),
				});
			}
			pi.registerTool({
				name: "old_request_tool",
				label: "Old request tool",
				description: "Complete an offline tool call",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
			});
			pi.on("message_update", async () => {
				if (!held) {
					held = true;
					entered.resolve();
					await release.promise;
				}
			});
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !heldEnd) {
					heldEnd = true;
					ended.resolve();
					await finish.promise;
				}
			});
		};
		fixture = new FooterFixture();
		const options = {
			columns: 240,
			models: [
				{ id: "alpha", reasoning: true },
				{ id: "beta", reasoning: true },
			],
			useModelRuntimeStream: true,
			extensionFactories: [routes, ...(direct ? [] : [selectProfile("deep")])],
		};
		let host = await fixture.start(options);
		host.harness.setResponses([
			fauxAssistantMessage(stopReason === "toolUse" ? fauxToolCall("old_request_tool", {}) : "old selection response", {
				stopReason,
				errorMessage: stopReason === "aborted" ? "fixture cancellation" : undefined,
			}),
			fauxAssistantMessage("continued under new selection"),
		]);
		const turn = host.harness.session.prompt("old request");
		try {
			await entered.promise;
			const fast = host.harness.session.modelRuntime.getModel("router", "fast");
			const deep = host.harness.session.modelRuntime.getModel("router", "deep");
			if (!fast || !deep) throw new Error("Missing fixture profile");
			await host.harness.session.setModel(viaDirect ? host.harness.getModel() : fast);
			if (bounce) await host.harness.session.setModel(deep);
			await host.settle();
			expect(stats(host)).not.toContain("->");
			release.resolve();
			await ended.promise;
			await host.settle();
			// The old final event has reached the footer, but has not yet been persisted.
			expect(stats(host)).toContain("(unresolved)");
			expect(stats(host)).not.toContain("->");
			finish.resolve();
			await turn;
			await host.settle();
			const expected = stopReason === "toolUse" ? "-> (faux) beta • low" : "(unresolved)";
			expect(stats(host)).toContain(expected);
			if (stopReason !== "toolUse") expect(stats(host)).not.toContain("->");
			// Rebuild from persisted history, not an in-memory rejection of the old stream.
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(stats(host)).toContain(expected);
			if (stopReason !== "toolUse") expect(stats(host)).not.toContain("->");
			if (name === "virtual to virtual") {
				const file = host.harness.sessionManager.getSessionFile();
				if (!file) throw new Error("Missing persisted race fixture");
				await host.dispose();
				const manager = SessionManager.open(file);
				host = await fixture.start({
					...options,
					extensionFactories: [routes],
					sessionManager: manager,
					sessionStartEvent: { type: "session_start", reason: "resume" },
				});
				const restored = host.harness.session.modelRuntime.getModel("router", "fast");
				if (!restored) throw new Error("Missing restored race selection");
				host.harness.session.state.model = restored;
				host.harness.session.state.thinkingLevel = "medium";
				host.harness.session.state.messages = manager.buildSessionContext().messages;
				host.resize(241, 40);
				await host.settle();
				expect(stats(host)).toContain("(unresolved)");
				expect(stats(host)).not.toContain("->");
			}
			host.harness.setResponses([fauxAssistantMessage("new selection response")]);
			await host.harness.session.prompt("new request");
			await host.settle();
			expect(stats(host)).toContain(`-> (faux) ${bounce ? "alpha" : "beta"} • low`);
		} finally {
			release.resolve();
			finish.resolve();
			await turn;
		}
	},
);

it("restores only the resumed branch's physical response and clears a cancelled route", async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	let pauseRoute = false;
	const route: ExtensionFactory = (pi) =>
		pi.registerVirtualModel({
			provider: "router",
			id: "deep",
			name: "Fixture",
			thinkingLevels: ["medium"],
			async route(request, ctx) {
				if (pauseRoute) {
					entered.resolve();
					await release.promise;
				}
				if (request.signal?.aborted) throw new Error("Fixture route cancelled before selection");
				return { model: model(ctx, "faux", "alpha"), thinkingLevel: "low" };
			},
		});
	fixture = new FooterFixture();
	const options = {
		columns: 240,
		models: [{ id: "alpha", reasoning: true }],
		useModelRuntimeStream: true,
		extensionFactories: [route, selectProfile("deep")],
	};
	const first = await fixture.start(options);
	first.harness.setResponses([fauxAssistantMessage("persisted answer")]);
	await first.harness.session.prompt("persist this response");
	const file = first.harness.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected persisted fixture session");
	await first.dispose();
	const manager = SessionManager.open(file);
	const host = await fixture.start({
		...options,
		extensionFactories: [route],
		sessionManager: manager,
		sessionStartEvent: { type: "session_start", reason: "resume" },
	});
	// The testing harness starts with its physical fixture model, unlike SDK resume.
	// Restore the saved pair/messages without recording a new selection in that branch.
	const virtual = host.harness.session.modelRuntime.getModel("router", "deep");
	if (!virtual) throw new Error("Missing resumed fixture model");
	host.harness.session.state.model = virtual;
	host.harness.session.state.thinkingLevel = "medium";
	host.harness.session.state.messages = manager.buildSessionContext().messages;
	host.resize(241, 40);
	await host.settle();
	expect(stats(host)).toContain("deep • medium -> (faux) alpha • low");
	pauseRoute = true;
	const turn = host.harness.session.prompt("cancel before dispatch");
	try {
		await entered.promise;
		await host.settle();
		expect(stats(host)).toContain("(routing)");
		const abort = host.harness.session.abort();
		release.resolve();
		await abort;
		await turn;
		await host.settle();
		expect(host.harness.faux.state.callCount).toBe(0);
		expect(stats(host)).toContain("(unresolved)");
		expect(stats(host)).not.toContain("alpha");
	} finally {
		release.resolve();
		await turn;
	}
});

it.each(["error", "aborted"] as const)(
	"labels physical %s without carrying identity across a model switch",
	async (stopReason) => {
		fixture = new FooterFixture();
		const host = await fixture.start({
			columns: 240,
			models: [{ id: "alpha", reasoning: true }],
			useModelRuntimeStream: true,
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) =>
					pi.registerVirtualModel({
						provider: "router",
						id: "deep",
						name: "Fixture",
						thinkingLevels: ["medium"],
						route: (_request, ctx) => ({ model: model(ctx, "faux", "alpha"), thinkingLevel: "off" }),
					}),
				selectProfile("deep"),
			],
		});
		host.harness.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "fixture failure" })]);
		await host.harness.session.prompt("failure fixture");
		await host.settle();
		expect(stats(host)).toContain(`-> (faux) alpha • off (${stopReason})`);
		await host.harness.session.setModel(host.harness.getModel());
		await host.settle();
		expect(stats(host)).not.toContain("->");
		expect(stats(host)).not.toContain(`(${stopReason})`);
		const virtual = host.harness.session.modelRuntime.getModel("router", "deep");
		if (!virtual) throw new Error("Missing virtual fixture");
		await host.harness.session.setModel(virtual);
		await host.settle();
		expect(stats(host)).toContain("deep");
		expect(stats(host)).toContain("(unresolved)");
		expect(stats(host)).not.toContain("alpha");
	},
);
