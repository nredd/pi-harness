/**
 * One runner process for the two-process claim-race test in `agent-runner-reopen-processes.test.ts`
 * (#1247): the real `runAgent` reopening a saved transcript on a faux model,
 * with a simulated dispatch claim probe and pre-open barrier rather than full
 * `reopenTombstone` / `savedSessionChecker` recovery. It probes `heldClaimRefusal`
 * directly, reports the result and waits on stdin for `go`; the parent releases
 * both children at once after neither observes a held claim. Whichever acquires
 * the writer claim reports `verified` from its simulated `verifyResumeFile`
 * barrier (which always returns `undefined`) and blocks there, still holding the
 * claim, until the `release` file exists, then reports `opened` from
 * `SessionManager.open` and ends with `done <reply>`; the refused process ends
 * with `refused <message>`.
 *
 * argv: transcript, release file, name (sent as the prompt and the reply).
 */
import { existsSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agent-types.ts";
import { heldClaimRefusal } from "../../src/transcript-claim.ts";
import type { AgentConfig } from "../../src/types.ts";
import { fauxModelBackend } from "./faux-model-backend.ts";
import { registerFauxProvider } from "./pi-ai.ts";
import { runAgent } from "./run-selected-agent.ts";

const [file = "", release = "", name = ""] = process.argv.slice(2);

/** Written straight to the descriptor: a pipe write is asynchronous on macOS, and the barrier blocks the loop. */
function report(line: string): void {
	writeSync(1, `${line}\n`);
}

/** Simulated `verifyResumeFile` barrier: block with the claim held until `release` exists, then succeed. */
function holdUntilReleased(): undefined {
	report("verified");
	const pause = new Int32Array(new SharedArrayBuffer(4));
	while (!existsSync(release)) Atomics.wait(pause, 0, 0, 10);
	return undefined;
}

const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
faux.setResponses([fauxAssistantMessage(`reply ${name}`)]);
const model = faux.getModel();
const backend = fauxModelBackend(model);
registerAgents(
	new Map([
		[
			"reopener",
			{
				name: "reopener",
				description: "reopens a saved transcript",
				builtinToolNames: [],
				extensions: false,
				skills: false,
				systemPrompt: "You continue a saved conversation.",
				promptMode: "replace",
				isolated: false,
			} as AgentConfig,
		],
	]),
);
const ctx = {
	cwd: process.cwd(),
	getSystemPrompt: () => "PARENT",
	isProjectTrusted: () => true,
	model,
	modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
};

const realOpen = SessionManager.open.bind(SessionManager);
SessionManager.open = (...args: Parameters<typeof SessionManager.open>) => {
	report("opened");
	return realOpen(...args);
};

// Simulated dispatch-time claim probe only; real recovery validation lives in launch/top-level.ts.
report(`ready ${heldClaimRefusal(file) ?? "free"}`);
const lines = createInterface({ input: process.stdin });
lines.once("line", async () => {
	lines.close();
	try {
		const result = await runAgent(ctx as never, "reopener", `prompt ${name}`, {
			pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
			model,
			resumeSessionFile: file,
			verifyResumeFile: holdUntilReleased,
		});
		report(`done ${result.responseText}`);
	} catch (error) {
		report(`refused ${(error as Error).message}`);
	}
	faux.unregister();
});
