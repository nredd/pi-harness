import { readFileSync } from "node:fs";

/** Tracking issue for reaching Windows host windows from a WSL2 guest. */
export const WSL2_BRIDGE_ISSUE = "nredd/pi-harness#668";

/** Inputs for WSL detection; tests replace the fields on {@link wslProbe}. */
export interface WslProbe {
	/** Environment of the Pi process. */
	env(): NodeJS.ProcessEnv;
	/** Contents of `/proc/version`, or an empty string when unreadable. */
	procVersion(): string;
}

/** Real probe by default; tests assign fields to inject an environment or kernel string. */
export const wslProbe: WslProbe = {
	env: () => process.env,
	procVersion(): string {
		try {
			return readFileSync("/proc/version", "utf8");
		} catch {
			return "";
		}
	},
};

/**
 * Detect a WSL guest from `WSL_DISTRO_NAME`/`WSL_INTEROP` or a Microsoft kernel string.
 * @param probe Environment and kernel version source.
 * @returns True when running inside WSL.
 */
export function isWsl(probe: WslProbe = wslProbe): boolean {
	const env = probe.env();
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	return /microsoft|wsl/i.test(probe.procVersion());
}

/**
 * Explain why no windows are visible when Pi runs in a WSL2 guest.
 * @param probe Environment and kernel version source.
 * @returns The explanation, or undefined outside WSL.
 */
export function wslNoWindowsHint(probe: WslProbe = wslProbe): string | undefined {
	if (!isWsl(probe)) return undefined;
	return `Running under WSL2: Windows host windows are not reachable from the WSL2 guest, because the Linux backend only sees the guest's AT-SPI bus. Only Linux apps inside the guest (e.g. via WSLg) can be observed or acted on. See ${WSL2_BRIDGE_ISSUE}.`;
}
