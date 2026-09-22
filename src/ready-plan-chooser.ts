import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const READY_PLAN_ACTIONS = [
  "show",
  "implement-here",
  "implement-fresh",
  "export",
  "save",
  "stay",
  "exit",
] as const;

export type ReadyPlanAction = (typeof READY_PLAN_ACTIONS)[number];

const READY_PLAN_LABELS: Record<ReadyPlanAction, string> = {
  show: "Show latest proposed plan",
  "implement-here": "Implement here",
  "implement-fresh": "Start fresh and implement",
  export: "Export plan…",
  save: "Save for later",
  stay: "Stay in Plan mode",
  exit: "Discard plan and exit",
};

/** Shows the compact ready-plan action chooser used in fullscreen TUI sessions. */
export async function chooseReadyPlanAction(ctx: ExtensionContext): Promise<ReadyPlanAction | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;

  return ctx.ui.custom<ReadyPlanAction | undefined>((tui, _theme, keybindings, done) => {
    let selected = 0;
    let closed = false;
    let cells: Array<{ action: ReadyPlanAction; x: number; y: number; width: number }> = [];

    const finish = (action: ReadyPlanAction | undefined) => {
      if (closed) return;
      closed = true;
      done(action);
    };
    const select = (index: number) => {
      selected = (index + READY_PLAN_ACTIONS.length) % READY_PLAN_ACTIONS.length;
      tui.requestRender();
    };
    const activate = () => finish(READY_PLAN_ACTIONS[selected]);

    return {
      render(width: number) {
        const lines = ["Proposed plan ready"];
        cells = [];
        let row = "";
        let rowCells: Array<{ action: ReadyPlanAction; x: number; width: number }> = [];
        const flush = () => {
          if (!row) return;
          const y = lines.length;
          lines.push(row);
          cells.push(...rowCells.map((cell) => ({ ...cell, y })));
          row = "";
          rowCells = [];
        };

        for (const [index, action] of READY_PLAN_ACTIONS.entries()) {
          const marker = index === selected ? "›" : " ";
          const cell = `${marker}[ ${READY_PLAN_LABELS[action]} ]`;
          const cellWidth = visibleWidth(cell);
          const separator = row ? "  " : "";
          if (row && visibleWidth(row) + visibleWidth(separator) + cellWidth > width) flush();
          if (cellWidth > width) {
            flush();
            const y = lines.length;
            const wrapped = wrapTextWithAnsi(cell, Math.max(1, width));
            lines.push(...wrapped);
            cells.push(...wrapped.map((_line, offset) => ({ action, x: 0, y: y + offset, width: Math.max(1, width) })));
            continue;
          }
          const x = visibleWidth(row) + visibleWidth(separator);
          row += separator + cell;
          rowCells.push({ action, x, width: cellWidth });
        }
        flush();
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("c"))) {
          finish(undefined);
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          finish("exit");
          return;
        }
        if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.right) || data === "\t") {
          select(selected + 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.left)) {
          select(selected - 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm") || data === " ") activate();
      },
      handleMouse(event: { type: string; button: string; x: number; y: number }) {
        const cell = cells.find(
          (candidate) => candidate.y === event.y && event.x >= candidate.x && event.x < candidate.x + candidate.width,
        );
        if (!cell) return undefined;
        const index = READY_PLAN_ACTIONS.indexOf(cell.action);
        if (index >= 0 && index !== selected) select(index);
        if (event.type === "click" && event.button === "left") finish(cell.action);
        return { handled: true, capture: event.type === "press" };
      },
    };
  });
}
