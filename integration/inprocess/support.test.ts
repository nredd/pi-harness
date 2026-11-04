import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionFactory, ExtensionStartupError } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	assertHostIdentity,
	type Deadline,
	isolateStackHome,
	loadFactory,
	loadFork,
	loadOwned,
	resolveHost,
	startStack,
	stopWake,
} from "./support.ts";

const launchHome = process.env.HOME;
let home: Awaited<ReturnType<typeof isolateStackHome>>;
beforeAll(async () => {
	home = await isolateStackHome();
});
afterAll(async () => {
	await home.cleanup();
});

it.skipIf(process.platform !== "darwin")("holds process-scoped sleep assertions for stack tests", () => {
	const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" });
	const assertion = processes.match(
		new RegExp(`^\\s*(\\d+)\\s+${process.pid}\\s+/usr/bin/caffeinate -disu -w ${process.pid}$`, "m"),
	);
	expect(assertion, "Missing process-scoped caffeinate -disu assertion").not.toBeNull();
	const assertions = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
	const owned = assertions
		.split("\n")
		.filter((line) => line.includes(`pid ${assertion?.[1]}(caffeinate):`))
		.join("\n");
	for (const type of ["PreventUserIdleSystemSleep", "PreventUserIdleDisplaySleep", "PreventSystemSleep"]) {
		expect(owned).toContain(type);
	}
});

it("keeps spawn-time HOME while isolating each Pi and XDG fixture", async () => {
	expect(process.env.HOME).toBe(launchHome);
	expect(homedir()).toBe(launchHome);
	const fixture = await isolateStackHome();
	try {
		expect(process.env.HOME).toBe(launchHome);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(fixture.root, "agent"));
		expect(process.env.XDG_CONFIG_HOME).toBe(join(fixture.root, ".config"));
		expect(fixture.root).not.toBe(home.root);
	} finally {
		await fixture.cleanup();
	}
	expect(process.env.PI_CODING_AGENT_DIR).toBe(join(home.root, "agent"));
	expect(process.env.XDG_CONFIG_HOME).toBe(join(home.root, ".config"));
});

it("loads real fork and owned entries against one host", async () => {
	for (const fork of ["pi-plan-mode", "rpiv-todo", "pi-subagents"] as const) {
		expect(typeof (await loadFork(fork))).toBe("function");
	}
	for (const owned of ["@nredd/pi-dev-tools", "@nredd/pi-session-kit", "@nredd/pi-subscription-router"] as const) {
		expect(typeof (await loadOwned(owned))).toBe("function");
	}
});

/** A `caffeinate` stand-in: records signals and, like a real child, exits asynchronously on those it obeys. */
class FakeWake extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly pid = 4242;
	readonly signals: (NodeJS.Signals | number | undefined)[] = [];

	constructor(private readonly obeys: readonly NodeJS.Signals[]) {
		super();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal);
		if (typeof signal === "string" && this.obeys.includes(signal)) {
			queueMicrotask(() => {
				this.signalCode = signal;
				this.emit("exit", null, signal);
			});
		}
		return true;
	}
}

/** A deadline whose Nth arming expires at once when `fires[N]`, otherwise never; records arm/disarm. */
function scriptedDeadline(fires: boolean[]): { deadline: Deadline; armed: number[]; disarmed: number[] } {
	const armed: number[] = [];
	const disarmed: number[] = [];
	const deadline: Deadline = (expire, ms) => {
		const index = armed.push(ms) - 1;
		if (fires[index]) expire();
		return () => disarmed.push(index);
	};
	return { deadline, armed, disarmed };
}

it("leaves an already exited wake helper alone", async () => {
	const wake = new FakeWake(["SIGTERM"]);
	wake.exitCode = 0;
	const { deadline, armed } = scriptedDeadline([]);
	await stopWake(wake, deadline);
	expect(wake.signals).toEqual([]);
	expect(armed).toEqual([]);
});

it("stops a wake helper that obeys SIGTERM within one bound", async () => {
	const wake = new FakeWake(["SIGTERM"]);
	const { deadline, armed, disarmed } = scriptedDeadline([false]);
	await stopWake(wake, deadline);
	expect(wake.signals).toEqual(["SIGTERM"]);
	expect(wake.signalCode).toBe("SIGTERM");
	expect(armed).toEqual([5_000]);
	expect(disarmed).toEqual([0]);
});

it("escalates to SIGKILL when the wake helper outlives the SIGTERM bound", async () => {
	const wake = new FakeWake(["SIGKILL"]);
	const { deadline, armed, disarmed } = scriptedDeadline([true, false]);
	await stopWake(wake, deadline);
	expect(wake.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(wake.signalCode).toBe("SIGKILL");
	expect(armed).toEqual([5_000, 5_000]);
	expect(disarmed).toEqual([0, 1]);
});

it("reports a wake helper that survives SIGKILL", async () => {
	const wake = new FakeWake([]);
	const { deadline, disarmed } = scriptedDeadline([true, true]);
	await expect(stopWake(wake, deadline)).rejects.toThrow("caffeinate 4242 survived SIGKILL for 5000 ms");
	expect(wake.signals).toEqual(["SIGTERM", "SIGKILL"]);
	expect(disarmed).toEqual([0, 1]);
});

it("bounds the wake helper's stop on the native timer by default", async () => {
	const wake = new FakeWake(["SIGTERM"]);
	await stopWake(wake);
	expect(wake.signals).toEqual(["SIGTERM"]);
	expect(wake.signalCode).toBe("SIGTERM");
});

it("holds an injected wake helper until fixture cleanup stops it", async () => {
	const wake = new FakeWake(["SIGTERM"]);
	const fixture = await isolateStackHome(() => {
		queueMicrotask(() => wake.emit("spawn"));
		return wake;
	});
	try {
		expect(existsSync(fixture.root)).toBe(true);
		expect(wake.signals).toEqual([]);
	} finally {
		await fixture.cleanup();
	}
	expect(wake.signals).toEqual(["SIGTERM"]);
	expect(existsSync(fixture.root)).toBe(false);
});

it("removes the fixture home when the wake helper cannot spawn", async () => {
	const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-wake-spawn-")));
	const previous = { TMPDIR: process.env.TMPDIR, agent: process.env.PI_CODING_AGENT_DIR };
	const failure = new Error("spawn /usr/bin/caffeinate ENOENT");
	try {
		process.env.TMPDIR = temp;
		const attempt = isolateStackHome(() => {
			const wake = new FakeWake([]);
			queueMicrotask(() => wake.emit("error", failure));
			return wake;
		});
		await expect(attempt).rejects.toThrow("Cannot hold macOS wake assertions for stack tests");
		await expect(attempt).rejects.toHaveProperty("cause", failure);
		expect(readdirSync(temp)).toEqual([]);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(previous.agent);
	} finally {
		if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous.TMPDIR;
		rmSync(temp, { recursive: true, force: true });
	}
});

it("refuses a fork that resolves its own host copy", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-copy-")));
	try {
		const fork = join(root, "packages/todo");
		const copy = join(fork, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(copy, { recursive: true });
		writeFileSync(join(fork, "package.json"), JSON.stringify({ name: "copy", type: "module" }));
		writeFileSync(
			join(copy, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": "./index.js" } }),
		);
		writeFileSync(join(copy, "index.js"), "export {};\n");
		let error: unknown;
		try {
			assertHostIdentity("rpiv-todo", pathToFileURL(`${root}/`));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		const { message, cause } = error as Error;
		expect(message).toContain("Host identity check failed for rpiv-todo: ");
		expect(message).toContain(`Delete '${join(fork, "node_modules")}/' and use root npm ci.`);
		expect(String(cause)).toBe(
			`Error: @earendil-works/pi-coding-agent: fork resolved '${join(copy, "index.js")}', stack resolved '${resolveHost("@earendil-works/pi-coding-agent", new URL(import.meta.url))}'`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("resolves a dual-format host identically through both engines' resolvers", () => {
	const parent = new URL("../../packages/todo/package.json", import.meta.url);
	const bun = resolveHost("typebox", parent, true);
	expect(bun).toContain(join("node_modules", "typebox"));
	expect(resolveHost("typebox", parent, false)).toBe(bun);
});

it("refuses an extension entry without a default factory", async () => {
	const url = new URL("./fixtures/no-default.ts", import.meta.url);
	await expect(loadFactory(url)).rejects.toThrow(`Extension '${url.href}' has no default factory`);
});

it("refuses a memory entry missing a reset seam", async () => {
	const url = new URL("./fixtures/no-memory-reset.ts", import.meta.url);
	expect(typeof (await loadFactory(url))).toBe("function");
	await expect(loadFactory(url, true)).rejects.toThrow(`Memory isolation requires _resetBaseDir in '${url.href}'`);
});

it("disposes a stack whose extension fails startup", async () => {
	let cwd: string | undefined;
	let existed = false;
	const failing: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, ctx) => {
			cwd = ctx.cwd;
			existed = existsSync(ctx.cwd);
			throw new ExtensionStartupError("refused on purpose");
		});
	};
	await expect(startStack({ factories: [failing] })).rejects.toThrow("refused on purpose");
	expect(existed).toBe(true);
	expect(cwd && existsSync(cwd)).toBe(false);
});
