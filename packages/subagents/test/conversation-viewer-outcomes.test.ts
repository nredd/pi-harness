/** Real Markdown, injected time, and visible fullscreen navigation outcomes. */
import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FakeClock } from "./helpers/fake-clock.js";

/** No SDK theme initialization: the embedded viewer must provide its own theme. */
function fixture(messages: unknown[], fullscreen = false, streamingMessage?: unknown) {
  const clock = new FakeClock();
  const requestRender = vi.fn();
  const tui = { mode: fullscreen ? "fullscreen" : "regular", terminal: { rows: 100, columns: 100 }, requestRender };
  const unsubscribe = vi.fn();
  let listener: AgentSessionEventListener = () => {};
  const session = { messages, state: { streamingMessage }, subscribe: (value: AgentSessionEventListener) => { listener = value; return unsubscribe; } } as unknown as AgentSession;
  const record = { id: "observed", type: "Explore", description: "embedded", status: "running", startedAt: clock.now(), toolUses: 0 } as AgentRecord;
  const viewer = new ConversationViewer(tui as unknown as TUI, session, record, undefined, {
    fg: (color, text) => `<${color}>${text}</${color}>`, bold: text => `<bold>${text}</bold>`,
  }, vi.fn(), undefined, undefined, undefined, false, undefined, undefined, "hidden", undefined, clock);
  return { clock, requestRender, tui, record, viewer, unsubscribe, emit: (event: Parameters<AgentSessionEventListener>[0]) => listener(event), render: () => viewer.render(240).join("\n") };
}

describe("embedded conversation outcomes", () => {
  it("styles links, quotes, separators and fenced source without an initialized host theme", () => {
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: false });
    const f = fixture([{ role: "assistant", content: [{ type: "text", text: "[click](https://example.com)\n\n> quoted\n\n---\n\n```js\nconst answer = 42;\n```\n\n- item\n\nUse `inline-code` here." }] }]);
    try {
      const rendered = stripTerminalSequences(f.render());
      expect(rendered).toContain("<accent>click</accent>");
      expect(rendered).toContain("<muted> (https://example.com)</muted>");
      expect(rendered).toContain("<muted>quoted</muted>");
      expect(rendered).toContain("<dim>│ </dim>");
      // Markdown caps HRs at 80 columns; the viewer chrome uses other widths.
      expect(rendered).toContain(`<dim>${"─".repeat(80)}</dim>`);
      // Match both fence borders and the styled source, not just its text.
      expect(rendered).toContain("<dim>```js</dim>");
      expect(rendered).toContain("  <muted>const answer = 42;</muted>");
      expect(rendered).toContain("<dim>```</dim>");
      expect(rendered).toContain("<accent>- </accent>");
      expect(rendered).toContain("<muted>inline-code</muted>");
    } finally { f.viewer.dispose(); setCapabilities(capabilities); }
  });

  it("ticks only until the observed run settles and ignores stale events after disposal", () => {
    const f = fixture([]);
    expect(f.clock.pending).toBe(1);
    expect(f.render()).toContain("0.0s (running)");
    f.clock.advance(1000);
    expect(f.requestRender).toHaveBeenCalledTimes(1);
    expect(f.render()).toContain("1.0s (running)");
    f.record.status = "completed";
    f.record.completedAt = f.clock.now();
    f.clock.advance(1000);
    expect(f.clock.pending).toBe(0);
    expect(f.requestRender).toHaveBeenCalledTimes(2);
    expect(f.render()).toContain("1.0s");
    f.viewer.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.viewer.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    // Deliberately retain the subscribed callback, modeling delivery already in flight.
    // Unsubscription must not be what prevents this stale callback repainting the UI.
    f.emit({ type: "agent_end", messages: [] });
    expect(f.requestRender).toHaveBeenCalledTimes(2);
    f.clock.advance(10000);
    expect(f.clock.pending).toBe(0);
    expect(f.requestRender).toHaveBeenCalledTimes(2);
  });

  it("moves down and pages from the first line using the fullscreen viewport height", () => {
    const f = fixture([{ role: "user", content: Array.from({ length: 200 }, (_, i) => `row-${i.toString().padStart(3, "0")}`).join("\n") }], true);
    f.tui.terminal.rows = 20;
    const first = () => stripTerminalSequences(f.render()).match(/row-\d+/)?.[0];
    try {
      f.viewer.render(100);
      f.viewer.handleInput("\x1b[H");
      expect(first()).toBe("row-000");
      f.viewer.handleInput("j");
      expect(first()).toBe("row-000"); // scrolls past [User], not row zero
      f.viewer.handleInput("j");
      expect(first()).toBe("row-001");
      f.viewer.handleInput("\x1b[6~");
      expect(first()).toBe("row-017"); // 20 rows minus four rows of chrome
      f.viewer.handleInput("\x1b[5~");
      expect(first()).toBe("row-001");
    } finally { f.viewer.dispose(); }
  });

  it("pages regular overlays by their capped viewport height and preserves pixels after invalidation", () => {
    const f = fixture([{ role: "user", content: Array.from({ length: 200 }, (_, i) => `row-${i.toString().padStart(3, "0")}`).join("\n") }]);
    f.tui.terminal.rows = 40;
    const first = () => stripTerminalSequences(f.render()).match(/row-\d+/)?.[0];
    try {
      f.render();
      f.viewer.handleInput("\x1b[H");
      expect(first()).toBe("row-000");
      f.viewer.handleInput("\x1b[6~");
      expect(first()).toBe("row-021"); // floor(40 * .7) minus six chrome rows
      f.viewer.handleInput("\x1b[5~");
      expect(first()).toBe("row-000");
      const before = f.render();
      f.viewer.invalidate();
      expect(f.render()).toBe(before);
    } finally { f.viewer.dispose(); }
  });

  it("shows an uncommitted streaming reply once and drops non-text streaming blocks", () => {
    const streaming = { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "live **literal**" }] };
    const messages: unknown[] = [{ role: "user", content: "question" }];
    const f = fixture(messages, false, streaming);
    try {
      const before = f.render();
      expect(before).toContain("live **literal**");
      expect(before).not.toContain("secret");
      expect(before.match(/\[Assistant\]/g)).toHaveLength(1);
      messages.push(streaming);
      const after = f.render();
      expect(after.match(/\[Assistant\]/g)).toHaveLength(1);
      expect(after).not.toContain("**literal**");
      expect(after).toContain("<bold>literal</bold>");
    } finally { f.viewer.dispose(); }
  });
});
