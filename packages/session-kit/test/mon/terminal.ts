/** Manual real-terminal fixture. Run with bun; never shipped/registered as a production command. */
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { MonView } from "../../src/mon/component.ts";
import { snapshot } from "./fixtures.ts";

const theme = getThemeByName(process.argv[2] ?? "dark");
if (!theme) throw new Error("Expected built-in dark or light theme");
const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
const view = new MonView({
	theme,
	rows: () => terminal.rows,
	requestRender: () => tui.requestRender(),
	onClose: () => {
		tui.stop();
		process.stdin.pause();
	},
});
for (let i = 0; i < 90; i++)
	view.update({
		...snapshot(35 + Math.sin(i / 6) * 20 + Math.cos(i / 2) * 8, "darwin"),
		capturedAt: Date.UTC(2026, 9, 22, 22, 0, 0) + i * 2000 + (i >= 50 ? 15000 : 0),
		notice: "FIXTURE / macOS process CPU unavailable",
	});
// Match ctx.ui.custom's focused overlay, so Pi yields paging keys to the dashboard.
tui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
tui.start();
