// `isWsl` / `wslNoWindowsHint` (`src/platform/linux/wsl.ts`) over every detection arm. The default `wslProbe` reads
// `process.env`, the binfmt entry and `/proc/version`; `node:fs` is replaced so each arm is host-independent.
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("node:fs");
	vi.resetModules();
});

/** Fresh `wsl.ts` with `existsSync`/`readFileSync` replaced. */
async function loadWsl({ exists = false, version } = {}) {
	vi.resetModules();
	const calls = { exists: [], read: [] };
	vi.doMock("node:fs", async (original) => ({
		...(await original()),
		existsSync: (file) => {
			calls.exists.push(file);
			return exists;
		},
		readFileSync: (file, encoding) => {
			calls.read.push([file, encoding]);
			if (version instanceof Error) throw version;
			return version ?? "";
		},
	}));
	return { ...(await import("../src/platform/linux/wsl.ts")), calls };
}

/** A probe with every input quiet unless overridden. */
const probe = (overrides = {}) => ({ env: () => ({}), hasInteropEntry: () => false, procVersion: () => "", ...overrides });

describe("isWsl with an injected probe", () => {
	test("WSL_DISTRO_NAME or WSL_INTEROP is enough, without reading the kernel", async () => {
		const { isWsl } = await loadWsl();
		const never = () => assert.fail("must short-circuit on the environment");
		assert.equal(isWsl(probe({ env: () => ({ WSL_DISTRO_NAME: "Ubuntu" }), hasInteropEntry: never, procVersion: never })), true);
		assert.equal(isWsl(probe({ env: () => ({ WSL_INTEROP: "/run/WSL/1_interop" }), hasInteropEntry: never, procVersion: never })), true);
	});

	test("an empty environment value does not count", async () => {
		const { isWsl } = await loadWsl();
		assert.equal(isWsl(probe({ env: () => ({ WSL_DISTRO_NAME: "", WSL_INTEROP: "" }) })), false);
	});

	test("the WSLInterop binfmt entry is enough, without reading the kernel", async () => {
		const { isWsl } = await loadWsl();
		assert.equal(isWsl(probe({ hasInteropEntry: () => true, procVersion: () => assert.fail("must short-circuit") })), true);
	});

	test("a Microsoft or WSL kernel string matches case-insensitively", async () => {
		const { isWsl } = await loadWsl();
		assert.equal(isWsl(probe({ procVersion: () => "Linux version 5.15.153.1-microsoft-standard-WSL2" })), true);
		assert.equal(isWsl(probe({ procVersion: () => "Linux version 6.1 (MICROSOFT)" })), true);
		assert.equal(isWsl(probe({ procVersion: () => "Linux version 6.1 wsl" })), true);
	});

	test("a plain Linux kernel, or an unreadable /proc/version, is not WSL", async () => {
		const { isWsl } = await loadWsl();
		assert.equal(isWsl(probe({ procVersion: () => "Linux version 6.8.0-generic (buildd@lcy02) (gcc)" })), false);
		assert.equal(isWsl(probe()), false);
	});
});

describe("wslNoWindowsHint", () => {
	test("explains the guest-only AT-SPI view and names the tracking issue under WSL", async () => {
		const { wslNoWindowsHint, WSL2_BRIDGE_ISSUE } = await loadWsl();
		const hint = wslNoWindowsHint(probe({ env: () => ({ WSL_DISTRO_NAME: "Ubuntu" }) }));
		assert.match(hint, /^Running under WSL2: Windows host windows are not reachable from the WSL2 guest/);
		assert.match(hint, /WSLg\) can be observed or acted on\./);
		assert.ok(hint.endsWith(`See ${WSL2_BRIDGE_ISSUE}.`));
		assert.equal(WSL2_BRIDGE_ISSUE, "nredd/pi-harness#668");
	});

	test("is undefined outside WSL", async () => {
		const { wslNoWindowsHint } = await loadWsl();
		assert.equal(wslNoWindowsHint(probe()), undefined);
	});
});

describe("the default wslProbe", () => {
	test("reads the live environment", async () => {
		const { wslProbe } = await loadWsl();
		assert.equal(wslProbe.env(), process.env);
	});

	test("looks for the WSLInterop binfmt entry", async () => {
		const present = await loadWsl({ exists: true });
		assert.equal(present.wslProbe.hasInteropEntry(), true);
		assert.deepEqual(present.calls.exists, ["/proc/sys/fs/binfmt_misc/WSLInterop"]);
		const absent = await loadWsl({ exists: false });
		assert.equal(absent.wslProbe.hasInteropEntry(), false);
	});

	test("reads /proc/version as utf8, and returns an empty string when it is unreadable", async () => {
		const readable = await loadWsl({ version: "Linux version 5.15-microsoft-standard-WSL2" });
		assert.equal(readable.wslProbe.procVersion(), "Linux version 5.15-microsoft-standard-WSL2");
		assert.deepEqual(readable.calls.read, [["/proc/version", "utf8"]]);
		const unreadable = await loadWsl({ version: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
		assert.equal(unreadable.wslProbe.procVersion(), "");
	});

	test("isWsl() and wslNoWindowsHint() default to the real probe", async () => {
		const wsl = await loadWsl({ exists: true });
		assert.equal(wsl.isWsl(), true);
		assert.match(wsl.wslNoWindowsHint(), /^Running under WSL2/);
		const plain = await loadWsl({ exists: false, version: "Linux version 6.8.0-generic" });
		const env = { ...process.env };
		delete process.env.WSL_DISTRO_NAME;
		delete process.env.WSL_INTEROP;
		try {
			assert.equal(plain.isWsl(), false);
			assert.equal(plain.wslNoWindowsHint(), undefined);
		} finally {
			Object.assign(process.env, env);
		}
	});
});
