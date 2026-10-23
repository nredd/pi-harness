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
		notice: "FIXTURE / macOS process CPU unavailable",
	});
tui.addChild(view);
tui.setFocus(view);
tui.start();
