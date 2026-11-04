/** Real cleaner fixture: persist identities and TERM, then pause until the test (or its worker's death) ends us. */
import { writeFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { sweepOrphans } from "../../src/monitor/pidfiles.ts";
import { stayFor } from "./stay.ts";

await sweepOrphans(process.argv[2] as string, "fixture", {
	async killGroup(record) {
		process.kill(-record.pgid, "SIGTERM");
		writeFileSync(process.argv[3] as string, "ready");
		// Paused until the test kills us, or until the worker that spawned us (passed in, since it may
		// already be gone by now and `process.ppid` would then read as its reaper) dies.
		runInThisContext(stayFor(Number(process.argv[4])));
		await new Promise(() => {});
		return false;
	},
});
