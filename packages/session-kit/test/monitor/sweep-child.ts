/** Real cleaner fixture: persist identities and TERM, then pause until the test kills us. */
import { writeFileSync } from "node:fs";
import { sweepOrphans } from "../../src/monitor/pidfiles.ts";

await sweepOrphans(process.argv[2] as string, "fixture", {
	async killGroup(record) {
		process.kill(-record.pgid, "SIGTERM");
		writeFileSync(process.argv[3] as string, "ready");
		await new Promise(() => setInterval(() => {}, 1000));
		return false;
	},
});
