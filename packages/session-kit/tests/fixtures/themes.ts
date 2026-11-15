/** Pi's built-in themes. `getThemeByName` is not a public export, so load its module from beside the package entry. */
import type { Theme } from "@earendil-works/pi-coding-agent";

const themeModule = new URL(
	"./modes/interactive/theme/theme.js",
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { getThemeByName } = (await import(themeModule.href)) as { getThemeByName(name: string): Theme | undefined };

export { getThemeByName };
