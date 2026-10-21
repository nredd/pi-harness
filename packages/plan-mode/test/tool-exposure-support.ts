import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { builtinTool } from "./support.js";

/** Public metadata emitted by native built-in extension registrations. */
export function nativeTool(name: string, exposure: ToolExposure, owner = "mcp"): ToolInfo {
  return {
    ...builtinTool(name),
    exposure,
    sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level", path: `builtin:${owner}` },
  } as ToolInfo;
}
