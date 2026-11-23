/**
 * One recovering process for `transcript-claim.test.ts` (#1247). It runs the
 * dispatch-time check, reports it, and waits on stdin for `go`: the parent
 * releases every child at once, so each has passed its check before any opens.
 * It then claims the transcript and holds it until stdin closes. An optional
 * second argument stands in for a verified PID domain, as Linux reports one.
 */
import { createInterface } from "node:readline";
import { claimHost, claimTranscript, heldClaimRefusal } from "../../src/transcript-claim.ts";

const file = process.argv[2] ?? "";
const domain = process.argv[3];
if (domain !== undefined) claimHost.pidDomain = () => domain;
process.stdout.write(`ready ${heldClaimRefusal(file) ?? "free"}\n`);
const lines = createInterface({ input: process.stdin });
lines.once("line", () => {
	try {
		const claim = claimTranscript(file);
		process.stdout.write("claimed\n");
		lines.once("close", () => {
			claim.release();
			process.stdout.write("released\n");
		});
	} catch (error) {
		process.stdout.write(`refused ${(error as Error).message}\n`);
		lines.close();
	}
});
