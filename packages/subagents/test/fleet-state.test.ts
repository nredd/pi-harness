/** Bounded fleet state, journal identity authority and active-branch isolation. */
import { describe, expect, it } from "vitest";
import { FLEET_STATE_ENTRY, FLEET_STATE_VERSION, FleetJournal, type FleetJournalEntry, type FleetSnapshot, fleetAlert, MAX_COMPACT_ALERT_COUNT, MAX_FLEET_ALERT_DETAILS } from "../src/ui/fleet-state.js";

const failure = (id: number, state = "error") => ({ id: `a${id}`, type: "general-purpose", description: "failure", status: state, completedAt: 123 });
function setup(branch: FleetJournalEntry[] = []) {
  const state = new FleetJournal();
  state.restore(() => branch, data => branch.push({ type: "custom", customType: FLEET_STATE_ENTRY, data }));
  return { state, branch, report: (id: number, kind = "error") => {
    const alert = fleetAlert(failure(id, kind));
    if (!alert) throw new Error("Invalid fixture");
    state.report(alert);
  } };
}

describe("fleet journal", () => {
  it("names the persisted schema and compact cap contracts", () => {
    expect(FLEET_STATE_VERSION).toBe(1);
    expect(MAX_COMPACT_ALERT_COUNT).toBe(99);
  });

  it("restores unread failures and acknowledgements from a serialized fresh-host branch", () => {
    const h = setup();
    h.report(1);
    h.report(2, "aborted");
    h.state.acknowledge("a1");
    const resumed = setup(JSON.parse(JSON.stringify(h.branch)) as FleetJournalEntry[]);
    expect(resumed.state.alerts.map(alert => alert.id)).toEqual(["a2"]);
    resumed.report(1); // duplicated detached notice after a resume is NOT a new alert
    resumed.report(2, "aborted");
    expect(resumed.state.count).toBe(1);
    expect(resumed.branch).toHaveLength(3);
  });

  it("reopens only newer failed attempts of a resumed id, never stale duplicate notices", () => {
    const h = setup();
    h.report(1);
    h.state.acknowledge("a1");
    const newer = fleetAlert({ ...failure(1, "aborted"), completedAt: 456 });
    if (!newer) throw new Error("Invalid resumed fixture");
    h.state.report(newer);
    h.report(1); // stale completion from the first attempt
    expect(h.state.count).toBe(1);
    expect(h.state.alerts[0]).toMatchObject({ state: "aborted", timestamp: 456 });
    h.state.report({ ...newer, state: "error", timestamp: 789 });
    expect(h.state.count).toBe(1);
    expect(h.state.alerts[0]).toMatchObject({ state: "error", timestamp: 789 });
  });

  it("bounds thousands of details and preserves exact per-kind overflow, including overflow acknowledgements", () => {
    const h = setup();
    const kinds = ["error", "aborted", "failed", "killed"];
    for (let i = 0; i < 2048; i++) h.report(i, kinds[i % kinds.length]);
    expect(h.state.alerts).toHaveLength(MAX_FLEET_ALERT_DETAILS);
    expect(h.state.overflowCount).toBe(2048 - MAX_FLEET_ALERT_DETAILS);
    expect(h.state.count).toBe(2048);
    const last = h.branch.at(-1)?.data as FleetSnapshot;
    expect(last.overflow).toEqual({ error: 480, aborted: 480, failed: 480, killed: 480 });
    expect(Object.keys(h.state.alerts[0]).sort()).toEqual(["description", "id", "state", "timestamp", "type"]);
    expect(JSON.stringify(last).length).toBeLessThan(22000);
    h.state.acknowledge("a2000");
    h.state.acknowledge("a2000"); // exact-once even outside detail cap
    h.report(2000);
    const resumed = setup(JSON.parse(JSON.stringify(h.branch)) as FleetJournalEntry[]);
    expect(resumed.state.count).toBe(2047);
    expect(resumed.state.overflowCount).toBe(1919);
    resumed.state.acknowledge("a2001");
    expect(resumed.state.count).toBe(2046);
    const acknowledged = resumed.branch.at(-1)?.data as FleetSnapshot;
    expect(acknowledged.overflow).toEqual({ error: 479, aborted: 479, failed: 480, killed: 480 });
    expect(resumed.state.alerts).toHaveLength(MAX_FLEET_ALERT_DETAILS);
  });

  it("ignores corrupt and unknown-version checkpoints and follows forks/branches without other-session alerts", () => {
    const h = setup();
    h.report(1);
    const prefix = JSON.parse(JSON.stringify(h.branch)) as FleetJournalEntry[];
    h.report(2);
    h.state.acknowledge("a1");
    for (const data of [null, {}, { version: 100, collapsed: false }, { version: 1, collapsed: false, alerts: [], overflow: { error: -1 } }, { version: 1, collapsed: false, alerts: [], overflow: { error: 0, aborted: 0, failed: 0, killed: 0 }, transition: null }]) {
      h.branch.push({ type: "custom", customType: FLEET_STATE_ENTRY, data });
    }
    const fork = setup(prefix);
    expect(fork.state.alerts.map(alert => alert.id)).toEqual(["a1"]);
    const resumed = setup(h.branch);
    expect(resumed.state.alerts.map(alert => alert.id)).toEqual(["a2"]);
    resumed.state.restore(() => [], () => {});
    expect(resumed.state.count).toBe(0);
    expect(resumed.state.collapsed).toBe(true);
    const alert = fleetAlert(failure(1));
    if (!alert) throw new Error("Invalid fixture");
    resumed.state.report(alert);
    expect(resumed.state.count).toBe(1);
  });

  it("stores bounded plain metadata, never the record's result/session/usage", () => {
    const record = { ...failure(1), type: "x".repeat(1000), description: "\x1b[31mbroken\n".repeat(1000), session: {}, result: "secret", promise: Promise.resolve(), lifetimeUsage: {} };
    const alert = fleetAlert(record);
    expect(alert?.type).toHaveLength(80);
    expect(alert?.description).toHaveLength(240);
    expect(alert?.description).not.toMatch(/[\x00-\x1f]/);
    expect(Object.keys(alert ?? {}).sort()).toEqual(["description", "id", "state", "timestamp", "type"]);
    expect(fleetAlert({ ...record, status: "completed" })).toBeUndefined();
    expect(fleetAlert({ ...record, completedAt: NaN })).toBeUndefined();
    expect(fleetAlert({ ...record, id: "x".repeat(161) })).toBeUndefined();
  });
});
