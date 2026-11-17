/** Local-only subagent accounting. Reuses stats parsing/dedup, never writes its cache or exports transcripts. */
import { dirname, resolve } from "node:path";
import { feedFile, listJsonl, type ScanDiagnostic, timeOf } from "./jsonl.ts";
import { type Call, type FileStats, flatten, legacyKey, opaqueId, SessionParser } from "./load.ts";
import { nth } from "./nth.ts";

/** History cannot prove a review was required: these labels describe explicit prompt evidence only. */
export type Traffic =
	| "review-standards"
	| "review-spec"
	| "review-critic"
	| "retry-repeat"
	| "other"
	| "review-unknown";
interface Attribution {
	agentType: string;
	workflow: string;
	traffic: Traffic;
}
interface Price {
	recordedCost: number;
	pricedCalls: number;
	unpricedCalls: number;
}
export interface AgentTotals extends Price {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
export interface AgentGroup extends AgentTotals, Attribution {
	provider: string;
	model: string;
	unmatchedSessions: number;
	/** False means recordedCost is only the priced subtotal, not a complete price. */
	costComplete: boolean;
}
export interface SubagentReport {
	groups: AgentGroup[];
	totals: AgentTotals;
	unmatchedSessions: number;
	missingSessions: number;
	errors: number;
	badLines: number;
	diagnostics: ScanDiagnostic[];
	omittedGroups: number;
	complete: boolean;
}
interface Dispatch {
	ms: number;
	type: string;
	prompt: string;
	resume: boolean;
}
interface Metadata {
	path: string;
	session: string;
	parent: string;
	name: string;
	child: boolean;
	startMs: number;
}

/** Treat arbitrary JSON values as objects only after checking their shape. */
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
/** Only finite nonnegative numbers can contribute to accounting. */
function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
/** Local labels are bounded and terminal-safe; opaque joins always use the original values. */
function label(value: unknown, fallback = "unknown"): string {
	if (typeof value !== "string" || !value) return fallback;
	const safe = value.replace(/[\p{Cc}\p{Cf}]/gu, "?");
	return safe.length <= 120 ? safe : `${safe.slice(0, 90)}#${opaqueId(value).slice(0, 16)}`;
}
/** Match core's pricedCallsOf/unpricedCallsOf, with absent cost explicitly unknown rather than free. */
function price(value: unknown): Price {
	const cost = object(value);
	if (cost.unpriced === true)
		return {
			recordedCost: amount(cost.total),
			pricedCalls: amount(cost.pricedCalls ?? (amount(cost.total) > 0 ? 1 : 0)),
			unpricedCalls: Math.max(1, amount(cost.unpricedCalls ?? 1)),
		};
	if (typeof value === "number" && Number.isFinite(value) && value >= 0)
		return { recordedCost: value, pricedCalls: 1, unpricedCalls: 0 };
	if (typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0)
		return { recordedCost: cost.total, pricedCalls: 1, unpricedCalls: 0 };
	return { recordedCost: 0, pricedCalls: 0, unpricedCalls: 1 };
}
/** Shared dedup identity, including physical model/tokens even when an entry has a preserved ID. */
function identity(call: Call): string {
	return JSON.stringify([call.entryId, legacyKey(call)]);
}
/** Zeroed totals are explicit so JSON consumers can distinguish absent groups from zero usage. */
function zero(): AgentTotals {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		recordedCost: 0,
		pricedCalls: 0,
		unpricedCalls: 0,
	};
}
/** Sum tokens and prices separately. Counts are never used as cost shares. */
function add(total: AgentTotals, call: Call, cost: Price): void {
	total.calls++;
	total.input += call.input;
	total.output += call.output;
	total.cacheRead += call.cacheRead;
	total.cacheWrite += call.cacheWrite;
	total.recordedCost += cost.recordedCost;
	total.pricedCalls += cost.pricedCalls;
	total.unpricedCalls += cost.unpricedCalls;
}

/**
 * Re-read original local session metadata, joining child names/record IDs and Agent result IDs.
 * Unrecorded workflow and review purpose remain unknown; no prompt or parent usage is billed.
 * Output is at most 200 groups (all-group totals remain explicit) and 20 diagnostics.
 */
export async function reportSubagents(root: string): Promise<SubagentReport> {
	const diagnostics: ScanDiagnostic[] = [];
	const diagnose = (d: ScanDiagnostic): void => {
		if (diagnostics.length < 20) diagnostics.push(d);
	};
	const listed = await listJsonl(resolve(root), diagnose);
	const files: Record<string, FileStats> = {};
	const metadata: Metadata[] = [];
	const prices = new Map<string, Price>();
	const dispatches = new Map<string, Dispatch>();
	const results: { parent: string; call: string; id: string }[] = [];
	const records: { parent: string; id: string; type: string; path: string }[] = [];
	const workflows = new Map<string, string>();
	let errors = listed.errors;
	for (const path of listed.paths) {
		const parser = new SessionParser(0, 0);
		const rawPrices: Price[] = [];
		let parent = "";
		let name = "";
		let badLines = 0;
		let lineNumber = 0;
		try {
			await feedFile(path, {
				accept(line) {
					lineNumber++;
					const before = parser.finish().calls.length;
					parser.accept(line);
					let entry: Record<string, unknown>;
					try {
						entry = object(JSON.parse(line));
					} catch {
						if (line && !/^\0+$/.test(line)) {
							badLines++;
							diagnose({ path, line: lineNumber, reason: "invalid-record" });
						}
						return;
					}
					const message = object(entry.message);
					if (parser.finish().calls.length > before) rawPrices.push(price(object(message.usage).cost));
					if (entry.type === "session") {
						parent = typeof entry.parentSession === "string" ? resolve(dirname(path), entry.parentSession) : "";
					}
					if (entry.type === "session_info" && !name && typeof entry.name === "string") name = entry.name;
					if (entry.customType === "subagents:record") {
						const data = object(entry.data);
						if (typeof data.id === "string")
							records.push({
								parent: path,
								id: data.id,
								type: label(data.type),
								path: typeof data.sessionFile === "string" ? resolve(dirname(path), data.sessionFile) : "",
							});
					}
					// Persisted native workflow progress contains stable manager record IDs, not just wf-agent-N handles.
					const data = entry.customType === "subagents:workflow" ? object(entry.data) : object(message.details);
					if (Array.isArray(data.progress))
						for (const item of data.progress) {
							const row = object(item);
							if (typeof row.recordId === "string")
								workflows.set(`${path}\0${row.recordId.slice(0, 8)}`, label(data.name));
						}
					if (message.role === "assistant" && Array.isArray(message.content))
						for (const item of message.content) {
							const tool = object(item);
							if (tool.type !== "toolCall" || tool.name !== "Agent" || typeof tool.id !== "string") continue;
							const args = object(tool.arguments);
							dispatches.set(`${path}\0${tool.id}`, {
								ms: timeOf(entry.timestamp),
								type: label(args.subagent_type),
								prompt: typeof args.prompt === "string" ? args.prompt : "",
								resume: typeof args.resume === "string",
							});
						}
					if (message.role === "toolResult" && message.toolName === "Agent" && typeof message.toolCallId === "string") {
						const details = object(message.details);
						const text = Array.isArray(message.content) ? message.content.map((c) => object(c).text).join("\n") : "";
						const id =
							typeof details.agentId === "string" ? details.agentId : /Agent ID: ([a-zA-Z0-9-]+)/.exec(text)?.[1];
						if (id) results.push({ parent: path, call: message.toolCallId, id });
					}
				},
			});
		} catch {
			errors++;
			diagnose({ path, line: 0, reason: "read-file" });
		}
		const parsed = parser.finish();
		// Full JSON validation catches damaged non-usage entries the fast stats parser deliberately skips.
		parsed.badLines = Math.max(parsed.badLines, badLines);
		files[path] = parsed;
		metadata.push({
			path,
			session: parsed.sessionId ?? opaqueId(`legacy-session:${path}`),
			parent,
			name,
			child: parsed.child,
			startMs: parsed.startMs,
		});
		for (const [index, tuple] of parsed.calls.entries()) {
			const own = flatten({
				[path]: { ...parsed, calls: [tuple], entryIds: [nth(parsed.entryIds as (string | null)[], index)] },
			});
			const call = nth(own.calls, 0);
			if (!prices.has(identity(call))) prices.set(identity(call), nth(rawPrices, index));
		}
	}
	const dispatchByAgent = new Map<string, Dispatch[]>();
	for (const result of results) {
		const dispatch = dispatches.get(`${result.parent}\0${result.call}`);
		if (dispatch) {
			const key = `${result.parent}\0${result.id.slice(0, 8)}`;
			const timeline = dispatchByAgent.get(key) ?? [];
			timeline.push(dispatch);
			dispatchByAgent.set(key, timeline);
		}
	}
	const recordByAgent = new Map(records.map((r) => [`${r.parent}\0${r.id.slice(0, 8)}`, r]));
	const attributes = new Map<string, (Attribution & { ms: number })[]>();
	const unmatched = new Set<string>();
	const reviewSeen = new Set<string>();
	const paths = new Set(listed.paths);
	const matchedRecords = new Set<string>();
	for (const meta of metadata.sort((a, b) => a.startMs - b.startMs || a.path.localeCompare(b.path))) {
		const match = /^(.*)#([0-9a-f]{8})$/.exec(meta.name);
		const byPath = records.find((r) => r.path === meta.path);
		if ((!meta.child && !byPath) || attributes.has(meta.session)) continue;
		const key = `${meta.parent}\0${byPath?.id.slice(0, 8) ?? match?.[2]}`;
		const record = byPath ?? recordByAgent.get(key);
		if (record) matchedRecords.add(`${record.parent}\0${record.id.slice(0, 8)}`);
		if (match) matchedRecords.add(`${meta.parent}\0${match[2]}`);
		const dispatches = dispatchByAgent.get(key) ?? [];
		const type = label(record?.type ?? dispatches[0]?.type ?? match?.[1]);
		const base: Attribution = {
			agentType: type,
			workflow: workflows.get(key) ?? "unknown",
			traffic: type === "critic" ? "review-critic" : type === "code-reviewer" ? "review-unknown" : "other",
		};
		const timeline = [{ ...base, ms: 0 }];
		for (const dispatch of dispatches.sort((a, b) => a.ms - b.ms)) {
			const prompt = dispatch.prompt;
			let traffic = base.traffic;
			if (type === "code-reviewer" && /\baxis\s*:\s*standards\b/i.test(prompt)) traffic = "review-standards";
			if (type === "code-reviewer" && /\baxis\s*:\s*spec\b/i.test(prompt)) traffic = "review-spec";
			// Last full SHA is conventionally HEAD, not the original merge base.
			const target = prompt.match(/\b[0-9a-f]{40}\b/g)?.at(-1);
			const review = JSON.stringify([meta.parent, type, traffic, target]);
			if (dispatch.resume || (target && traffic.startsWith("review-") && reviewSeen.has(review)))
				traffic = "retry-repeat";
			reviewSeen.add(review);
			timeline.push({ ...base, traffic, ms: dispatch.ms });
		}
		if (type === "unknown") unmatched.add(meta.session);
		attributes.set(meta.session, timeline);
	}
	const loaded = flatten(files);
	const groups = new Map<string, AgentGroup>();
	const groupUnmatched = new Map<string, Set<string>>();
	const totals = zero();
	for (const call of loaded.calls) {
		const timeline = attributes.get(call.session);
		if (!timeline) continue;
		const eligible = timeline.filter((row) => row.ms <= call.ms);
		const { ms: _ms, ...attr } = nth(eligible, eligible.length - 1);
		const provider = label(call.provider);
		const model = label(call.model);
		const key = JSON.stringify([attr.agentType, provider, model, attr.workflow, attr.traffic]);
		let group = groups.get(key);
		if (!group) {
			group = { ...zero(), ...attr, provider, model, unmatchedSessions: 0, costComplete: true };
			groups.set(key, group);
			groupUnmatched.set(key, new Set());
		}
		// Every retained call was parsed above; dedup only removes candidates.
		const cost = prices.get(identity(call)) as Price;
		add(group, call, cost);
		add(totals, call, cost);
		const sessions = groupUnmatched.get(key) as Set<string>;
		if (unmatched.has(call.session)) sessions.add(call.session);
		group.unmatchedSessions = sessions.size;
		group.costComplete &&= cost.unpricedCalls === 0;
	}
	const referenced = [...records, ...results.map((row) => ({ ...row, path: "" }))];
	const missing = new Set(
		referenced
			.filter((r) => !matchedRecords.has(`${r.parent}\0${r.id.slice(0, 8)}`) && (!r.path || !paths.has(r.path)))
			.map((r) => `${r.parent}\0${r.id.slice(0, 8)}`),
	);
	// Map keys are unique, so the comparator never receives equal values.
	const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, group]) => group);
	return {
		groups: ordered.slice(0, 200),
		totals,
		unmatchedSessions: unmatched.size + missing.size,
		missingSessions: missing.size,
		errors,
		badLines: loaded.badLines,
		diagnostics,
		omittedGroups: Math.max(0, ordered.length - 200),
		complete:
			errors === 0 && loaded.badLines === 0 && unmatched.size === 0 && missing.size === 0 && totals.unpricedCalls === 0,
	};
}
