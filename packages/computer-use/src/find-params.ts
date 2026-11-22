import type { FindParams } from "./contract.ts";
import type { PlatformName } from "./platform/types.ts";

export function assertMacosPidUpperBound(pid: number, field: string): void {
	if (pid > 2147483647) throw new Error(`${field} must be at most 2147483647 on macOS.`);
}

export function normalizeFindParams(params: FindParams | null | undefined, platform?: PlatformName): FindParams {
	const rawParams = params ?? {};
	if (
		rawParams.pid !== undefined &&
		(!Number.isFinite(rawParams.pid) || !Number.isInteger(rawParams.pid) || rawParams.pid <= 0)
	) {
		throw new Error("find_roots.pid must be a positive integer when provided.");
	}
	if (platform === "macos" && rawParams.pid !== undefined) assertMacosPidUpperBound(rawParams.pid, "find_roots.pid");
	return {
		text: trimOrUndefined(rawParams.text),
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: rawParams.pid,
		kind: rawParams.kind,
	};
}

function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
