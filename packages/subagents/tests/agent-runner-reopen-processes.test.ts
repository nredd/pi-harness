/**
 * Runner-level writer-claim race across two real processes (#1247): both run
 * the real `runAgent` reopen against one saved transcript after a simulated
 * `heldClaimRefusal` probe and synchronize at a simulated `verifyResumeFile`
 * barrier (`fixtures/runner-reopen-child.ts`), so the writer claim lets
 * exactly one open and write the transcript. Full `reopenTombstone` /
 * `savedSessionChecker` dispatch and recheck are not exercised here; the claim
 * helper alone is raced in `transcript-claim.test.ts`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, it, onTestFinished } from "vitest";
import { heldClaimRefusal, WRITER_CLAIM_SUFFIX } from "../src/transcript-claim.ts";

const CHILD = fileURLToPath(new URL("./fixtures/runner-reopen-child.ts", import.meta.url));

/** A real process running the runner's reopen; see the fixture for its protocol. */
class Reopener {
	readonly name: string;
	readonly child: ChildProcessWithoutNullStreams;
	private readonly lines: string[] = [];
	private stderr = "";
	private closed = false;
	private waiting: (() => void) | undefined;

	constructor(name: string, file: string, release: string, root: string) {
		this.name = name;
		// Never the developer's agent dir or session settings.
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent-dir") };
		delete env.PI_CODING_AGENT_SESSION_DIR;
		this.child = spawn(process.execPath, [CHILD, file, release, name], { cwd: root, env });
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			this.lines.push(line);
			this.waiting?.();
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		// After stdout closes, so every line it wrote has arrived.
		this.child.once("close", () => {
			this.closed = true;
			this.waiting?.();
		});
		onTestFinished(() => {
			this.child.kill("SIGKILL");
		});
	}

	/** The next line the child writes, or its stderr when it exits first. */
	async next(): Promise<string> {
		while (this.lines.length === 0) {
			if (this.closed) {
				throw new Error(`${this.name} exited ${this.child.exitCode ?? this.child.signalCode}: ${this.stderr}`);
			}
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
			});
		}
		return this.lines.shift() as string;
	}

	go(): void {
		this.child.stdin.end("go\n");
	}

	async exit(): Promise<number | null> {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			await new Promise((resolve) => this.child.once("exit", resolve));
		}
		return this.child.exitCode;
	}
}

/** A saved child transcript with one finished exchange, as a settled run leaves it. */
function savedTranscript(root: string): string {
	const sessions = join(root, "sessions");
	mkdirSync(sessions);
	const manager = SessionManager.create(root, sessions);
	manager.appendMessage({ role: "user", content: "first task", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "first answer" }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const file = manager.getSessionFile();
	if (!file || !existsSync(file)) throw new Error("the saved transcript was not written");
	return file;
}

it("lets one of two processes racing runAgent reopen claim, open and write the transcript", {
	timeout: 60_000,
}, async () => {
	// Canonical, as claims are: a temp root behind a symlink (macOS `/var`) would not compare equal.
	const root = realpathSync(makeTestTempDir("runner-reopen-processes-", onTestFinished));
	const file = savedTranscript(root);
	const release = join(root, "release");
	const reopeners = [new Reopener("a", file, release, root), new Reopener("b", file, release, root)];
	for (const reopener of reopeners) expect(await reopener.next()).toBe("ready free");
	const baseline = readFileSync(file);
	for (const reopener of reopeners) reopener.go();

	// The first to claim parks in its simulated verifyResumeFile barrier, claim held; the other stops at its claim.
	const outcomes = await Promise.all(reopeners.map((reopener) => reopener.next()));
	const winner = reopeners[outcomes.indexOf("verified")];
	if (!winner) throw new Error(`no process reached verifyResumeFile: ${outcomes.join("\n")}`);
	const loser = reopeners.find((reopener) => reopener !== winner) as Reopener;
	expect(
		outcomes.filter((outcome) => outcome === "verified"),
		outcomes.join("\n"),
	).toHaveLength(1);
	expect(outcomes[reopeners.indexOf(loser)]).toBe(
		`refused child session is in use (writer claim held by pid ${winner.child.pid}): ${file}`,
	);
	expect(await loser.exit()).toBe(0);
	expect(heldClaimRefusal(file)).toBe(
		`child session is in use (writer claim held by pid ${winner.child.pid}): ${file}`,
	);
	expect(readFileSync(file)).toEqual(baseline);

	writeFileSync(release, "");
	expect(await winner.next()).toBe(`done reply ${winner.name}`);
	expect(await winner.exit()).toBe(0);
	expect(existsSync(`${file}${WRITER_CLAIM_SUFFIX}`)).toBe(false);
	// The winner continued the saved conversation; the refused process never wrote to it.
	const after = readFileSync(file);
	expect(after.subarray(0, baseline.length)).toEqual(baseline);
	const afterText = after.toString("utf8");
	expect(afterText).toContain(`prompt ${winner.name}`);
	expect(afterText).toContain(`reply ${winner.name}`);
	expect(afterText).not.toContain(`prompt ${loser.name}`);
});
