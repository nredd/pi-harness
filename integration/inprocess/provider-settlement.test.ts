/** Offline Responses -> real AgentSession boundary characterization for #798, not a liveness policy. */
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Harness } from "@nredd/pi-test-lib/harness";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateStackHome, startStack } from "./support.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
const textItem = {
	type: "message",
	id: "msg_fixture",
	role: "assistant",
	status: "completed",
	phase: "final_answer",
	content: [{ type: "output_text", text: "synthetic private sentinel", annotations: [] }],
};
const toolItem = {
	type: "function_call",
	id: "fc_fixture",
	call_id: "call_fixture",
	name: "fixture",
	arguments: "{}",
	status: "completed",
};
const done = (item: object) => ({ type: "response.output_item.done", output_index: 0, item });
const completed = (output: object[] = []) => ({
	type: "response.completed",
	response: { id: "resp_fixture", status: "completed", output },
});

/** Content-free observations: exact event enums only, never request/model IDs or content. */
const eventTypes = new Set([
	"response.output_item.added",
	"response.output_item.done",
	"response.output_text.delta",
	"response.completed",
	"response.failed",
]);

describe("provider to settlement diagnostics", () => {
	let home: Awaited<ReturnType<typeof isolateStackHome>>;
	let h: Harness;
	let trace: unknown[];
	let responses: object[][];
	let executions: number;
	let requests: number;

	beforeEach(async () => {
		home = await isolateStackHome();
		trace = [];
		responses = [];
		executions = 0;
		requests = 0;
		// Intercept the actual HTTP transport before invoking the real Responses wrapper.
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			requests++;
			const events = responses.shift();
			if (!events) throw new Error("Unscripted fixture request");
			return new Response(
				events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const observe: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "fixture",
				label: "Fixture",
				description: "Count a synthetic tool execution",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "ok" }], details: undefined };
				},
			});
			pi.on("provider_stream_event", (event) => {
				const data = event.data as { type?: string };
				trace.push({ stage: "provider", type: eventTypes.has(data.type ?? "") ? data.type : "unknown" });
			});
			pi.on("message_end", ({ message }) => {
				if (message.role === "assistant")
					trace.push({ stage: "message", stop: message.stopReason, blocks: message.content.map((part) => part.type) });
			});
			pi.on("agent_before_settle", (event) => {
				trace.push({
					stage: "boundary",
					outcome: event.outcome,
					continue: event.continue,
					pending: event.context.pendingMessages.length,
				});
			});
			pi.on("agent_settled", (event) => {
				trace.push({ stage: "settled", aborted: event.aborted });
			});
		};
		h = await startStack({
			cwd: home.root,
			factories: [observe],
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		// createHarness does not wire this SDK observer; mirror sdk.ts's public callback bridge.
		h.session.agent.onProviderStreamEvent = async (data, observedModel) => {
			await h.session.extensionRunner.emit({
				type: "provider_stream_event",
				provider: observedModel.provider,
				api: observedModel.api,
				model: observedModel.id,
				data,
			});
		};
		h.session.agent.streamFunction = (_model, context, options) =>
			stream(model, context, { ...options, apiKey: "fixture-key" });
	});
	afterEach(async () => {
		await h?.session.abort();
		h?.cleanup();
		vi.restoreAllMocks();
		await home?.cleanup();
	});

	it("settles a tool-free final after the provider, message and boundary, not after todo completion", async () => {
		responses = [[done(textItem), completed([textItem])]];
		await h.session.prompt("synthetic prompt sentinel");
		expect(trace).toEqual([
			{ stage: "provider", type: "response.output_item.done" },
			{ stage: "provider", type: "response.completed" },
			{ stage: "message", stop: "stop", blocks: ["text"] },
			{ stage: "boundary", outcome: "completed", continue: false, pending: 0 },
			{ stage: "settled", aborted: false },
		]);
		expect(requests).toBe(1);
		expect(executions).toBe(0);
		expect(JSON.stringify(trace)).not.toContain("sentinel");
	});

	it("accepts a genuinely empty completed response without inventing a tool", async () => {
		responses = [[completed()]];
		await h.session.prompt("empty fixture");
		expect(trace).toContainEqual({ stage: "message", stop: "stop", blocks: [] });
		expect(trace).toContainEqual({ stage: "boundary", outcome: "completed", continue: false, pending: 0 });
		expect(requests).toBe(1);
		expect(executions).toBe(0);
	});

	it("preserves a tool supplied by output_item.done even with no added or delta events", async () => {
		responses = [
			[done(toolItem), completed([toolItem])],
			[done(textItem), completed([textItem])],
		];
		await h.session.prompt("execute fixture");
		expect(trace).toContainEqual({ stage: "message", stop: "toolUse", blocks: ["toolCall"] });
		expect(executions).toBe(1);
		expect(requests).toBe(2);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each([textItem, toolItem])(
		"characterizes terminal-only $type output without claiming an observed live loss",
		async (item) => {
			responses = [[completed([item])]];
			await h.session.prompt("terminal-only fixture");
			// Current core ignores terminal output except reasoning signatures. This is a diagnostic,
			// not an endorsement of the malformed stream or evidence that a live provider sent one.
			expect(trace).toContainEqual({ stage: "message", stop: "stop", blocks: [] });
			expect(executions).toBe(0);
			expect(requests).toBe(1);
		},
	);

	it.each([
		{ name: "early EOF", events: [done(textItem)], blocks: ["text"] },
		{
			name: "failed terminal",
			events: [
				done(textItem),
				{
					type: "response.failed",
					response: { status: "failed", error: { code: "fixture", message: "synthetic private sentinel" } },
				},
			],
			blocks: ["text"],
		},
		{
			name: "unfinished tool",
			events: [
				{ type: "response.output_item.added", output_index: 0, item: { ...toolItem, arguments: "" } },
				completed([toolItem]),
			],
			blocks: ["toolCall"],
		},
	])("keeps $name separate from successful final", async ({ events, blocks }) => {
		responses = [events];
		await h.session.prompt("failure fixture");
		expect(trace).toContainEqual({ stage: "message", stop: "error", blocks });
		expect(trace).toContainEqual({ stage: "boundary", outcome: "error", continue: false, pending: 0 });
		expect(executions).toBe(0);
		expect(requests).toBe(1);
		expect(JSON.stringify(trace)).not.toContain("sentinel");
	});
});
