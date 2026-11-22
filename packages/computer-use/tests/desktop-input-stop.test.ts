// `desktop_input` failures as Pi renders them: its dispatcher keeps only `error.message`, so the helper's code and
// posted key-pair count must be in the message itself (nredd/pi-harness#1198). The host policy is pinned to macOS.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { beforeEach, expect, test, vi } from "vitest";
import { loadComputerUseConfig } from "../src/config.ts";
import { type DesktopInputParams, executeDesktopInput } from "../src/desktop.ts";
import { HelperCommandError, HelperTransportError, macosHelper } from "../src/platform/macos/helper.ts";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const ctx = {} as ExtensionContext;
const SECRET = "hunter2-typed-text";

beforeEach(({ onTestFinished }) => {
	onTestFinished(() => {
		Object.defineProperty(process, "platform", realPlatform);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		loadComputerUseConfig("/nonexistent-cwd");
	});
	Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
	vi.stubEnv("PI_CODING_AGENT_DIR", makeTestTempDir("cu-desktop-stop-", onTestFinished));
	for (const key of ["PI_COMPUTER_USE_HEADLESS", "PI_COMPUTER_USE_DESKTOP_CONTROL", "PI_COMPUTER_USE_BLOCKED_APPS"])
		vi.stubEnv(key, undefined);
	loadComputerUseConfig("/nonexistent-cwd", "macos");
});

/** The message Pi's tool dispatcher renders for a rejected `desktop_input` call. */
async function rendered(params: DesktopInputParams, failure: Error): Promise<Error> {
	vi.spyOn(macosHelper, "command").mockRejectedValue(failure);
	const error = await executeDesktopInput("t", params, undefined, undefined, ctx).then(
		() => expect.unreachable("desktop_input must reject"),
		(caught: unknown) => caught as Error,
	);
	expect(error.message).not.toContain(SECRET);
	expect(error.message).not.toContain("cmd+s");
	return error;
}

test.for([
	{ units: 1, posted: "1 key pair posted" },
	{ units: 3, posted: "3 key pairs posted" },
])("a keyboard stop names its code and $posted, with a do-not-replay warning", async ({ units, posted }) => {
	const failure = new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked", { postedUnits: units });
	const error = await rendered({ action: "keypress", keys: ["cmd+s", "tab"] }, failure);
	expect(error.message).toBe(
		`desktop_input stopped (app_blocked): a blocked app was frontmost or held key focus. ${posted}. Do not replay this call; take a desktop_screenshot to see what arrived.`,
	);
	expect(error).toBeInstanceOf(HelperCommandError);
	expect((error as HelperCommandError).code).toBe("app_blocked");
	expect((error as HelperCommandError).evidence).toEqual({ postedUnits: units });
});

test.for([
	{ code: "input_deadline_expired", reason: "the keyboard delivery deadline expired" },
	{ code: "input_failed", reason: "a key event could not be created" },
	{ code: "invalid_args", reason: "the key sequence was rejected before delivery" },
	{ code: "focus_not_acquired", reason: "keyboard delivery stopped" },
	{ code: "toString", reason: "keyboard delivery stopped" },
])("$code renders fixed wording, never the helper's message", async ({ code, reason }) => {
	// A helper message can quote the keys or the text; none of it may reach the model-visible message.
	const failure = new HelperCommandError(`Unsupported key 'cmd+s' after '${SECRET}'`, code, { postedUnits: 0 });
	const error = await rendered({ action: "typeText", text: SECRET }, failure);
	const shown = code === "toString" ? "unknown" : code;
	expect(error.message).toBe(`desktop_input stopped (${shown}): ${reason}. No key pairs posted.`);
	expect(error.message).not.toContain("Unsupported");
});

test("a code that is not a plain identifier is not rendered", async () => {
	const failure = new HelperCommandError("x", `typed ${SECRET}`, { postedUnits: 2 });
	const error = await rendered({ action: "typeText", text: SECRET }, failure);
	expect(error.message).toBe(
		"desktop_input stopped (unknown): keyboard delivery stopped. 2 key pairs posted. Do not replay this call; take a desktop_screenshot to see what arrived.",
	);
});

test("refusals without a usable posted count, uncoded errors and transport failures pass through unchanged", async () => {
	const pointer = new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked");
	expect(await rendered({ action: "click", x: 1, y: 2 }, pointer)).toBe(pointer);
	for (const postedUnits of [-1, 1.5, Number.NaN, "1"]) {
		const odd = new HelperCommandError("app_blocked: 'Vault' is blocked", "app_blocked", { postedUnits });
		expect(await rendered({ action: "typeText", text: "x" }, odd)).toBe(odd);
	}
	const uncoded = new HelperCommandError("Daemon command 'desktopInput' failed.", undefined, { postedUnits: 1 });
	expect(await rendered({ action: "typeText", text: SECRET }, uncoded)).toBe(uncoded);
	const timeout = new HelperTransportError("Daemon command 'desktopInput' timed out after 30000ms.", "helper_timeout");
	expect(await rendered({ action: "typeText", text: SECRET }, timeout)).toBe(timeout);
});
