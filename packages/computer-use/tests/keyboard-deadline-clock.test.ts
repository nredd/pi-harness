// The macOS keyboard deadline travels in the helper's boot-relative clock, never as a wall-clock stamp, so a
// backward wall-clock step cannot grant the helper typing time after the client timed out (nredd/pi-harness#1198).
// Real unix socket against `test/support/fake-helper.mjs`; no Swift helper runs.
import { fileURLToPath } from "node:url";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { expect, type TestContext, test, vi } from "vitest";
import { macosHelperBuild } from "../src/platform/macos/helper-build.mjs";
import { defaultDiagnostics, ok, shortSocketPath, startFakeHelper } from "../test/support/fake-helper.mjs";

const matchingBuild = macosHelperBuild(fileURLToPath(new URL("../", import.meta.url)));

const HELPER_UPTIME_MS = 5_000_000;
const PROTOCOL = 8;

/** A fresh `helper.ts` bound to an external fake helper whose diagnostics report `diagnostics`. */
async function external(
	onTestFinished: TestContext["onTestFinished"],
	diagnostics: Record<string, unknown>,
	handlers: Record<string, unknown> = {},
) {
	const fake = await startFakeHelper({
		socketPath: shortSocketPath(),
		protocolVersion: PROTOCOL,
		diagnostics: { buildIdentity: matchingBuild, ...diagnostics },
		handlers: { desktopInput: ok({ performed: "type" }), look: ok({ roots: [] }), ...handlers },
	});
	const home = makeTestTempDir("cu-clock-", onTestFinished);
	onTestFinished(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.doUnmock("node:os");
		vi.resetModules();
		await fake.stop();
	});
	vi.resetModules();
	vi.stubEnv("PI_CU_SOCKET_PATH", fake.socketPath);
	vi.stubEnv("PI_COMPUTER_USE_HELPER_APP_PATH", `${home}/pi-computer-use.app`);
	// The managed default socket path must never be the host's real one.
	vi.doMock("node:os", async (original) => {
		const actual = await original<typeof import("node:os")>();
		const patched = { ...actual, homedir: () => home };
		return { ...patched, default: patched };
	});
	const { MacosHelperClient } = await import("../src/platform/macos/helper.ts");
	return { fake, client: new MacosHelperClient() };
}

const sent = (fake: { requests: Array<{ cmd: string; args: Record<string, unknown> }> }, cmd: string) =>
	fake.requests.filter((request) => request.cmd === cmd).map((request) => request.args);

test("the deadline is the helper's uptime plus the budget left when the probe reply arrives, whatever the wall clock says", async ({
	onTestFinished,
}) => {
	// A fake monotonic clock that advances a known amount while the build probe is in flight.
	let clock = 10_000;
	const PROBE_MS = 400;
	const diagnostics = { buildIdentity: matchingBuild, uptimeMs: HELPER_UPTIME_MS };
	const { fake, client } = await external(onTestFinished, diagnostics, {
		diagnostics: (request: { id: string }) => {
			if (request.id.startsWith("build_")) clock += PROBE_MS;
			return ok(defaultDiagnostics(PROTOCOL, diagnostics));
		},
	});
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	// A wall clock stepped back years, and stuck there, must not move the deadline.
	vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2020, 0, 1));
	await client.command("desktopInput", { action: "type", text: "x" }, { timeoutMs: 30_000 });
	const [args] = sent(fake, "desktopInput");
	expect(args.keyboardDeadlineMs).toBeUndefined();
	// 30 s budget, 250 ms margin, and the probe's 400 ms charged against it.
	expect(args.keyboardDeadlineUptimeMs).toBe(HELPER_UPTIME_MS + 30_000 - 250 - PROBE_MS);
});

test("commands that post no keys carry no deadline", async ({ onTestFinished }) => {
	const { fake, client } = await external(onTestFinished, { uptimeMs: HELPER_UPTIME_MS });
	await client.command("look", {});
	expect(sent(fake, "look")).toEqual([{}]);
});

test.for([{ uptimeMs: undefined }, { uptimeMs: "5000000" }, { uptimeMs: -1 }, { uptimeMs: Number.NaN }])(
	"a helper that reports no usable clock ($uptimeMs) gets no keyboard command",
	async ({ uptimeMs }, { onTestFinished }) => {
		const { fake, client } = await external(onTestFinished, { uptimeMs });
		await expect(client.command("desktopInput", { action: "key", keys: ["tab"] })).rejects.toMatchObject({
			code: "helper_protocol",
			message: expect.stringContaining("uptimeMs"),
		});
		expect(sent(fake, "desktopInput")).toEqual([]);
	},
);
