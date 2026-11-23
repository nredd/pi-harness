import { effectiveBlockedBundleIds, getComputerUseConfig } from "../../config.ts";
import { assertMacosPidUpperBound } from "../../find-params.ts";
import { type LookResponse, parseLookResponse } from "../../outline.ts";
import { toBoolean, toFiniteNumber, toOptionalBoolean, toOptionalString } from "../coerce.ts";
import type {
	ComputerUsePlatformBackend,
	FramePoints,
	HelperActResult,
	PlatformActRequest,
	PlatformApp,
	PlatformFocusWindowResult,
	PlatformFrontmostResult,
	PlatformObserveRequest,
	PlatformReadTextRequest,
	PlatformReadTextResponse,
	PlatformRoot,
	PlatformRootKind,
	PlatformRootList,
	PlatformRootQuery,
	PlatformTarget,
	PlatformWaitForRequest,
	PlatformWaitForResponse,
} from "../types.ts";
import { macosActivityGlow, macosHelper } from "./helper.ts";

function parseApps(result: unknown): PlatformApp[] {
	const array = Array.isArray(result) ? result : (result as any)?.apps;
	if (!Array.isArray(array)) return [];

	return array
		.map((raw) => {
			const pid = Math.trunc(toFiniteNumber((raw as any)?.pid, NaN));
			if (!Number.isFinite(pid) || pid <= 0) return undefined;
			const appName = toOptionalString((raw as any)?.appName) ?? "Unknown App";
			return {
				appName,
				appId: toOptionalString((raw as any)?.bundleId),
				bundleId: toOptionalString((raw as any)?.bundleId),
				pid,
				isFrontmost: toBoolean((raw as any)?.isFrontmost),
			} as PlatformApp;
		})
		.filter((item): item is PlatformApp => Boolean(item));
}

function parseFramePoints(raw: unknown): FramePoints {
	const frame = (raw as any)?.framePoints ?? {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w, 1)),
		h: Math.max(1, toFiniteNumber(frame.h, 1)),
	};
}

/**
 * Resolve the `listRoots` PID filter. An absent, null or non-finite PID keeps the documented
 * unfiltered discovery. A finite PID must be an integer in `1...2147483647`; a fraction or
 * out-of-range value is rejected so it can never be coerced into a different process's PID.
 */
function macosRootPidFilter(pid: unknown): number | undefined {
	if (typeof pid !== "number" || !Number.isFinite(pid)) return undefined;
	if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer when provided.");
	assertMacosPidUpperBound(pid, "pid");
	return pid;
}

function parseRoots(result: unknown): PlatformRoot[] {
	const array = Array.isArray(result) ? result : (result as any)?.roots;
	if (!Array.isArray(array)) return [];

	return array.map((raw) => {
		const metadata =
			typeof (raw as any)?.metadata === "object" && (raw as any).metadata !== null
				? ((raw as any).metadata as Record<string, unknown>)
				: {};
		const kind = ["window", "menu", "sheet", "popover", "dialog"].includes((raw as any)?.kind)
			? ((raw as any).kind as PlatformRootKind)
			: "window";
		return {
			kind,
			rootRef: toOptionalString((raw as any)?.rootRef ?? (raw as any)?.windowRef),
			windowRef: toOptionalString((raw as any)?.windowRef ?? (raw as any)?.rootRef),
			windowId: Number.isFinite((raw as any)?.windowId) ? Math.trunc((raw as any).windowId) : undefined,
			pid: Number.isFinite((raw as any)?.pid) ? Math.trunc((raw as any).pid) : undefined,
			appName: toOptionalString((raw as any)?.appName),
			appId: toOptionalString((raw as any)?.bundleId),
			bundleId: toOptionalString((raw as any)?.bundleId),
			title: toOptionalString((raw as any)?.title) ?? "",
			role: toOptionalString((raw as any)?.role),
			subrole: toOptionalString((raw as any)?.subrole),
			framePoints: parseFramePoints(raw),
			scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
			zOrder: Math.trunc(toFiniteNumber((raw as any)?.zOrder, 0)),
			isMinimized: toOptionalBoolean((raw as any)?.isMinimized),
			isOnscreen: toOptionalBoolean((raw as any)?.isOnscreen),
			isMain: toOptionalBoolean((raw as any)?.isMain),
			isFocused: toOptionalBoolean((raw as any)?.isFocused),
			isModal: toBoolean((raw as any)?.isModal),
			metadata,
		};
	});
}

/**
 * Single wire spelling of a native root target: `windowId` only when positive, `windowRef` from
 * either `windowRef` or `rootRef`. Every macOS helper call routes its target through here.
 */
export function normalizeTarget<T extends PlatformTarget>(
	target: T,
): Omit<T, "rootRef" | "windowRef" | "windowId"> & { windowId?: number; windowRef?: string } {
	const { rootRef, windowRef, windowId, ...rest } = target;
	const ref = windowRef ?? rootRef;
	return {
		...rest,
		...(typeof windowId === "number" && Number.isFinite(windowId) && windowId > 0
			? { windowId: Math.trunc(windowId) }
			: {}),
		...(ref ? { windowRef: ref } : {}),
	};
}

function helperAction(request: PlatformActRequest): Record<string, unknown> {
	if (!("focus" in request.target)) return { ...request };
	return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}

export const macosBackend: Pick<
	ComputerUsePlatformBackend,
	| "shutdown"
	| "setActivity"
	| "listApps"
	| "listRoots"
	| "getFrontmost"
	| "focusWindow"
	| "observe"
	| "act"
	| "actBatch"
	| "readText"
	| "waitFor"
> = {
	async shutdown(): Promise<void> {
		await macosActivityGlow.close();
	},

	async setActivity(active: boolean): Promise<void> {
		await macosActivityGlow.setActive(active);
	},
	async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
		return parseApps(await macosHelper.command<unknown>("listApps", {}, { signal }));
	},

	async listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRootList> {
		const pid = macosRootPidFilter(query.pid);
		const reply = await macosHelper.command<unknown>(
			"listRoots",
			{
				...(pid === undefined ? {} : { pid }),
				...(query.title?.trim() ? { title: query.title.trim() } : {}),
			},
			{ signal },
		);
		// A partial listing still resolves the roots it names by identity, but its omissions never prove closure.
		const complete = (reply as { complete?: unknown } | undefined)?.complete === true;
		if (query.authoritative && !complete)
			throw Object.assign(
				new Error(
					`The Accessibility root inventory${pid === undefined ? "" : ` of pid ${pid}`} is not known to be complete; its missing roots are unknown, not closed.`,
				),
				{ code: "inventory_incomplete" },
			);
		const roots: PlatformRootList = parseRoots(reply);
		// A reply without `complete: true`, e.g. from an older external helper, is partial.
		if (!complete) roots.complete = false;
		return roots;
	},

	async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
		const result = await macosHelper.command<any>("getFrontmost", {}, { signal });
		const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
		if (!Number.isFinite(pid) || pid <= 0) {
			throw new Error("No frontmost app was available for screenshot targeting.");
		}
		return {
			appName: toOptionalString(result?.appName) ?? "Unknown App",
			appId: toOptionalString(result?.bundleId),
			bundleId: toOptionalString(result?.bundleId),
			pid,
			windowTitle: toOptionalString(result?.windowTitle),
			windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
		};
	},

	async focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult> {
		return await macosHelper.command<PlatformFocusWindowResult>("focusWindow", normalizeTarget(target), { signal });
	},

	async observe(
		request: PlatformObserveRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<LookResponse> {
		return parseLookResponse(
			await macosHelper.command(
				"look",
				{
					baseLookId: request.baseLookId,
					...normalizeTarget(request.target),
					maxDimension: request.maxDimension,
					readText: request.readText,
					scopeRef: request.scopeRef,
					includeImage: request.includeImage,
				},
				options,
			),
		);
	},

	async act(
		request: PlatformActRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<HelperActResult> {
		return await macosHelper.command<HelperActResult>(
			"act",
			{
				...helperAction(request),
				cursorOverlay: getComputerUseConfig().cursor_overlay,
				blockedBundleIds: effectiveBlockedBundleIds(),
			},
			options,
		);
	},

	async actBatch(
		requests: PlatformActRequest[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<HelperActResult> {
		const cursorOverlay = getComputerUseConfig().cursor_overlay;
		const blockedBundleIds = effectiveBlockedBundleIds();
		return await macosHelper.command<HelperActResult>(
			"actBatch",
			{ actions: requests.map((request) => ({ ...helperAction(request), cursorOverlay, blockedBundleIds })) },
			options,
		);
	},

	async readText(
		args: PlatformReadTextRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PlatformReadTextResponse> {
		return await macosHelper.command("axReadText", { ...args }, options);
	},

	async waitFor(
		args: PlatformWaitForRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PlatformWaitForResponse> {
		const reply = await macosHelper.command<PlatformWaitForResponse & { complete?: unknown }>(
			"axWaitFor",
			normalizeTarget(args),
			options,
		);
		// Only a helper that reports `complete` walked and read the whole scope; anything else fails closed.
		if (args.gone && reply?.found && reply.complete !== true) {
			const { gone: _gone, ...rest } = reply;
			return { ...rest, found: false, incomplete: true };
		}
		return reply;
	},
};
