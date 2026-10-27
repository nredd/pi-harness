/** Session-journal authority for bounded fleet alerts and settled disclosure choices. */
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const FLEET_STATE_ENTRY = "subagents:fleet-state";
export const FLEET_STATE_VERSION = 1;
export const MAX_FLEET_ALERT_DETAILS = 128;
export const MAX_COMPACT_ALERT_COUNT = 99;

export type FailureKind = "error" | "aborted" | "failed" | "killed";
/** No AgentRecord, result, session, promise or usage references may cross this boundary. */
export interface FleetAlert {
  id: string;
  type: string;
  description: string;
  state: FailureKind;
  timestamp: number;
}
export interface FleetSnapshot {
  version: typeof FLEET_STATE_VERSION;
  collapsed: boolean;
  alerts: FleetAlert[];
  overflow: Record<FailureKind, number>;
  /** Identity history lives in the existing journal, not an unbounded UI set. */
  transition?: { alert: FleetAlert; acknowledged: boolean };
}
export interface FleetJournalEntry { type: string; customType?: string; data?: unknown }
const KINDS: readonly FailureKind[] = ["error", "aborted", "failed", "killed"];
const emptyOverflow = (): Record<FailureKind, number> => ({ error: 0, aborted: 0, failed: 0, killed: 0 });

/** Validate whole checkpoints; corrupt/unknown entries cannot partially replace valid state. */
function snapshot(data: unknown): FleetSnapshot | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as FleetSnapshot;
  if (value.version !== FLEET_STATE_VERSION || typeof value.collapsed !== "boolean") return undefined;
  // Earlier disclosure-only entries are valid empty checkpoints.
  if (value.alerts === undefined && value.overflow === undefined) return { version: FLEET_STATE_VERSION, collapsed: value.collapsed, alerts: [], overflow: emptyOverflow() };
  if (!Array.isArray(value.alerts) || value.alerts.length > MAX_FLEET_ALERT_DETAILS || !value.alerts.every(validAlert)
    || new Set(value.alerts.map(alert => alert.id)).size !== value.alerts.length
    || !value.overflow || !KINDS.every(kind => Number.isSafeInteger(value.overflow[kind]) && value.overflow[kind] >= 0)
    || (value.transition !== undefined && (!value.transition || !validAlert(value.transition.alert) || typeof value.transition.acknowledged !== "boolean"))) return undefined;
  return value;
}

function validAlert(value: unknown): value is FleetAlert {
  if (!value || typeof value !== "object") return false;
  const alert = value as FleetAlert;
  return typeof alert.id === "string" && alert.id.length > 0 && alert.id.length <= 160
    && typeof alert.type === "string" && alert.type.length <= 80
    && typeof alert.description === "string" && alert.description.length <= 240
    && Object.keys(alert).length === 5
    && KINDS.includes(alert.state) && Number.isFinite(alert.timestamp);
}

/** Bounded strings and plain values only, including when a detached spool supplied the input. */
export function fleetAlert(value: unknown): FleetAlert | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; type?: unknown; description?: unknown; status?: unknown; completedAt?: unknown; startedAt?: unknown };
  if (typeof record.id !== "string" || !record.id || record.id.length > 160 || typeof record.type !== "string"
    || typeof record.description !== "string" || !KINDS.includes(record.status as FailureKind)) return undefined;
  const timestamp = record.completedAt ?? record.startedAt;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  const clean = (text: string, limit: number) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);
  return { id: record.id, type: clean(record.type, 80), description: clean(record.description, 240), state: record.status as FailureKind, timestamp };
}

/**
 * At most N detailed alerts plus four exact overflow counters in RAM. Each transition
 * checkpoints bounded state. For an overflow id, scan the active branch backwards for
 * its last transition (O(journal length) time, O(1) extra space). The host already owns
 * that journal; no extra id/ack set, file, or global registry is retained here.
 */
export class FleetJournal {
  collapsed = true;
  private readonly details = new Map<string, FleetAlert>();
  private overflow = emptyOverflow();
  private entries: () => readonly FleetJournalEntry[] = () => [];
  private append: ((state: FleetSnapshot) => void) | undefined;
  private settledCollapsed = true;

  restore(entries: () => readonly FleetJournalEntry[], append: (state: FleetSnapshot) => void): void {
    this.entries = entries;
    this.append = append;
    this.details.clear();
    this.overflow = emptyOverflow();
    this.collapsed = true;
    const branch = entries();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "custom" || entry.customType !== FLEET_STATE_ENTRY) continue;
      const state = snapshot(entry.data);
      if (!state) continue;
      this.collapsed = state.collapsed;
      this.overflow = { ...state.overflow };
      for (const alert of state.alerts) this.details.set(alert.id, { ...alert });
      break;
    }
    this.settledCollapsed = this.collapsed;
  }

  get alerts(): readonly FleetAlert[] { return [...this.details.values()]; }
  get overflowCount(): number { return KINDS.reduce((sum, kind) => sum + this.overflow[kind], 0); }
  get count(): number { return this.details.size + this.overflowCount; }

  /** Duplicate notices and polling are not new failures; acknowledged ids stay read. */
  report(alert: FleetAlert): void {
    const detail = this.details.get(alert.id);
    const previous = detail ? { alert: detail, acknowledged: false } : this.previous(alert.id);
    if (previous && previous.alert.timestamp >= alert.timestamp) return;
    // A resumed agent keeps its id. Replace its unread attempt, or reopen an
    // acknowledged identity only for a newer failure, never for a stale notice.
    if (previous && !previous.acknowledged) {
      if (detail) this.details.set(alert.id, alert);
      else { this.overflow[previous.alert.state]--; this.overflow[alert.state]++; }
    } else if (this.details.size < MAX_FLEET_ALERT_DETAILS) this.details.set(alert.id, alert);
    else this.overflow[alert.state]++;
    this.write({ alert, acknowledged: false });
  }

  acknowledge(id: string): void {
    const detail = this.details.get(id);
    const previous = detail ? { alert: detail, acknowledged: false } : this.previous(id);
    if (!previous || previous.acknowledged) return;
    if (!this.details.delete(id)) this.overflow[previous.alert.state]--;
    this.write({ alert: previous.alert, acknowledged: true });
  }

  isAcknowledged(id: string): boolean { return !this.details.has(id) && this.previous(id)?.acknowledged === true; }

  /** Debounced by the controller; a net-no-change burst writes nothing. */
  flushDisclosure(): void {
    if (this.collapsed !== this.settledCollapsed) this.write();
  }

  private previous(id: string): FleetSnapshot["transition"] {
    const branch = this.entries();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "custom" || entry.customType !== FLEET_STATE_ENTRY) continue;
      const data = entry.data as FleetSnapshot | undefined;
      if (data?.version === FLEET_STATE_VERSION && data.transition?.alert?.id === id) {
        const valid = snapshot(data);
        if (valid) return valid.transition;
      }
    }
    return undefined;
  }

  private write(transition?: FleetSnapshot["transition"]): void {
    this.append?.({ version: FLEET_STATE_VERSION, collapsed: this.collapsed, alerts: [...this.details.values()], overflow: { ...this.overflow }, ...(transition ? { transition } : {}) });
    this.settledCollapsed = this.collapsed;
  }
}
