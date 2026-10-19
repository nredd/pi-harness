import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGE_TYPE } from "../../src/monitor/index.ts";
import {
	ControlledProcesses,
	configFor,
	FakeClock,
	heldResponse,
	outcomes,
	ScenarioFixture,
	spoken,
	tick,
	tool,
} from "./support.ts";

/** Persisted custom messages, not an intercepted extension send. */
function messages(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE ? [entry] : []));
}

describe("monitors through a real session", () => {
	let fixture: ScenarioFixture;
	let clock: FakeClock;
	let processes: ControlledProcesses;
	let harness: Harness;

	/** Use real kit/manager/matcher/tools and replace only the child and scheduling boundary. */
	async function start() {
		fixture = new ScenarioFixture();
		clock = new FakeClock();
		processes = new ControlledProcesses(clock);
		harness = await fixture.start(configFor("monitor"), { kit: { clock, spawnMonitor: processes.spawn } });
		return harness;
	}

	/** Leave the real host busy after monitor_start so wakeups must use its follow-up queue. */
	async function watching(
		name: string,
		extra: Record<string, string | number | boolean> = {},
		followups = [fauxAssistantMessage("woken")],
	) {
		await start();
		const held = heldResponse("waiting");
		harness.setResponses([
			tool("monitor_start", { argv: ["/controlled/watcher"], name, ...extra }),
			held.response,
			...followups,
		]);
		const running = harness.session.prompt("go");
		await held.entered;
		expect(outcomes(harness, "monitor_start")).toEqual([
			{ isError: false, text: expect.stringContaining("started m1") },
		]);
		expect(processes.calls).toEqual([{ argv: ["/controlled/watcher"], cwd: fixture.root }]);
		return { release: held.release, running };
	}

	afterEach(async () => {
		if (!fixture) return;
		await fixture.shutdown();
		expect(processes.children.every((child) => !child.alive)).toBe(true);
		expect(clock.pending).toBe(0);
		expect(
			readdirSync(join(fixture.root, "monitors"), { recursive: true }).filter((file) => String(file).endsWith(".json")),
		).toEqual([]);
		fixture.cleanup();
	});

	it("passive batches coalesce without waking", async () => {
		const run = await watching("quiet", {}, [fauxAssistantMessage("SHOULD NOT RUN")]);
		await processes.last.stdout("one\n");
		clock.advance(1_000);
		await processes.last.stdout("two\nthree\n");
		clock.advance(999);
		expect(messages(harness)).toEqual([]);
		clock.advance(1);
		run.release();
		await run.running;
		expect(spoken(harness)).toEqual(["waiting"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(messages(harness)).toHaveLength(1);
		expect(messages(harness)[0]).toMatchObject({
			content: expect.stringContaining("1: one\n2: two\n3: three"),
			display: true,
		});
		expect(processes.last.alive).toBe(true);
		await fixture.shutdown();
		expect(processes.last.terminations).toEqual([2_000]);
		expect(messages(harness)).toHaveLength(1);
	});

	it("matching output wakes once and is readable", async () => {
		const run = await watching("srv", { match: "READY" }, [
			tool("monitor_read", { id: "srv" }),
			fauxAssistantMessage("woken and read"),
		]);
		// Both matching and nonmatching batches traverse the real worker, not a canned match result.
		await processes.last.stdout("boot\n");
		clock.advance(2_000);
		await processes.last.stdout("READY now\n");
		clock.advance(2_000);
		expect(spoken(harness)).toEqual([]);
		run.release();
		await run.running;
		expect(spoken(harness)).toEqual(["waiting", "woken and read"]);
		expect(messages(harness)).toHaveLength(2);
		expect(
			messages(harness).some(
				(message) => String(message.content).includes("READY now") && String(message.content).includes("match on"),
			),
		).toBe(true);
		expect(outcomes(harness, "monitor_read")).toEqual([{ isError: false, text: expect.stringContaining("READY now") }]);
	});

	it("wake mode follows every batch", async () => {
		const run = await watching("loud", { wake: true }, [
			fauxAssistantMessage("woken"),
			fauxAssistantMessage("woken again"),
		]);
		await processes.last.stdout("ping\n");
		clock.advance(2_000);
		run.release();
		await run.running;
		expect(spoken(harness)).toEqual(["waiting", "woken"]);
		await processes.last.stdout("pong\n");
		await tick(harness, clock, 2_000);
		expect(spoken(harness)).toEqual(["waiting", "woken", "woken again"]);
		expect(messages(harness)).toHaveLength(2);
	});

	it("exit code reaches one wake message", async () => {
		const run = await watching("short", {}, [fauxAssistantMessage("woken by exit")]);
		await processes.last.stdout("bye\n");
		clock.advance(2_000); // Flush first: exit must wake even with no output pending.
		processes.last.exit(3);
		run.release();
		await run.running;
		expect(spoken(harness)).toEqual(["waiting", "woken by exit"]);
		expect(messages(harness)).toHaveLength(2);
		expect(messages(harness).filter((message) => String(message.content).includes("exited with code 3"))).toHaveLength(
			1,
		);
		expect(processes.last.alive).toBe(false);
	});

	it("read cursor returns only later lines by id and name", async () => {
		const run = await watching("lines", {}, [fauxAssistantMessage("SHOULD NOT RUN")]);
		await processes.last.stdout("a\nb\nc\n");
		run.release();
		await run.running;
		harness.setResponses([
			tool("monitor_read", { id: "lines" }),
			tool("monitor_read", { id: "m1", since: 2 }),
			tool("monitor_read", { id: "lines", since: 3 }),
			fauxAssistantMessage("end"),
		]);
		await harness.session.prompt("read");
		const [full, later, none] = outcomes(harness, "monitor_read");
		expect(full?.isError).toBe(false);
		expect(full?.text).toContain("1: a");
		expect(full?.text).toContain("3: c");
		expect(full?.text).toContain("next since: 3");
		expect(later?.isError).toBe(false);
		expect(later?.text).not.toContain("1: a");
		expect(later?.text).not.toContain("2: b");
		expect(later?.text).toContain("3: c");
		expect(none?.isError).toBe(false);
		expect(none?.text).toContain("(no new output)");
		expect(none?.text).toContain("next since: 3");
	});

	it("five-slot limit and names recover after stop", async () => {
		await start();
		const spawn = (name: string) => tool("monitor_start", { argv: ["/controlled/watcher"], name });
		harness.setResponses([
			...Array.from({ length: 5 }, (_, i) => spawn(`w${i}`)),
			spawn("w6"),
			tool("monitor_stop", { id: "w0" }),
			spawn("w7"),
			spawn("w1"),
			fauxAssistantMessage("end"),
		]);
		await harness.session.prompt("go");
		const started = outcomes(harness, "monitor_start");
		expect(started.map((result) => result.isError)).toEqual([false, false, false, false, false, true, false, true]);
		expect(started[5]?.text).toContain("at most 5");
		expect(started[7]?.text).toContain("already named");
		expect(outcomes(harness, "monitor_stop")[0]?.isError).toBe(false);
		expect(processes.children).toHaveLength(6);
		expect(processes.children.filter((child) => child.alive)).toHaveLength(5);
		expect(processes.children[0]?.terminations).toEqual([2_000]);
	});

	it("timeout terminates and wakes once", async () => {
		const run = await watching("slow", { timeout_s: 2 }, [fauxAssistantMessage("woken by timeout")]);
		await processes.last.stdout("up\n");
		clock.advance(1_999);
		expect(processes.last.terminations).toEqual([]);
		clock.advance(1);
		expect(processes.last.terminations).toEqual([2_000]);
		run.release();
		await run.running;
		expect(spoken(harness)).toEqual(["waiting", "woken by timeout"]);
		expect(messages(harness).filter((message) => String(message.content).includes("timed out after"))).toHaveLength(1);
		const delivered = messages(harness).length;
		expect(processes.last.alive).toBe(false);
		clock.advance(20_000);
		expect(processes.last.terminations).toEqual([2_000]);
		expect(messages(harness)).toHaveLength(delivered);
	});

	it("bad monitor arguments return errors without crashing", async () => {
		await start();
		harness.setResponses([
			tool("monitor_start", { argv: ["/nonexistent/binary"], name: "x" }),
			tool("monitor_start", { argv: ["/controlled/watcher"], name: "y", match: "(" }),
			tool("monitor_start", { argv: ["/controlled/watcher"], name: "bad name!" }),
			tool("monitor_read", { id: "nope" }),
			fauxAssistantMessage("end"),
		]);
		await harness.session.prompt("go");
		const errors = [...outcomes(harness, "monitor_start"), ...outcomes(harness, "monitor_read")];
		expect(errors.map((result) => result.isError)).toEqual([true, true, true, true]);
		for (const [index, text] of ["cannot start", "regex", "name must match", "no monitor"].entries())
			expect(errors[index]?.text).toContain(text);
		expect(spoken(harness)).toEqual(["end"]);
		expect(processes.calls).toHaveLength(1);
		expect(processes.children).toEqual([]);
	});
});
