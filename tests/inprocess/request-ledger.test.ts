/** Real SDK requests with scripted replies. No provider adapter or fork testing exports. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outcomes } from "@nredd/pi-test-lib/faux";
import {
	createHarness,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@nredd/pi-test-lib/harness";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { isolateStackHome, loadFork } from "./support.ts";

const ByteCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const PrefixBytes = Type.Union([ByteCount, Type.Null()]);
const RowSchema = Type.Object({
	session: Type.Union([Type.Literal("parent"), Type.Literal("child")]),
	synthetic: Type.Object({ usage: Type.Literal("faux, not reported") }),
	measurement: Type.Literal("utf8_sdk_context_bytes"),
	model: Type.String(),
	tool_array_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	token_estimates: Type.Null(),
	request_bytes: ByteCount,
	// Match all keys, including line breaks, so no bucket value escapes validation.
	buckets: Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), ByteCount),
	common_prefix_previous_bytes: PrefixBytes,
	common_prefix_parent_bytes: PrefixBytes,
	cache_markers: Type.Tuple([]),
});
type Row = Static<typeof RowSchema>;
type Owners = Record<string, string>;
/** Exact text (`provenance`) or exact leading text (`prefixes`) -> ledger category. */
type Categories = Record<string, string>;
type Capture = {
	session: Row["session"];
	raw: string;
	owners: Owners;
	provenance: Categories;
	prefixes: Categories;
};

const INTEGRATION = new URL("../integration/", import.meta.url);
const OLD = "Old history to replace: 🦩";
const SUMMARY = "Scripted replacement summary";
const TURN_PREFIX = "Scripted turn prefix";
const SPAWN = "Spawn the child";
const CHILD_PROMPT = "Report fixture";
const NOTE_TYPE = "ledger-fixture";
const NOTE = "Fixture extension note";
const WRAPPED_SUMMARY =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n" +
	`${SUMMARY}\n\n---\n\n**Turn Context (split turn):**\n\n${TURN_PREFIX}\n</summary>`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject malformed subprocess output before the assertions or artifact writer use it. */
function isRow(row: unknown): row is Row {
	return Check(RowSchema, row);
}

// A valid first parent row; change one field at a time so another guard can't mask a regression.
const validRow: Row = {
	session: "parent",
	synthetic: { usage: "faux, not reported" },
	measurement: "utf8_sdk_context_bytes",
	model: "ledger",
	tool_array_sha256: "ab".repeat(32),
	token_estimates: null,
	request_bytes: 20,
	buckets: { shared: 0, serialization_overhead: 20 },
	common_prefix_previous_bytes: null,
	common_prefix_parent_bytes: null,
	cache_markers: [],
};

it.each([
	["null row", null],
	["unexpected session", { ...validRow, session: "peer" }],
	["missing synthetic object", { ...validRow, synthetic: undefined }],
	["reported usage", { ...validRow, synthetic: { usage: "reported" } }],
	["wire measurement", { ...validRow, measurement: "utf8_wire_bytes" }],
	["missing model", { ...validRow, model: undefined }],
	["non-string hash", { ...validRow, tool_array_sha256: [validRow.tool_array_sha256] }],
	["short hash", { ...validRow, tool_array_sha256: "a".repeat(63) }],
	["non-hex hash", { ...validRow, tool_array_sha256: "g".repeat(64) }],
	["reported tokens", { ...validRow, token_estimates: 1 }],
	["negative request bytes", { ...validRow, request_bytes: -1 }],
	["string request bytes", { ...validRow, request_bytes: "20" }],
	["array buckets", { ...validRow, buckets: [20] }],
	["fractional bucket bytes", { ...validRow, buckets: { shared: 0, serialization_overhead: 19.5 } }],
	["invalid bucket bytes under a multiline key", { ...validRow, buckets: { "tool_result:line\nbreak": "20" } }],
	["unsafe previous prefix bytes", { ...validRow, common_prefix_previous_bytes: Number.MAX_SAFE_INTEGER + 1 }],
	["missing parent prefix bytes", { ...validRow, common_prefix_parent_bytes: undefined }],
	["non-array cache markers", { ...validRow, cache_markers: "" }],
	["nonempty cache markers", { ...validRow, cache_markers: [{ path: ["tools", 0], bytes_through_block: 20 }] }],
] as const)("rejects a malformed SDK ledger row: %s", (_label, row) => {
	expect(isRow(validRow)).toBe(true);
	expect(isRow(row)).toBe(false);
});

/** Call the same byte partitioner as the wire scenario, in one batch and without extra dependencies. */
function measure(captures: Capture[]): Row[] {
	const rows = execFileSync(
		"python3",
		[
			"-B",
			"-c",
			`import json, sys
from pathlib import Path
from harness import request_ledger as ledger

root = Path(ledger.__file__).resolve().parents[3]
previous = {}
for item in json.load(sys.stdin):
    raw, session = item["raw"], item["session"]
    owners = {name: ledger.stable_owner(source, root) for name, source in item["owners"].items()}
    row = ledger.request_ledger(raw, sdk=True, owners=owners, provenance=item["provenance"],
                         prefixes=item["prefixes"], previous=previous.get(session),
                         parent=previous["parent"] if session == "child" else None)
    print(json.dumps({"session": session, **row, "synthetic": {"usage": "faux, not reported"}}))
    previous[session] = raw`,
		],
		{ cwd: INTEGRATION, input: JSON.stringify(captures), encoding: "utf8", timeout: 10_000 },
	);
	return rows
		.trimEnd()
		.split("\n")
		.map((line, index) => {
			const row: unknown = JSON.parse(line);
			if (!isRow(row) || row.session !== captures[index]?.session) {
				throw new Error(`Invalid SDK ledger row ${index}`);
			}
			return row;
		});
}

/** Capture only model id and transcript; keep prior faux usage out of the measured body. */
function recorder(
	sink: Capture[],
	session: Capture["session"],
	owners: () => Owners,
	provenance: () => Categories = () => ({}),
) {
	return (response: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
		(context, _options, _state, model) => {
			const messages = context.messages.map((message) => {
				if (message.role !== "assistant") return message;
				const { usage: _synthetic, ...rest } = message;
				return rest;
			});
			const raw = JSON.stringify({ model: model.id, messages });
			sink.push({ session, raw, owners: owners(), provenance: provenance(), prefixes: {} });
			return response;
		};
}

/** Keep only nondeterministic metadata out of the second, comparison-only measurement. */
function normalize(raw: string, root: string, resolvedRoot: string): string {
	// Decode first so JSON escape spellings do not matter. Only strip timing
	// properties on messages, not identically named application data in tool args.
	const body: { model: string; messages: Record<string, unknown>[] } = JSON.parse(raw, (_key, value: unknown) =>
		typeof value === "string" ? value.replaceAll(resolvedRoot, "/sandbox").replaceAll(root, "/sandbox") : value,
	);
	const messages = body.messages.map(({ timestamp: _timestamp, durationMs: _durationMs, ...message }) => {
		if (message.role !== "toolResult" || message.toolName !== "Agent") return message;
		// The foreground tool puts elapsed time in both its details and its result text.
		if (isRecord(message.details)) {
			const { durationMs: _elapsed, ...details } = message.details;
			message.details = details;
		}
		if (Array.isArray(message.content)) {
			message.content = message.content.map((block: unknown) =>
				isRecord(block) && block.type === "text" && typeof block.text === "string"
					? { ...block, text: block.text.replace(/Agent completed in \d+\.\d+s/, "Agent completed in 0.0s") }
					: block,
			);
		}
		return message;
	});
	return JSON.stringify({ ...body, messages });
}

it("normalizes escaped and resolved sandbox paths and timing in any position", () => {
	const root = '/var/tmp/ledger"fixture';
	const resolvedRoot = `/private${root}`;
	const raw = String.raw`{"model":"ledger","messages":[{"timestamp":7,"content":"\/private\/var\/tmp\/ledger\u0022fixture/a","durationMs":3},{"role":"user","durationMs":2,"content":"/var/tmp/ledger\"fixture/b","timestamp":5},{"content":{"timestamp":4}}]}`;
	expect(normalize(raw, root, resolvedRoot)).toBe(
		'{"model":"ledger","messages":[{"content":"/sandbox/a"},{"role":"user","content":"/sandbox/b"},{"content":{"timestamp":4}}]}',
	);
});

it("normalizes only Agent tool result elapsed time and preserves result data", () => {
	const agentResult = {
		role: "toolResult",
		toolName: "Agent",
		timestamp: 8,
		details: { durationMs: 1420, child: "ledger-child", data: { durationMs: 7 } },
		content: [
			{ type: "text", text: "Agent completed in 1.42s\nChild answer" },
			{ type: "image", data: "fixture", mimeType: "image/png" },
		],
	};
	const otherResult = {
		role: "toolResult",
		toolName: "read",
		details: { durationMs: 15 },
		content: [{ type: "text", text: "Agent completed in 2.5s" }],
	};
	const user = { role: "user", toolName: "Agent", content: [{ type: "text", text: "Agent completed in 3.0s" }] };
	const raw = JSON.stringify({ model: "ledger", messages: [agentResult, otherResult, user] });
	expect(JSON.parse(normalize(raw, "/fixture", "/private/fixture"))).toEqual({
		model: "ledger",
		messages: [
			{
				role: "toolResult",
				toolName: "Agent",
				details: { child: "ledger-child", data: { durationMs: 7 } },
				content: [{ type: "text", text: "Agent completed in 0.0s\nChild answer" }, agentResult.content[1]],
			},
			otherResult,
			user,
		],
	});
});

/**
 * Inject one extension message on the spawn turn and record exact custom-message provenance.
 * Registered after the subagents fork so its `context` handler sees the final transcript;
 * `convertToLlm` erases the custom type before the faux factory sees the request.
 */
function provenanceObserver(sink: { current: Categories }) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", (event) =>
			event.messageType === "user" && event.prompt === SPAWN
				? { message: { customType: NOTE_TYPE, content: NOTE, display: false } }
				: undefined,
		);
		pi.on("context", (event) => {
			sink.current = {};
			for (const message of event.messages) {
				if (message.role !== "custom") continue;
				const texts =
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
				for (const text of texts) sink.current[text] = `extension:${message.customType}`;
			}
		});
	};
}

/**
 * `inherit_context` prepends the parent conversation to the child's task prompt in one text block.
 * The caller knows the prompt it passed, so everything before it is exact inherited provenance.
 */
function inheritedPrefix(capture: Capture): Capture {
	if (capture.session !== "child") return capture;
	const body: { messages: { role: string; content: unknown }[] } = JSON.parse(capture.raw);
	const content = body.messages.find(({ role }) => role === "user")?.content;
	const block = Array.isArray(content) ? content[0] : undefined;
	const text: unknown = typeof content === "string" ? content : isRecord(block) ? block.text : undefined;
	if (typeof text !== "string" || !text.endsWith(CHILD_PROMPT) || text === CHILD_PROMPT) {
		throw new Error("Child task prompt does not follow inherited parent context");
	}
	return { ...capture, prefixes: { [text.slice(0, -CHILD_PROMPT.length)]: "inherited_context" } };
}

/** Size of `text` as a JSON string payload, including escapes but not the enclosing quotes. */
function escapedBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text).slice(1, -1));
}

it.each([
	["a parent capture unchanged", { role: "user", content: "anything" }, "parent", undefined],
	["string content", { role: "user", content: `ctx\n${CHILD_PROMPT}` }, "child", "ctx\n"],
	["text block content", { role: "user", content: [{ type: "text", text: `ctx${CHILD_PROMPT}` }] }, "child", "ctx"],
	["no inherited context", { role: "user", content: CHILD_PROMPT }, "child", null],
	["a different task", { role: "user", content: "ctx other" }, "child", null],
	["a non-text first block", { role: "user", content: [{ type: "image" }] }, "child", null],
	["a non-object first block", { role: "user", content: ["ctx"] }, "child", null],
	["no user message", { role: "assistant", content: "ctx" }, "child", null],
] as const)("derives inherited child context from %s", (_label, message, session, expected) => {
	const capture: Capture = {
		session,
		raw: JSON.stringify({ model: "ledger", messages: [message] }),
		owners: {},
		provenance: {},
		prefixes: {},
	};
	if (expected === null) {
		expect(() => inheritedPrefix(capture)).toThrow("Child task prompt does not follow inherited parent context");
	} else {
		expect(inheritedPrefix(capture).prefixes).toEqual(
			expected === undefined ? {} : { [expected]: "inherited_context" },
		);
	}
});

/** Drive a real foreground `Agent` call and a manual compaction with a faux summary. */
async function capture(): Promise<{ original: Capture[]; normalized: Capture[] }> {
	const home = await isolateStackHome();
	const provider = registerFauxProvider({ api: "ledger-faux", models: [{ id: "ledger" }] });
	let session: AgentSession | undefined;
	let cleanup: (() => void) | undefined;
	const observed: { current: Categories } = { current: {} };
	try {
		const agentDir = join(home.root, "agent");
		const agents = join(agentDir, "agents");
		const cwd = join(home.root, "work");
		mkdirSync(agents, { recursive: true });
		mkdirSync(cwd);
		writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ rememberAgents: false, widgetMode: "off" }));
		const probe = fileURLToPath(new URL("fixtures/ledger-child.ts", import.meta.url));
		writeFileSync(
			join(agents, "ledger-child.md"),
			`---\nname: ledger-child\ndescription: Ledger fixture\ntools: read\nextensions: [${JSON.stringify(probe)}]\n---\nRead-only ledger fixture.\n`,
		);
		const h = await createHarness({
			cwd,
			fauxProvider: provider,
			useModelRuntimeStream: true,
			extensionFactories: [await loadFork("pi-subagents"), provenanceObserver(observed)],
			settings: {
				retry: { enabled: false },
				compaction: { enabled: false, keepRecentTokens: 1 },
			},
		});
		session = h.session;
		cleanup = h.cleanup;
		await session.bindExtensions({ mode: "print" });
		const model = provider.getModel();
		const original: Capture[] = [];
		const parent = recorder(
			original,
			"parent",
			() => Object.fromEntries(h.session.getAllTools().map(({ name, sourceInfo }) => [name, sourceInfo.source])),
			() => observed.current,
		);
		const child = recorder(original, "child", () =>
			JSON.parse(readFileSync(join(cwd, "ledger-child-owners.json"), "utf8")),
		);
		h.setResponses([parent(fauxAssistantMessage([fauxThinking("plan"), { type: "text", text: "Prior answer" }]))]);
		await session.prompt(OLD);
		h.setResponses([parent(fauxAssistantMessage("Keep this turn"))]);
		await session.prompt("Recent history");
		h.setResponses([parent(fauxAssistantMessage(SUMMARY)), parent(fauxAssistantMessage(TURN_PREFIX))]);
		expect((await session.compact()).summary).toContain(SUMMARY);
		expect(h.getPendingResponseCount()).toBe(0);

		h.setResponses([
			parent(
				fauxAssistantMessage(
					fauxToolCall(
						"Agent",
						{
							subagent_type: "ledger-child",
							description: "Record child",
							prompt: CHILD_PROMPT,
							model: `${model.provider}/${model.id}`,
							run_in_background: false,
							inherit_context: true,
						},
						{ id: "ledger-call" },
					),
					{ stopReason: "toolUse" },
				),
			),
			child(fauxAssistantMessage("Child answer")),
			parent(fauxAssistantMessage("Parent finished")),
		]);
		await session.prompt(SPAWN);
		expect(outcomes(h, "Agent")).toEqual([{ isError: false, text: expect.stringContaining("Child answer") }]);
		expect(h.getPendingResponseCount()).toBe(0);
		const resolvedRoot = realpathSync(home.root);
		return {
			original: original.map(inheritedPrefix),
			normalized: original.map(({ raw, ...rest }) =>
				inheritedPrefix({ ...rest, raw: normalize(raw, home.root, resolvedRoot) }),
			),
		};
	} finally {
		try {
			await session?.abort();
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			cleanup?.();
			provider.unregister();
			await home.cleanup();
		}
	}
}

it("accounts for compacted history and the actual spawned child's registry", async () => {
	const runs = [await capture(), await capture()];
	const stable = runs.map(({ normalized }) => measure(normalized));
	expect(stable[0]).toEqual(stable[1]);
	const rows = runs.flatMap(({ original }, run) => {
		const rows = measure(original);
		expect(original.map(({ session }) => session)).toEqual([
			"parent",
			"parent",
			"parent",
			"parent",
			"parent",
			"child",
			"parent",
		]);
		for (const [index, request] of original.entries()) {
			const row = rows[index];
			if (!row) throw new Error(`Missing ledger row ${index}`);
			expect(row.measurement).toBe("utf8_sdk_context_bytes");
			expect(row.cache_markers).toEqual([]);
			expect(row.request_bytes).toBe(Buffer.byteLength(request.raw));
			expect(Object.values(row.buckets).reduce((a, b) => a + b, 0)).toBe(row.request_bytes);
			expect(
				Object.keys(row.buckets).filter((key) => key.startsWith("tool:") && key.endsWith(":owner:unknown")),
			).toEqual([]);
		}
		expect(original[1]?.raw).toContain(OLD);
		expect(original[4]?.raw).not.toContain(OLD);
		expect(original[4]?.raw).toContain(SUMMARY);
		// Pin the core wrapper and split-turn text independently of the captured request.
		// The bucket includes JSON escapes (e.g. `\\n`) but not the enclosing quotes.
		const summaryBytes = Buffer.byteLength(JSON.stringify(WRAPPED_SUMMARY).slice(1, -1));
		// A wrapper wording change in core (the `compaction` summary prefix) must be a deliberate edit here too.
		expect(summaryBytes, "core compaction wrapper wording changed: update WRAPPED_SUMMARY and this pin").toBe(204);
		expect(rows[4]?.buckets.compaction_summary, "escaped compaction summary text, excluding JSON quotes").toBe(
			summaryBytes,
		);
		expect(rows[4]?.buckets["tool:Agent:owner:inline"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:read:owner:builtin"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:SubagentWorkflow:owner:sdk"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:Agent:owner:inline"]).toBeUndefined();
		expect(rows[5]?.common_prefix_parent_bytes).toBeGreaterThan(0);
		expect(rows[5]?.common_prefix_previous_bytes).toBeNull();
		expect(rows[6]?.buckets["tool_call_args:Agent"]).toBeGreaterThan(0);
		expect(rows[6]?.buckets["tool_result:Agent"]).toBeGreaterThan(0);
		// The extension message is a user message by the time the factory sees it; only provenance names it.
		for (const index of [4, 6]) {
			expect(original[index]?.provenance).toEqual({ [NOTE]: `extension:${NOTE_TYPE}` });
			expect(rows[index]?.buckets[`extension:${NOTE_TYPE}`]).toBe(escapedBytes(NOTE));
		}
		expect(rows[3]?.buckets[`extension:${NOTE_TYPE}`]).toBeUndefined();
		// The child's single user block is the parent's rendered history, then the task prompt.
		const [inherited, category] = Object.entries(original[5]?.prefixes ?? {})[0] ?? [];
		expect(category).toBe("inherited_context");
		expect(inherited).toMatch(/^# Parent Conversation Context\n/);
		expect(inherited).toContain(`[Summary]: ${SUMMARY}`);
		expect(inherited).toContain(`[User]: ${SPAWN}`);
		expect(rows[5]?.buckets.inherited_context).toBe(escapedBytes(inherited ?? ""));
		expect(rows[5]?.buckets.user).toBe(Buffer.byteLength(CHILD_PROMPT));
		return rows.map((row, request) => ({ run, request, ...row }));
	});
	const artifacts = new URL("artifacts/", INTEGRATION);
	mkdirSync(artifacts, { recursive: true });
	const runtime = process.versions.bun ? "bun" : "node";
	writeFileSync(
		new URL(`request-ledger-sdk-${runtime}.jsonl`, artifacts),
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
});
