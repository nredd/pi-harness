/** Root-local discovery and bounded audit metadata. No transport, inference or lifecycle control. */
import type { AgentRecord } from "./types.ts";

export const LIST_AGENTS = "list_agents";
export const ROSTER_LIMIT = 32;
export const ROSTER_BYTES = 16_384;
export const AUDIT_LIMIT = 128;
const ROOT_LIMIT = 32;

/** Extend this event map for future event kinds; the envelope and sequence remain unchanged. */
export interface RootAuditEventMap {
	"roster.read": { count: number };
}

/** Metadata only. The root is implicit in storage, never supplied by a child tool argument. */
export type RootAuditEvent = {
	[K in keyof RootAuditEventMap]: {
		version: 1;
		sequence: number;
		kind: K;
		caller: string;
		run: string;
		time: number;
		data: RootAuditEventMap[K];
	};
}[keyof RootAuditEventMap];

export interface RosterEntry {
	id: string;
	run: string;
	handle: string;
	type: string;
	status: "queued" | "running" | "finished" | "error";
	/** Untrusted display metadata, not an instruction or approval. */
	assignment: string;
}

/** Strip terminal/control syntax and bound each display field before JSON framing. */
function display(value: unknown, limit: number): string {
	const cleaned = String(value ?? "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Code points, so a surrogate pair is never split.
	return [...cleaned].slice(0, limit).join("");
}

/** JSON data framing also escapes markup boundaries; readers must still treat values as untrusted. */
export function rosterJson(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** One bounded row. A malformed record becomes a placeholder, never a failure of the whole roster. */
function assertRoot(root: string): void {
	if (!root || root.length > 128) throw new Error("Agent roster unavailable: valid root session identity required.");
}

function entryOf(record: AgentRecord): RosterEntry {
	try {
		return {
			id: record.id,
			run: String(record.runId),
			handle: display(record.alias ?? record.handle ?? record.type, 64),
			type: display(record.type, 64),
			status:
				record.status === "running" || record.status === "queued" || record.status === "error"
					? record.status
					: "finished",
			assignment: display(record.description, 160),
		};
	} catch {
		return { id: "unknown", run: "", handle: "unknown", type: "unknown", status: "error", assignment: "" };
	}
}

/** One manager owns this store. No global registry, event emission, timers or disk persistence. */
export class AgentRoster {
	private readonly logs = new Map<string, { sequence: number; events: RootAuditEvent[] }>();

	private readonly records: () => AgentRecord[];

	constructor(records: () => AgentRecord[]) {
		this.records = records;
	}

	/** Read as the root orchestrator, using its live SDK session identity. */
	parent(root: string): { agents: RosterEntry[]; truncated: boolean } {
		return this.read(root, `root:${root}`, `root:${root}`, undefined);
	}

	/** Read as a bound child record. Missing identity or a settled caller fails closed. */
	child(id: string, allowed: ReadonlySet<string>): { agents: RosterEntry[]; truncated: boolean } {
		const caller = this.records().find((record) => record.id === id);
		if (!caller?.rosterRootId || !caller.runId || (caller.status !== "running" && caller.status !== "queued")) {
			throw new Error("Agent roster unavailable: caller has no active root-scoped run identity.");
		}
		return this.read(caller.rosterRootId, caller.id, caller.runId, allowed);
	}

	/** The current run identity of a record, or undefined when unknown. */
	runOf(id: string): string | undefined {
		return this.records().find((record) => record.id === id)?.runId;
	}

	/** Inspect retained audit metadata without modifying it or emitting an event. */
	audit(root: string): RootAuditEvent[] {
		return structuredClone(this.logs.get(root)?.events ?? []);
	}

	/** Bounded audit view: newest events that fit the roster byte cap, oldest dropped with `truncated: true`. */
	auditView(root: string): { events: RootAuditEvent[]; truncated: boolean } {
		assertRoot(root);
		const events = this.audit(root);
		let truncated = false;
		while (events.length > 0 && Buffer.byteLength(rosterJson({ events, truncated }), "utf8") > ROSTER_BYTES) {
			events.shift();
			truncated = true;
		}
		return { events, truncated };
	}

	private read(root: string, caller: string, run: string, allowed: ReadonlySet<string> | undefined) {
		assertRoot(root);
		let log = this.logs.get(root);
		if (!log) {
			if (this.logs.size >= ROOT_LIMIT) throw new Error("Agent roster unavailable: root audit capacity reached.");
			log = { sequence: 0, events: [] };
			this.logs.set(root, log);
		}
		const agents: RosterEntry[] = [
			{
				id: `root:${root}`,
				run: `root:${root}`,
				handle: "parent",
				type: "orchestrator",
				status: "running",
				assignment: "",
			},
		];
		let truncated = false;
		// The caller's own row comes first so no cap can drop it.
		const records = this.records();
		const ordered = [...records.filter((r) => r.id === caller), ...records.filter((r) => r.id !== caller)];
		for (const record of ordered) {
			if (
				record.rosterRootId !== root ||
				!record.runId ||
				(allowed && record.id !== caller && !allowed.has(record.type))
			)
				continue;
			if (agents.length === ROSTER_LIMIT) {
				truncated = true;
				break;
			}
			agents.push(entryOf(record));
			if (Buffer.byteLength(rosterJson({ agents, truncated: true }), "utf8") > ROSTER_BYTES) {
				agents.pop();
				truncated = true;
				break;
			}
		}
		log.events.push({
			version: 1,
			sequence: ++log.sequence,
			kind: "roster.read",
			caller,
			run,
			time: Date.now(),
			data: { count: agents.length },
		});
		if (log.events.length > AUDIT_LIMIT) log.events.shift();
		return { agents, truncated };
	}
}
