export default function probe(pi) {
  pi.on("session_start", () => {
    const workflow = pi.getAllTools().find(tool => tool.name === "SubagentWorkflow");
    globalThis[Symbol.for("pi-subagents:context-probe")]?.({ event: "start", workflow, manager: globalThis[Symbol.for("pi-subagents:manager")] });
  });
  pi.on("session_shutdown", () => {
    globalThis[Symbol.for("pi-subagents:context-probe")]?.({ event: "shutdown", manager: globalThis[Symbol.for("pi-subagents:manager")] });
  });
}
