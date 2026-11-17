/** Local-only subagent accounting. Reuses stats parsing/dedup, never writes its cache or exports transcripts. */
import { dirname, resolve } from "node:path";
import { feedFile, listJsonl, type ScanDiagnostic, timeOf } from "./jsonl.ts";
import { type Call, type CallTuple, type FileStats, flatten, legacyKey, opaqueId, SessionParser } from "./load.ts";
import { nth } from "./nth.ts";

/** Agent types the mandated review lanes use. Names are conventions, not recorded facts. */
const AGENT_CRITIC = "critic";
const AGENT_REVIEWER = "code-reviewer";
/** Review axis headers in the dispatch prompt: the only evidence of which lane a reviewer ran. */
const AXIS_STANDARDS = /\baxis\s*:\s*standards\b/i;
const AXIS_SPEC = /\baxis\s*:\s*spec\b/i;
/** Full SHAs in a prompt; the last one is conventionally the reviewed HEAD. */
const FULL_SHA = /\b[0-9a-f]{40}\b/g;
/** pi-subagents names child sessions `<agent type>#<8 hex>`. */
const CHILD_NAME = /^(.*)#([0-9a-f]{8})$/;
const AGENT_ID_TEXT = /Agent ID: ([a-zA-Z0-9-]+)/;
const NUL_LINE = /^\0+$/;
const MAX_GROUPS = 200;
const MAX_DIAGNOSTICS = 20;
/** No recorded price: unpriced, never free. */
const UNPRICED: Price = { recordedCost: 0, pricedCalls: 0, unpricedCalls: 1 };

/** Review lane and retry-repeat are INFERRED labels, see the README. History cannot prove a review was required: these labels describe explicit prompt evidence only. */
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
	/** Calls whose recorded price could not be bound to them exactly; counted unpriced, never guessed. */
	priceFallbacks: number;
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
	return UNPRICED;
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

interface Scan {
	files: Record<string, FileStats>;
	metadata: Metadata[];
	/** Dedup identity -> price bound to that exact parsed call. */
	prices: Map<string, Price>;
	dispatches: Map<string, Dispatch>;
	results: { parent: string; call: string; id: string }[];
	records: { parent: string; id: string; type: string; path: string }[];
	workflows: Map<string, string>;
	paths: Set<string>;
	diagnostics: ScanDiagnostic[];
	errors: number;
	priceFallbacks: number;
}
interface Timeline extends Attribution {
	ms: number;
}
interface Attributed {
	timelines: Map<string, Timeline[]>;
	unmatched: Set<string>;
	matchedRecords: Set<string>;
}

/** Record a bounded local diagnostic. */
function diagnose(scan: Scan, diagnostic: ScanDiagnostic): void {
	if (scan.diagnostics.length < MAX_DIAGNOSTICS) scan.diagnostics.push(diagnostic);
}

/** Collect join metadata from one already-parsed entry of the file at `path`. */
function collect(scan: Scan, path: string, entry: Record<string, unknown>): string {
	const message = object(entry.message);
	let parent = "";
	if (entry.type === "session" && typeof entry.parentSession === "string")
		parent = resolve(dirname(path), entry.parentSession);
	if (entry.customType === "subagents:record") {
		const data = object(entry.data);
		if (typeof data.id === "string")
			scan.records.push({
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
				scan.workflows.set(`${path}\0${row.recordId.slice(0, 8)}`, label(data.name));
		}
	if (message.role === "assistant" && Array.isArray(message.content))
		for (const item of message.content) {
			const tool = object(item);
			if (tool.type !== "toolCall" || tool.name !== "Agent" || typeof tool.id !== "string") continue;
			const args = object(tool.arguments);
			scan.dispatches.set(`${path}\0${tool.id}`, {
				ms: timeOf(entry.timestamp),
				type: label(args.subagent_type),
				prompt: typeof args.prompt === "string" ? args.prompt : "",
				resume: typeof args.resume === "string",
			});
		}
	if (message.role === "toolResult" && message.toolName === "Agent" && typeof message.toolCallId === "string") {
		const details = object(message.details);
		const text = Array.isArray(message.content) ? message.content.map((c) => object(c).text).join("\n") : "";
		const id = typeof details.agentId === "string" ? details.agentId : AGENT_ID_TEXT.exec(text)?.[1];
		if (id) scan.results.push({ parent: path, call: message.toolCallId, id });
	}
	return parent;
}

/** Scan one session file, parsing each line once and binding every price to its exact parsed call. */
async function scanFile(scan: Scan, path: string): Promise<void> {
	const recorded = new Map<CallTuple, Price>();
	const parser = new SessionParser(0, 0, undefined, (tuple, cost) => recorded.set(tuple, price(cost)));
	let parent = "";
	let name = "";
	let badLines = 0;
	let lineNumber = 0;
	try {
		await feedFile(path, {
			accept(line) {
				lineNumber++;
				let entry: Record<string, unknown> | undefined;
				try {
					const parsed: unknown = JSON.parse(line);
					if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
						entry = parsed as Record<string, unknown>;
				} catch {
					// Falls through to the damaged-line handling below.
				}
				if (entry === undefined) {
					// Let the shared parser count it too; blank and NUL crash padding are not damage.
					parser.accept(line);
					if (line && !NUL_LINE.test(line)) {
						badLines++;
						diagnose(scan, { path, line: lineNumber, reason: "invalid-record" });
					}
					return;
				}
				parser.acceptEntry(entry);
				parent = collect(scan, path, entry) || parent;
				if (entry.type === "session_info" && !name && typeof entry.name === "string") name = entry.name;
			},
		});
	} catch {
		scan.errors++;
		diagnose(scan, { path, line: 0, reason: "read-file" });
	}
	const parsed = parser.finish();
	// Full JSON validation catches damaged non-usage entries the fast stats parser deliberately skips.
	parsed.badLines = Math.max(parsed.badLines, badLines);
	scan.files[path] = parsed;
	scan.metadata.push({
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
		const bound = recorded.get(tuple);
		if (bound === undefined) {
			scan.priceFallbacks++;
			diagnose(scan, { path, line: 0, reason: "price-fallback" });
		}
		const id = identity(nth(own.calls, 0));
		if (!scan.prices.has(id)) scan.prices.set(id, bound ?? UNPRICED);
	}
}

/** Phase 1: read every original session file. */
async function scan(root: string): Promise<Scan> {
	const out: Scan = {
		files: {},
		metadata: [],
		prices: new Map(),
		dispatches: new Map(),
		results: [],
		records: [],
		workflows: new Map(),
		paths: new Set(),
		diagnostics: [],
		errors: 0,
		priceFallbacks: 0,
	};
	const listed = await listJsonl(resolve(root), (d) => diagnose(out, d));
	out.errors = listed.errors;
	out.paths = new Set(listed.paths);
	for (const path of listed.paths) await scanFile(out, path);
	return out;
}

/** Phase 2: attribute each child session to an agent type, workflow and traffic lane (heuristic labels). */
function attribute(scanned: Scan): Attributed {
	const dispatchByAgent = new Map<string, Dispatch[]>();
	for (const result of scanned.results) {
		const dispatch = scanned.dispatches.get(`${result.parent}\0${result.call}`);
		if (!dispatch) continue;
		const key = `${result.parent}\0${result.id.slice(0, 8)}`;
		dispatchByAgent.set(key, [...(dispatchByAgent.get(key) ?? []), dispatch]);
	}
	const recordByAgent = new Map(scanned.records.map((r) => [`${r.parent}\0${r.id.slice(0, 8)}`, r]));
	const out: Attributed = { timelines: new Map(), unmatched: new Set(), matchedRecords: new Set() };
	const reviewSeen = new Set<string>();
	const ordered = [...scanned.metadata].sort((a, b) => a.startMs - b.startMs || a.path.localeCompare(b.path));
	for (const meta of ordered) {
		const match = CHILD_NAME.exec(meta.name);
		const byPath = scanned.records.find((r) => r.path === meta.path);
		if ((!meta.child && !byPath) || out.timelines.has(meta.session)) continue;
		const key = `${meta.parent}\0${byPath?.id.slice(0, 8) ?? match?.[2]}`;
		const record = byPath ?? recordByAgent.get(key);
		if (record) out.matchedRecords.add(`${record.parent}\0${record.id.slice(0, 8)}`);
		if (match) out.matchedRecords.add(`${meta.parent}\0${match[2]}`);
		const dispatches = dispatchByAgent.get(key) ?? [];
		const type = label(record?.type ?? dispatches[0]?.type ?? match?.[1]);
		const base: Attribution = {
			agentType: type,
			workflow: scanned.workflows.get(key) ?? "unknown",
			traffic: type === AGENT_CRITIC ? "review-critic" : type === AGENT_REVIEWER ? "review-unknown" : "other",
		};
		const timeline: Timeline[] = [{ ...base, ms: 0 }];
		for (const dispatch of dispatches.sort((a, b) => a.ms - b.ms)) {
			let traffic = base.traffic;
			if (type === AGENT_REVIEWER && AXIS_STANDARDS.test(dispatch.prompt)) traffic = "review-standards";
			if (type === AGENT_REVIEWER && AXIS_SPEC.test(dispatch.prompt)) traffic = "review-spec";
			const target = dispatch.prompt.match(FULL_SHA)?.at(-1);
			const review = JSON.stringify([meta.parent, type, traffic, target]);
			if (dispatch.resume || (target && traffic.startsWith("review-") && reviewSeen.has(review)))
				traffic = "retry-repeat";
			reviewSeen.add(review);
			timeline.push({ ...base, traffic, ms: dispatch.ms });
		}
		if (type === "unknown") out.unmatched.add(meta.session);
		out.timelines.set(meta.session, timeline);
	}
	return out;
}

/** Phase 3: deduplicate, price and group calls. */
function aggregate(scanned: Scan, attributed: Attributed): SubagentReport {
	const loaded = flatten(scanned.files);
	const groups = new Map<string, { group: AgentGroup; sessions: Set<string> }>();
	const totals = zero();
	let priceFallbacks = scanned.priceFallbacks;
	for (const call of loaded.calls) {
		const timeline = attributed.timelines.get(call.session);
		if (!timeline) continue;
		const eligible = timeline.filter((row) => row.ms <= call.ms);
		const { ms: _ms, ...attr } = nth(eligible, eligible.length - 1);
		const provider = label(call.provider);
		const model = label(call.model);
		const key = JSON.stringify([attr.agentType, provider, model, attr.workflow, attr.traffic]);
		const entry = groups.get(key) ?? {
			group: { ...zero(), ...attr, provider, model, unmatchedSessions: 0, costComplete: true },
			sessions: new Set<string>(),
		};
		groups.set(key, entry);
		let cost = scanned.prices.get(identity(call));
		if (cost === undefined) {
			// Never throw or guess: an unbound call is unpriced and counted.
			priceFallbacks++;
			cost = UNPRICED;
		}
		add(entry.group, call, cost);
		add(totals, call, cost);
		if (attributed.unmatched.has(call.session)) entry.sessions.add(call.session);
		entry.group.unmatchedSessions = entry.sessions.size;
		entry.group.costComplete &&= cost.unpricedCalls === 0;
	}
	const referenced = [...scanned.records, ...scanned.results.map((row) => ({ ...row, path: "" }))];
	const missing = new Set(
		referenced
			.filter(
				(r) =>
					!attributed.matchedRecords.has(`${r.parent}\0${r.id.slice(0, 8)}`) && (!r.path || !scanned.paths.has(r.path)),
			)
			.map((r) => `${r.parent}\0${r.id.slice(0, 8)}`),
	);
	// Map keys are unique, so the comparator never receives equal values.
	const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, { group }]) => group);
	return {
		groups: ordered.slice(0, MAX_GROUPS),
		totals,
		unmatchedSessions: attributed.unmatched.size + missing.size,
		missingSessions: missing.size,
		errors: scanned.errors,
		badLines: loaded.badLines,
		diagnostics: scanned.diagnostics,
		omittedGroups: Math.max(0, ordered.length - MAX_GROUPS),
		priceFallbacks,
		complete:
			scanned.errors === 0 &&
			loaded.badLines === 0 &&
			attributed.unmatched.size === 0 &&
			missing.size === 0 &&
			totals.unpricedCalls === 0 &&
			priceFallbacks === 0,
	};
}

/**
 * Re-read original local session metadata, joining child names/record IDs and Agent result IDs.
 * Unrecorded workflow and review purpose remain unknown; no prompt or parent usage is billed.
 * Output is at most 200 groups (all-group totals remain explicit) and 20 diagnostics.
 */
export async function reportSubagents(root: string): Promise<SubagentReport> {
	const scanned = await scan(root);
	return aggregate(scanned, attribute(scanned));
}
