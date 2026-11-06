#!/usr/bin/env node
// Fake `chrome` for `launch_browser` tests. Like the real browser it refuses to start unless it can
// write its `--user-data-dir`, then serves the fake CDP endpoint on `--remote-debugging-port`.
// Records `{ port, profile }` to `$FAKE_BROWSER_LOG` so a test can find what the bridge chose.
// `$FAKE_BROWSER_LAUNCHES`, when set, gets one `{ port, profile }` JSON line per launch, for tests
// that start several browsers at once.
// `FAKE_BROWSER_IGNORE_SIGTERM=1` makes it ignore SIGTERM, like a browser that hangs on quit.
// `FAKE_BROWSER_NO_CDP=1` holds the port with a plain TCP listener that never answers CDP, so a
// launch waits until it is aborted.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startFakeCdp } from "./fake-cdp.mjs";

if (process.env.FAKE_BROWSER_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {
	if (process.env.FAKE_BROWSER_SIGTERM_LOG) fs.writeFileSync(process.env.FAKE_BROWSER_SIGTERM_LOG, "SIGTERM");
});
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(arg("remote-debugging-port"));
const profile = arg("user-data-dir");
if (process.env.FAKE_BROWSER_LOG) fs.writeFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({ port, profile }));
if (process.env.FAKE_BROWSER_LAUNCHES) fs.appendFileSync(process.env.FAKE_BROWSER_LAUNCHES, `${JSON.stringify({ port, profile })}\n`);
try {
	fs.writeFileSync(path.join(profile, "Local State"), "{}");
} catch (error) {
	process.stderr.write(String(error));
	process.exit(1);
}
if (process.env.FAKE_BROWSER_NO_CDP === "1") net.createServer((socket) => socket.destroy()).listen(port, "127.0.0.1");
else await startFakeCdp({ port });
