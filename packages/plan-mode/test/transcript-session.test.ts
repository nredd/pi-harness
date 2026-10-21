import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { VirtualTerminal } from "@earendil-works/pi-tui/testing";
import { expect, test } from "vitest";
import { complete, deferred, planFactory, QUESTION, SessionFixture, state, tool } from "./session-support.js";

/** Transcript after the real user prompt, ending before the next user turn/editor rule. */
function transcript(rows: string[]): string[] {
  const start = rows.findIndex((row) => /^\s*go\s*$/.test(row));
  expect(start, rows.join("\n")).toBeGreaterThanOrEqual(0);
  const end = rows.findIndex((row, index) => index > start && /^─{20,}$/.test(row.trim()));
  expect(end, rows.join("\n")).toBeGreaterThan(start);
  return rows.slice(start + 1, end);
}

/** Generic source invariant: no expanded headers, stray output, or a second line per entry. */
function oneLineEntries(rows: string[]): string[] {
  const region = transcript(rows);
  for (const [index, row] of region.entries()) {
    if (!row.trim() || /^┄{20,}$/.test(row.trim())) continue;
    expect(row.startsWith("▾ "), row).toBe(false);
    const staticEntry = row.startsWith("  ") && (index === 0 || /^┄{20,}$/.test(region[index - 1]?.trim() ?? ""));
    expect(row.startsWith("▸ ") || staticEntry, row).toBe(true);
    const follower = region[index + 1] ?? "";
    expect(!follower.trim() || /^(?:▸ |▾ |┄{20,})/.test(follower), `${row}\n${follower}`).toBe(true);
  }
  return region.filter((row) => row.startsWith("▸ "));
}

/** Stable source key, allowing an expanded call to omit inlined arguments. */
function entryKey(row: string): string {
  return row.slice(2).trim().split(" · ")[0]?.slice(0, 24).trim() ?? "";
}

/** Deliver a complete raw SGR press/release through VirtualTerminal and the real TUI. */
async function click(host: InteractiveHarness, row: number): Promise<void> {
  host.input(`\x1b[<0;7;${row + 1}M`);
  host.input(`\x1b[<0;7;${row + 1}m`);
  await host.settle();
}

test("real host collapses Plan tools and proposed plan", async () => {
  const fixture = new SessionFixture();
  const terminal = new VirtualTerminal(140, 90);
  const questionMounted = deferred<void>();
  const readyMounted = deferred<void>();
  let mounts = 0;
  const observe: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      const custom = ctx.ui.custom.bind(ctx.ui);
      ctx.ui.custom = (factory, options) =>
        custom((...args) => {
          const component = factory(...args);
          (mounts++ === 0 ? questionMounted : readyMounted).resolve();
          return component;
        }, options);
    });
  };
  const host = await createInteractiveHarness({
    cwd: fixture.root,
    terminal,
    columns: 140,
    rows: 90,
    tuiMode: "fullscreen",
    settings: { retry: { enabled: false } },
    extensionFactories: [planFactory, observe],
  });
  try {
    await host.harness.session.prompt("/plan start");
    host.harness.setResponses([tool("plan_mode_question", { questions: [QUESTION] }), complete("Tiny plan")]);
    const run = host.harness.session.prompt("go");
    await questionMounted.promise;
    await host.settle();
    expect(host.viewport().join("\n")).toContain("Narrow");
    host.input("\r");
    await host.settle();
    // The current questionnaire reviews its single answer before submission.
    host.input("\r");
    await readyMounted.promise;
    await host.settle();
    expect(host.viewport().join("\n").toLowerCase()).toContain("tiny plan");
    host.input("\x1b");
    await run;
    await host.settle();
    expect(state(host.harness).enabled).toBe(true);
    expect(state(host.harness).latestPlan).toContain("# Tiny plan");
    expect(state(host.harness).awaitingAction).toBe(true);
    await host.harness.session.prompt("/plan show");
    await host.settle();
    const rows = host.viewport();
    const screen = rows.join("\n");
    const entries = oneLineEntries(rows);
    expect(screen).toMatch(/^▸ .*Scope → Narrow/m);
    expect(screen).toMatch(/^▸ .*Tiny plan · plan proposed/m);
    expect(screen).toMatch(/^▸ Proposed Plan · Tiny plan/m);
    // Ready presentation and /plan show can each post the same plan. Check every visible entry.
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const [occurrence, entry] of entries.entries()) {
      const current = host.viewport();
      const row = current.map((text, index) => ({ text, index })).filter(({ text }) => text.startsWith("▸ "))[
        occurrence
      ];
      if (!row) throw new Error(`Missing collapsed row ${occurrence}`);
      await click(host, row.index);
      const expanded = host.viewport();
      const headers = transcript(expanded).filter((text) => text.startsWith("▾ "));
      expect(headers, expanded.join("\n")).toHaveLength(1);
      const expandedKey = entryKey(headers[0] ?? "");
      const key = entryKey(entry);
      expect(key.startsWith(expandedKey) || expandedKey.startsWith(key)).toBe(true);
      await click(
        host,
        expanded.findIndex((text) => text.startsWith("▾ ")),
      );
      expect(transcript(host.viewport()).filter((text) => text.startsWith("▾ "))).toHaveLength(0);
      expect(oneLineEntries(host.viewport())).toEqual(entries);
    }
  } finally {
    await host.dispose();
    terminal.dispose();
    fixture.cleanup();
  }
});
