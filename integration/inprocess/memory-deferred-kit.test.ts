/** Real memory/context-engine hooks coexist with kit registration and monitor execution. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { createSessionKit } from "../../packages/session-kit/src/index.ts";
import { ControlledProcesses, configFor, FakeClock } from "../../packages/session-kit/test/scenarios/support.ts";
import extensionInventory from "../providers/extension_inventory.ts";
import { jsonFile } from "./agents-support.ts";
import { isolateResearchPackages, isolateStackHome, loadThirdParty, startStack } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let restore: () => void;
let h: Harness;
const clock = new FakeClock();
const processes = new ControlledProcesses(clock);
beforeAll(async () => {
	home = await isolateStackHome();
	restore = isolateResearchPackages(home.root);
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Memory/deferred stack must stay offline");
	});
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		alwaysActive: ["search_tools", "memory_write", "memory_read", "scratchpad", "harness_extension_inventory"],
	});
	h = await startStack({
		cwd: home.root,
		factories: [
			extensionInventory,
			createSessionKit({
				config: configFor("monitor"),
				agentDir: join(home.root, "agent"),
				monitorRoot: join(home.root, "monitors"),
				clock,
				spawnMonitor: processes.spawn,
			}),
			await loadThirdParty("memory"),
			await loadThirdParty("deferred"),
		],
	});
});
afterAll(async () => {
	try {
		if (h) {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.cleanup();
		}
	} finally {
		vi.restoreAllMocks();
		restore?.();
		await home.cleanup();
	}
});

/** Inspect the schemas and system prompt actually supplied to the faux model. */
async function request(): Promise<{ tools: string[]; prompt: string }> {
	let tools: string[] = [];
	let prompt = "";
	h.setResponses([
		(ctx) => {
			tools = getCurrentTools(ctx.messages).map((t) => t.name);
			prompt = JSON.stringify(ctx.messages.filter((message) => message.role === "system"));
			return fauxAssistantMessage("OBSERVED");
		},
	]);
	await h.session.prompt("inspect current context");
	return { tools, prompt };
}

it("memory writes refresh context while deferred kit tools promote and execute", async () => {
	const [inventory] = await runTools(h, [{ name: "harness_extension_inventory", args: {} }]);
	expect(inventory.isError, inventory.text).toBe(false);
	expect(JSON.parse(inventory.text).tools).toEqual(
		expect.arrayContaining(["monitor_start", "memory_write", "search_tools"]),
	);
	const before = await request();
	expect(before.tools).toEqual(expect.arrayContaining(["memory_write", "memory_read", "scratchpad", "search_tools"]));
	expect(before.tools).not.toContain("monitor_start");
	const [written] = await runTools(h, [
		{ name: "memory_write", args: { target: "long_term", content: "MEMORY-KIT-CONTEXT" } },
	]);
	expect(written.isError, written.text).toBe(false);
	const refreshed = await request();
	// A system-message assertion, not merely the earlier tool-result echo.
	expect(refreshed.prompt).toContain("MEMORY-KIT-CONTEXT");
	expect(readFileSync(join(home.root, "memory/MEMORY.md"), "utf8")).toContain("MEMORY-KIT-CONTEXT");
	const [searched] = await runTools(h, [
		{ name: "search_tools", args: { query: "monitor_start monitor_read background process", kind: "tool" } },
	]);
	expect(searched.isError, searched.text).toBe(false);
	expect(searched.text).toContain("monitor_start");
	expect((await request()).tools).toContain("monitor_start");
	const [started] = await runTools(h, [
		{ name: "monitor_start", args: { name: "coverage", argv: ["/bin/echo", "KIT-MEMORY-OUTPUT"] } },
	]);
	expect(started.isError, started.text).toBe(false);
	await processes.last.stdout("KIT-MEMORY-OUTPUT\n");
	const [read, memory] = await runTools(h, [
		{ name: "monitor_read", args: { id: "coverage" } },
		{ name: "memory_read", args: { target: "long_term" } },
	]);
	expect(read.isError, read.text).toBe(false);
	expect(read.text).toContain("KIT-MEMORY-OUTPUT");
	expect(memory.isError, memory.text).toBe(false);
	expect(memory.text).toContain("MEMORY-KIT-CONTEXT");
	const [invalid] = await runTools(h, [{ name: "memory_read", args: { target: "daily", date: "../../escape" } }]);
	expect(invalid.isError).toBe(true);
	expect(invalid.text).toContain("Invalid date format");
	expect(globalThis.fetch).not.toHaveBeenCalled();
});
