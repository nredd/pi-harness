/**
 * pi-dev-tools: typed tools for git, ssh, Python and Rust workflows.
 *
 * Each area registers its own tools from a sibling module; this file only wires them up.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCargoTools } from "./cargo/index.ts";
import { registerGitTools } from "./git/index.ts";
import { registerPyTools } from "./py/index.ts";
import { registerSshTools } from "./ssh/index.ts";

export default function (pi: ExtensionAPI): void {
	registerGitTools(pi);
	registerSshTools(pi);
	registerPyTools(pi);
	registerCargoTools(pi);
}
