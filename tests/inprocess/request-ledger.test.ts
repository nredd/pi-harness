/** Real SDK requests with scripted replies. No provider adapter or fork testing exports. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { outcomes } from "@nredd/pi-test-lib/faux";
import {
	createHarness,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "@nredd/pi-test-lib/harness";
import { expect, it } from "vitest";
import { isolateStackHome, loadFork } from "./support.ts";

type Owners = Record<string, string>;
type Capture = { session: "parent" | "child"; raw: string; owners: Owners };
type Row = {
	session: Capture["session"];
	synthetic: { usage: "faux, not reported" };
	measurement: "utf8_sdk_context_bytes";
	model: string;
	tool_array_sha256: string;
	token_estimates: null;
	request_bytes: number;
	buckets: Record<string, number>;
	common_prefix_previous_bytes: number | null;
	common_prefix_parent_bytes: number | null;
	cache_markers: unknown[];
};

const INTEGRATION = new URL("../integration/", import.meta.url);
const OLD = "Old history to replace: 🦩";
const SUMMARY = "Scripted replacement summary";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reject malformed subprocess output before the assertions or artifact writer use it. */
function isRow(row: unknown): row is Row {
	return (
		isRecord(row) &&
		(row.session === "parent" || row.session === "child") &&
		isRecord(row.synthetic) &&
		row.synthetic.usage === "faux, not reported" &&
		row.measurement === "utf8_sdk_context_bytes" &&
		typeof row.model === "string" &&
		typeof row.tool_array_sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(row.tool_array_sha256) &&
		row.token_estimates === null &&
		isByteCount(row.request_bytes) &&
		isRecord(row.buckets) &&
		Object.values(row.buckets).every(isByteCount) &&
		(row.common_prefix_previous_bytes === null || isByteCount(row.common_prefix_previous_bytes)) &&
		(row.common_prefix_parent_bytes === null || isByteCount(row.common_prefix_parent_bytes)) &&
		Array.isArray(row.cache_markers) &&
		row.cache_markers.length === 0
	);
}

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
    row = ledger.request_ledger(raw, sdk=True, owners=owners, previous=previous.get(session),
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
function recorder(sink: Capture[], session: Capture["session"], owners: () => Owners) {
	return (response: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
		(context, _options, _state, model) => {
			const messages = context.messages.map((message) => {
				if (message.role !== "assistant") return message;
				const { usage: _synthetic, ...rest } = message;
				return rest;
			});
			const raw = JSON.stringify({ model: model.id, messages });
			sink.push({ session, raw, owners: owners() });
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

/** Drive a real foreground `Agent` call and a manual compaction with a faux summary. */
async function capture(): Promise<{ original: Capture[]; normalized: Capture[] }> {
	const home = await isolateStackHome();
	const provider = registerFauxProvider({ api: "ledger-faux", models: [{ id: "ledger" }] });
	let session: AgentSession | undefined;
	let cleanup: (() => void) | undefined;
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
			extensionFactories: [await loadFork("pi-subagents")],
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
		const parent = recorder(original, "parent", () =>
			Object.fromEntries(h.session.getAllTools().map(({ name, sourceInfo }) => [name, sourceInfo.source])),
		);
		const child = recorder(original, "child", () =>
			JSON.parse(readFileSync(join(cwd, "ledger-child-owners.json"), "utf8")),
		);
		h.setResponses([parent(fauxAssistantMessage([fauxThinking("plan"), { type: "text", text: "Prior answer" }]))]);
		await session.prompt(OLD);
		h.setResponses([parent(fauxAssistantMessage("Keep this turn"))]);
		await session.prompt("Recent history");
		h.setResponses([parent(fauxAssistantMessage(SUMMARY)), parent(fauxAssistantMessage("Scripted turn prefix"))]);
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
							prompt: "Report fixture",
							model: `${model.provider}/${model.id}`,
							run_in_background: false,
						},
						{ id: "ledger-call" },
					),
					{ stopReason: "toolUse" },
				),
			),
			child(fauxAssistantMessage("Child answer")),
			parent(fauxAssistantMessage("Parent finished")),
		]);
		await session.prompt("Spawn the child");
		expect(outcomes(h, "Agent")).toEqual([{ isError: false, text: expect.stringContaining("Child answer") }]);
		expect(h.getPendingResponseCount()).toBe(0);
		const resolvedRoot = realpathSync(home.root);
		return {
			original,
			normalized: original.map(({ raw, ...rest }) => ({ ...rest, raw: normalize(raw, home.root, resolvedRoot) })),
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
		expect(rows[4]?.buckets.compaction_summary).toBe(204);
		expect(rows[4]?.buckets["tool:Agent:owner:inline"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:read:owner:builtin"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:SubagentWorkflow:owner:sdk"]).toBeGreaterThan(0);
		expect(rows[5]?.buckets["tool:Agent:owner:inline"]).toBeUndefined();
		expect(rows[5]?.common_prefix_parent_bytes).toBeGreaterThan(0);
		expect(rows[5]?.common_prefix_previous_bytes).toBeNull();
		expect(rows[6]?.buckets["tool_call_args:Agent"]).toBeGreaterThan(0);
		expect(rows[6]?.buckets["tool_result:Agent"]).toBeGreaterThan(0);
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
