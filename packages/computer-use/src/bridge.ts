import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, rmSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { debuglog } from "node:util";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canRetryInForeground, outcomeAfterCheck, outcomeAfterObservedValues, prepareAction, strictHeadlessRejection, unsupportedActionRejection, type ActionState, type PreparedAction } from "./actions.ts";
import { cdpClickForContext, cdpDragForContext, cdpEvaluateForContext, cdpKeypressForContext, cdpMouseForContext, cdpNavigateContext, cdpScrollForContext, cdpSnapshotForContext, cdpTabForWindow, cdpTypeFocusedForContext, cdpTypeForContext, disconnectCdp, listCdpPageContexts, type CdpConsoleEntry, type CdpPageSnapshot } from "./cdp.ts";
import { type ComputerUseConfig, getComputerUseConfig, isBlockedBundleId, isBrowserUseEnabled, isHeadlessMode, loadComputerUseConfig } from "./config.ts";
import { normalizeFindParams } from "./find-params.ts";
import { noteAfterAct, noteFromLook, noteRegionKeyForRef, renderNote, type WindowNote } from "./note.ts";
import { loadStoredOutline, saveStoredOutline } from "./outline-store.ts";
import { controlLine, foldToBudget, graftScopedOutline, nodeByRef, outlineNodeLabel, outlineNodePath, rankedTextMatch, renderInteractiveControls, restoreOutline, searchOutline, searchOutlineRanked, serializeOutline, serializeOutlineNodeShallow, serializeOutlineSearchMatch, type LookResponse, type Outline, type OutlineChange, type OutlineDiff, type OutlineNode, type OutlineSearchMatch, type SerializedOutline, type SerializedOutlineNode, type SerializedOutlineSearchMatch } from "./outline.ts";
import { applyOutputEnvelope, boundToolError, clearStoredOutputs, readStoredOutput, UI_TEXT_PAGE_CHARS } from "./output.ts";
import { AGENT_TOOL_NAMES, type ActParams, type EvaluateBrowserParams, type ExpandUiParams, type ImageMode, type InspectUiParams, type LaunchBrowserParams, type FindParams, type NavigateBrowserParams, type ObserveDetail, type ObserveParams, type ObserveTargetParams, type ReadTextParams, type RootSelector, type SearchUiParams, type UiAction, type WaitForParams } from "./contract.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { currentPlatformBackend } from "./platform/index.ts";
import type { FramePoints, HelperActPerformed, HelperActResult, NativeInputDelivery, PlatformActRequest, PlatformApp as HelperApp, PlatformDiagnostics, PlatformFrontmostResult as FrontmostResult, PlatformRoot as HelperWindow } from "./platform/types.ts";
import type { PermissionStatus } from "./permissions.ts";
import { ResourceScheduler } from "./runtime.ts";
import { scoreWindow, shouldPreferForegroundModalWindow } from "./root-selection.ts";
import { withDesktopTransaction, withPhysicalInput } from "./desktop.ts";
import type { PlatformRoot } from "./platform/types.ts";
import { SavedStates, type CurrentCapture, type CurrentTarget, type OperationState } from "./state.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "./view.ts";
export type { ActParams, EvaluateBrowserParams, ExpandUiParams, ImageMode, InspectUiParams, LaunchBrowserParams, FindParams, MouseButtonName, NavigateBrowserParams, ObserveParams, ObserveTargetParams, ReadTextParams, RootSelector, SearchUiParams, StateTargetParams, UiAction, WaitForParams } from "./contract.ts";

interface ActivationFlags {
	activated: boolean;
	unminimized: boolean;
	raised: boolean;
}

type ExecutionVariant = "stealth" | "default";
type ActionDelivery = "ax" | NativeInputDelivery;
type DeliveryPolicy = "ax_only" | "background" | "default" | "foreground";
type ActOutcome = "worked" | "didnt" | "unknown";

interface ExecutionTrace {
	strategy:
		| "look"
		| "act"
		| "wait"
		| "browser_open_location"
		| "cdp_navigate";
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	delivery?: ActionDelivery;
	deliveryPolicy?: DeliveryPolicy;
	outcome?: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: HelperActResult["error"];
	rootDelta?: HelperActResult["rootDelta"];
	steps?: ExecutionTrace[];
	actionCount?: number;
	stoppedAt?: number;
	backgroundFirst?: boolean;
	escalatedToForeground?: boolean;
	escalationReason?: string;
	backgroundAttempt?: { outcome: "foreground_required" | "didnt"; reason: string };
	verification?: {
		status: "verified" | "preexisting" | "failed";
		text?: string;
		role?: string;
		value?: string;
		gone?: boolean;
		timeoutMs: number;
	};
}

interface ComputerUseDetails {
	tool: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	capture: {
		stateId: string;
		width: number;
		height: number;
		scaleFactor: number;
		timestamp: number;
		coordinateSpace: "window-relative-screenshot-pixels";
	};
	lookId?: string;
	view: "full" | "diff";
	baseStateId?: string;
	changes?: OutlineChange[];
	viewReason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
	renderedOutline?: string;
	detail?: ObserveDetail;
	/** Legacy sessions only: new results keep the outline in the outline store, keyed by `capture.stateId`. */
	outline?: SerializedOutline;
	note?: WindowNote;
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		headless: boolean;
	};
	helper?: PlatformDiagnostics;
	status?: "ok";
	axDiagnostics?: {
		reason?: string;
		message?: string;
		debug?: unknown;
	};
	/** Recent browser console messages/exceptions; only present when CDP is active. */
	console?: CdpConsoleEntry[];
	imageReason?:
		| "fallback_recovery"
		| "browser_ax_window_unavailable"
		| "no_ax_targets"
		| "sparse_ax_targets"
		| "weak_ax_targets"
		| "unlabeled_ax_targets"
		| "duplicated_ax_labels"
		| "browser_wait_verification";
}
interface TerminalDesktopActionDetails {
	tool: "act_ui";
	status: "target_closed" | "post_action_observation_failed";
	/** Why the source root is gone: `replaced` when new roots of the same pid appeared. */
	cause?: "replaced" | "closed";
	successors?: Array<{ ref?: string; kind: string; title?: string; isModal?: boolean }>;
	baseStateId: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	execution: ExecutionTrace;
	error: { code: string; message: string };
}


interface ListWindowsDetails {
	tool: "find_roots";
	query: FindParams;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	windows: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		kind: string;
		windowTitle: string;
		windowId?: number;
		windowRef: string;
		nativeWindowRef?: string;
		framePoints: FramePoints;
		scaleFactor: number;
		isMinimized: boolean;
		isOnscreen: boolean;
		isMain: boolean;
		isFocused: boolean;
		isModal: boolean;
		sheetCount?: number;
		role?: string;
		subrole?: string;
		pairing?: { confidence: "exact" | "high" | "low"; score: number };
		zOrder: number;
		browserUseAllowed: boolean;
		blocked: boolean;
		score: number;
		url?: string;
	}>;
	config: {
		browser_use: boolean;
		headless: boolean;
	};
}

interface BrowserObservationDetails {
	tool: string;
	kind: "browser_page";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	root: { ref: string; kind: "browser_page"; title: string; url: string };
	renderedOutline: string;
	detail?: ObserveDetail;
}

interface EvaluateBrowserDetails {
	tool: "evaluate_browser";
	baseStateId: string;
	stateId: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	renderedOutline: string;
}

interface ReadTextDetails {
	tool: "read_text";
	ref?: string;
	offset: number;
	limit: number;
	totalChars?: number;
	totalBytes?: number;
	hasMore: boolean;
	complete?: boolean;
	text: string;
}

interface WaitForDetails {
	tool: "wait_for";
	stateId: string;
	baseStateId?: string;
	view: "full" | "diff";
	changes?: OutlineChange[];
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	target?: SerializedOutlineSearchMatch;
	nodeCount?: number;
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	renderedOutline: string;
}

interface OutlineToolDetails {
	tool: "search_ui" | "expand_ui" | "inspect_ui";
	stateId?: string;
	lookId?: string;
	outline?: SerializedOutline;
	renderedOutline?: string;
	totalMatches?: number;
	returned?: number;
	hasMore?: boolean;
	matches?: SerializedOutlineSearchMatch[];
	target?: SerializedOutlineNode;
	note?: WindowNote;
}

interface ResolvedTarget extends CurrentTarget {
	windowRef: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface WindowRefRecord {
	ref: string;
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId?: number;
	nativeWindowRef?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

interface RuntimeState {
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	browserRootByContext: Map<string, string>;
	browserContextByRoot: Map<string, string>;
	nextRootRefIndex: number;
	managedBrowser?: ChildProcess;
	managedBrowserCdpPort?: string;
	previousCdpPort?: string;
	permissionStatus?: PermissionStatus;
	helperDiagnostics?: PlatformDiagnostics;
	lastPermissionCheckAt: number;
}


const MISSING_TARGET_ERROR = "No current controlled window. Call observe_ui first to choose a target window.";
const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call observe_ui to choose a new target window.";

const COMMAND_TIMEOUT_MS = 15_000;
const LOOK_TIMEOUT_MS = 33_000;

const ACTION_SETTLE_MS = 280;

const BROWSER_CONTEXT_PREFIX = "browser:";
const MANAGED_BROWSER_READY_TIMEOUT_MS = 15_000;
/** How long session shutdown waits for the managed browser after SIGTERM, then again after SIGKILL. */
const MANAGED_BROWSER_EXIT_TIMEOUT_MS = 5_000;
const AUTO_IMAGE_MAX_DIMENSION = 900;
const EXPLICIT_IMAGE_MAX_DIMENSION = 1_600;
const BROWSER_TRANSACTION_ACTIONS = new Set<UiAction["action"]>(["press", "click", "setText", "typeText", "keypress", "scroll", "drag", "moveMouse"]);

const runtimeState: RuntimeState = {
	lastPermissionCheckAt: 0,
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	browserRootByContext: new Map(),
	browserContextByRoot: new Map(),
	nextRootRefIndex: 1,
};

const savedStates = new SavedStates();
/** Test seam: lets scripts run bridge internals inside an operation state. */
export const testing = { assertBrowserTransactionAction, savedState: (stateId: string) => savedStates.get(stateId), runInOperation: <T>(fn: () => T, state: OperationState = {}): T => savedStates.operations.run(state, fn), buildToolResult, browserObservationResult, waitForViewText, sameRootIdentity, performSearchUi, performLaunchBrowser, removeProfileDirsOnExit, managedBrowserNeedsHeadless, managedBrowserArgs, managedBrowserExecutableCandidates };
let resourceScheduler = new ResourceScheduler();

function operationState(): OperationState {
	return savedStates.current();
}

function desktopResourceKey(target: Pick<CurrentTarget, "pid">): string {
	return `desktop-pid:${target.pid}`;
}

function persistOperation(state: OperationState): void {
	// Every desktop capture and hydrated state carries its resource identity alongside the target and look.
	if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline || !state.resourceKey || state.epoch === undefined) return;
	savedStates.saveDesktop(state, state.resourceKey, state.epoch);
}

export async function setComputerUseActivity(active: boolean): Promise<void> {
	await currentPlatformBackend.setActivity?.(active);
}

/** Release handles and state owned by the current Pi session. */
export async function shutdownComputerUseSession(): Promise<void> {
	await resourceScheduler.close();
	resourceScheduler = new ResourceScheduler();
	disconnectCdp();

	// Waits for a `launch_browser` already stopping, creating or spawning a browser, then stops what it produced.
	await withManagedBrowserLifecycle(releaseManagedBrowser);

	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.browserRootByContext.clear();
	runtimeState.browserContextByRoot.clear();
	runtimeState.nextRootRefIndex = 1;
	runtimeState.permissionStatus = undefined;
	runtimeState.helperDiagnostics = undefined;
	runtimeState.lastPermissionCheckAt = 0;
	await currentPlatformBackend.shutdown?.();
}

function currentRuntimeMode(): ExecutionVariant {
	return isHeadlessMode() ? "stealth" : "default";
}

function nativeInputDelivery(policy: DeliveryPolicy): NativeInputDelivery {
	return policy === "foreground" ? "hid" : "pid";
}

function executionTrace(
	strategy: ExecutionTrace["strategy"],
	variant: ExecutionVariant,
	metadata: Omit<ExecutionTrace, "strategy" | "runtimeMode" | "variant" | "stealthCompatible"> = {},
): ExecutionTrace {
	return {
		strategy,
		runtimeMode: currentRuntimeMode(),
		variant,
		stealthCompatible: variant === "stealth",
		...metadata,
	};
}

function settleMsForExecution(execution: ExecutionTrace): number {
	// Any deltaSource means the helper already awaited UI quiescence; the
	// bridge must not double-pay with its own settle sleep.
	if (execution.performed?.deltaSource) return 0;
	if (execution.variant === "stealth") return 120;
	return ACTION_SETTLE_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function withWindowWriteLock<T>(target: ResolvedTarget | CurrentTarget, work: () => Promise<T>): Promise<T> {
	const state = operationState();
	const key = desktopResourceKey(target);
	// Callers run on a hydrated or freshly captured desktop state, which always carries its epoch.
	const result = await resourceScheduler.write(key, state.epoch!, async (nextEpoch) => {
		state.resourceKey = key;
		state.epoch = nextEpoch;
		return await work();
	});
	return result.value;
}


function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function outlineNodeCenter(node: OutlineNode): { x: number; y: number } {
	if (!node.rect) {
		throw new Error(`Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`);
	}
	return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2 };
}

/** `executeTool` already hydrated this operation from `params.stateId`, so the capture can only be missing when no state was supplied. */
function currentCaptureOrThrow(): CurrentCapture {
	const capture = operationState().currentCapture;
	if (!capture) {
		throw new Error("No observation state is available. Call observe_ui first.");
	}
	return capture;
}

function formatOutlineNodeLabel(node: OutlineNode): string {
	const label = outlineNodeLabel(node) || "(unlabeled)";
	const identifier = node.identifier ? ` id=${JSON.stringify(node.identifier)}` : "";
	const capabilities = [
		node.canSetValue ? "setValue" : undefined,
		node.canPress ? "press" : undefined,
		node.canFocus ? "focus" : undefined,
		node.canScroll ? "scroll" : undefined,
		node.canIncrement || node.canDecrement ? "adjust" : undefined,
		node.pictureOnly ? "pictureOnly" : undefined,
	].filter((item): item is string => Boolean(item));
	return `${node.ref} ${node.role}${node.subrole ? `/${node.subrole}` : ""}${identifier} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

function outlineNodeByRef(ref: string): OutlineNode {
	const state = operationState();
	const node = nodeByRef(currentOutlineOrThrow(), ref);
	if (!node) {
		const windowHint = state.currentTarget?.windowRef ? `({ root: "${state.currentTarget.windowRef}" })` : "";
		throw new Error(`Outline ref '${ref}' is stale or not available for the latest state. Call observe_ui${windowHint} again and choose a current @e ref.`);
	}
	return node;
}

function wireRefForNode(node: OutlineNode): string {
	if (node.pictureOnly || !node.wireRef) {
		throw new Error(`Outline ref '${node.ref}' is pictureOnly and has no semantic element. It can be clicked by coordinates, but semantic-only actions are not available.`);
	}
	return node.wireRef;
}

function imageFallbackReason(
	tool: string,
	result: CaptureResult,
	imageMode: ImageMode,
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always") return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	const outline = result.outline;
	const labeled = outline.nodes.filter((node) => outlineNodeLabel(node)).length;
	if (outline.nodes.length < 3) {
		return { reason: "sparse_ax_targets", message: "Only a few outline nodes were found, so the look image is attached for context." }
	}
	if (labeled * 3 < outline.nodes.length) {
		return { reason: "unlabeled_ax_targets", message: "Most outline nodes are unlabeled, so the look image is attached for context." }
	}
	if (tool === "wait" && currentPlatformBackend.isBrowserApp(result.target.appName, result.target.bundleId)) {
		return { reason: "browser_wait_verification", message: "Browser content may have changed visually during wait, so an image is attached for fallback." }
	}
	return undefined
}

function currentTargetOrThrow(): CurrentTarget {
	const target = operationState().currentTarget;
	if (!target) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	return target;
}

function emptyActivation(): ActivationFlags {
	return { activated: false, unminimized: false, raised: false };
}

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	loadComputerUseConfig(ctx.cwd);

	throwIfAborted(signal);
	const ready = await currentPlatformBackend.ensureReady(
		ctx,
		{
			permissionStatus: runtimeState.permissionStatus,
			lastPermissionCheckAt: runtimeState.lastPermissionCheckAt,
			helperDiagnostics: runtimeState.helperDiagnostics,
		},
		signal,
	);
	runtimeState.permissionStatus = ready.permissionStatus;
	runtimeState.lastPermissionCheckAt = ready.lastPermissionCheckAt;
	runtimeState.helperDiagnostics = ready.helperDiagnostics;
}

export async function ensureComputerUseSetup(ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
	await ensureReady(ctx, signal);
}

async function listApps(signal?: AbortSignal): Promise<HelperApp[]> {
	return await currentPlatformBackend.listApps(signal);
}

async function listWindows(pid: number, signal?: AbortSignal): Promise<HelperWindow[]> {
	return await currentPlatformBackend.listRoots({ pid }, signal);
}

function appMatchesWindowQuery(app: HelperApp, query: FindParams): boolean {
	const appQuery = trimOrUndefined(query.app);
	const bundleQuery = trimOrUndefined(query.bundleId);
	const pidQuery = Number.isFinite(query.pid) ? Math.trunc(query.pid!) : undefined;

	if (pidQuery !== undefined && app.pid !== pidQuery) return false;
	if (bundleQuery && normalizeText(app.bundleId ?? "") !== normalizeText(bundleQuery)) return false;
	if (appQuery && normalizeText(app.appName) !== normalizeText(appQuery)) return false;
	return true;
}

function platformRootSheetCount(window: Pick<HelperWindow, "metadata">): number | undefined {
	const value = window.metadata?.sheetCount;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function platformRootPairing(window: Pick<HelperWindow, "metadata">): { confidence: "exact" | "high" | "low"; score: number } | undefined {
	const value = window.metadata?.pairing;
	if (!value || typeof value !== "object") return undefined;
	const pairing = value as { confidence?: unknown; score?: unknown };
	if (pairing.confidence !== "exact" && pairing.confidence !== "high" && pairing.confidence !== "low") return undefined;
	return { confidence: pairing.confidence, score: typeof pairing.score === "number" && Number.isFinite(pairing.score) ? pairing.score : Number.NEGATIVE_INFINITY };
}

function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
	if (window.kind === "browser_page") return `- ${window.windowRef} browser_page ${JSON.stringify(window.windowTitle)}${window.url ? ` — ${window.url}` : ""}`;
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isModal ? "modal" : undefined,
		window.sheetCount ? `sheets=${window.sheetCount}` : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
		window.browserUseAllowed ? undefined : "browser_use_disabled",
		window.blocked ? "blocked" : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
	const id = window.windowId ? `windowId ${window.windowId}` : window.nativeWindowRef ? `nativeRootRef ${window.nativeWindowRef}` : "unstable root id";
	const pairing = window.pairing ? `, pairing ${window.pairing.confidence}/${Math.round(window.pairing.score)}` : "";
	return `- ${window.windowRef} ${window.kind} ${window.app} pid ${window.pid} — ${window.windowTitle} (z ${window.zOrder}, ${id}, frame ${frame}${pairing}${flags ? `, ${flags}` : ""})`;
}

async function getFrontmost(signal?: AbortSignal): Promise<FrontmostResult> {
	return await currentPlatformBackend.getFrontmost(signal);
}

function assertBrowserUseAllowed(target: { appName: string; bundleId?: string }): void {
	if (!isBrowserUseEnabled() && currentPlatformBackend.isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(
			`Browser use is disabled by pi-computer-use config, so '${target.appName}' cannot be controlled. Enable browser_use in ~/.pi/agent/extensions/pi-computer-use.json or .pi/computer-use.json to allow browser windows.`,
		);
	}
}

/** Policy refusal raised before any native call; `code` mirrors the helper's coded errors. */
class ComputerUseError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ComputerUseError";
	}
}

/** Fail closed with `app_blocked` for password managers, credential UIs, terminals and system auth agents. */
function assertAppNotBlocked(target: { appName: string; bundleId?: string }): void {
	if (!isBlockedBundleId(target.bundleId)) return;
	throw new ComputerUseError(
		"app_blocked",
		`app_blocked: '${target.appName}' (${target.bundleId}) is blocked by pi-computer-use policy, so it cannot be observed or controlled. Adjust blocked_apps in ~/.pi/agent/extensions/pi-computer-use.json (system authentication agents are always blocked).`,
	);
}

function windowRecordIdentity(record: Pick<WindowRefRecord, "pid" | "windowId" | "nativeWindowRef" | "windowTitle" | "framePoints">): string {
	if (record.windowId && record.windowId > 0) {
		return `pid:${record.pid}|id:${record.windowId}`;
	}
	if (record.nativeWindowRef) {
		return `pid:${record.pid}|ref:${record.nativeWindowRef}`;
	}
	const { x, y, w, h } = record.framePoints;
	return `pid:${record.pid}|title:${normalizeText(record.windowTitle)}|frame:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

function storeWindowRef(record: Omit<WindowRefRecord, "ref">): WindowRefRecord {
	const identity = windowRecordIdentity(record);
	// `windowRefs` and `windowRefByIdentity` are only ever written and cleared together.
	const existingRef = runtimeState.windowRefByIdentity.get(identity);
	if (existingRef) {
		const updated = { ...record, ref: existingRef };
		runtimeState.windowRefs.set(existingRef, updated);
		return updated;
	}

	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	const stored = { ...record, ref };
	runtimeState.windowRefByIdentity.set(identity, ref);
	runtimeState.windowRefs.set(ref, stored);
	return stored;
}

function storeBrowserRootRef(contextId: string): string {
	const existing = runtimeState.browserRootByContext.get(contextId);
	if (existing) return existing;
	const ref = `@r${runtimeState.nextRootRefIndex++}`;
	runtimeState.browserRootByContext.set(contextId, ref);
	runtimeState.browserContextByRoot.set(ref, contextId);
	return ref;
}

function storeWindowRefForAppWindow(app: HelperApp, window: HelperWindow): WindowRefRecord {
	return storeWindowRef({
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: window.windowId,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	});
}

/** Highest-scoring root; callers pass a non-empty list. */
function choosePreferredWindow(windows: HelperWindow[]): HelperWindow {
	return [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
}

function summarizeWindowCandidate(window: HelperWindow): string {
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
	]
		.filter(Boolean)
		.join(",");
	return `${window.title} [score=${scoreWindow(window)}${flags ? `, ${flags}` : ""}]`;
}

function summarizeWindowCandidates(windows: HelperWindow[], limit = 6): string {
	return [...windows]
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))
		.slice(0, limit)
		.map(summarizeWindowCandidate)
		.join("; ");
}

function chooseRankedWindowOrUndefined(windows: HelperWindow[]): HelperWindow | undefined {
	const ranked = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	if (ranked.length === 1) return ranked[0];
	const topScore = scoreWindow(ranked[0]);
	const nextScore = scoreWindow(ranked[1]);
	return topScore >= nextScore + 25 ? ranked[0] : undefined;
}

function toResolvedTarget(app: HelperApp, window: HelperWindow): ResolvedTarget {
	const baseTarget = {
		appName: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		windowTitle: window.title || "(untitled)",
		windowId: typeof window.windowId === "number" ? window.windowId : 0,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
	};
	return { ...baseTarget, windowRef: storeWindowRefForAppWindow(app, window).ref };
}

/** Platform target for a resolved root: `windowId` only when real (> 0), the native ref under both spellings. */
export function nativeWindowRequest(target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">): { pid: number; windowId?: number; rootRef?: string; windowRef?: string } {
	return {
		pid: target.pid,
		...(target.windowId > 0 ? { windowId: target.windowId } : {}),
		...(target.nativeWindowRef ? { rootRef: target.nativeWindowRef, windowRef: target.nativeWindowRef } : {}),
	};
}

function setCurrentTarget(target: ResolvedTarget): void {
	assertBrowserUseAllowed(target);
	assertAppNotBlocked(target);
	operationState().currentTarget = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
		windowTitle: target.windowTitle,
		windowId: target.windowId,
		windowRef: target.windowRef,
		nativeWindowRef: target.nativeWindowRef,
	};
}

function normalizeWindowSelector(selector: RootSelector | undefined): string | undefined {
	return trimOrUndefined(selector);
}

/** `observe_ui` admits only exact `@r` refs (see `performObserve`), so a selector is either the current root or a ref `find_roots` issued. */
async function resolveTargetByWindowSelector(selector: string, signal?: AbortSignal): Promise<ResolvedTarget> {
	const current = operationState().currentTarget;
	if (current?.windowRef === selector) {
		return await resolveCurrentTarget(signal);
	}

	const fromRef = runtimeState.windowRefs.get(selector);
	if (!fromRef) {
		throw new Error(`Root ref '${selector}' is not available in this session. Call find_roots first.`);
	}
	const app: HelperApp = { appName: fromRef.appName, bundleId: fromRef.bundleId, pid: fromRef.pid };
	const windows = await listWindows(fromRef.pid, signal);
	const match =
		(fromRef.windowId ? windows.find((window) => window.windowId === fromRef.windowId) : undefined) ??
		(fromRef.nativeWindowRef ? windows.find((window) => window.windowRef === fromRef.nativeWindowRef) : undefined) ??
		windows.find((window) => normalizeText(window.title || "(untitled)") === normalizeText(fromRef.windowTitle));
	if (!match) {
		throw new Error(`Root ref '${selector}' is stale. Call find_roots again and choose a current window.`);
	}
	const resolved = toResolvedTarget(app, match);
	setCurrentTarget(resolved);
	return resolved;
}

/**
 * Re-resolve the current root. `preferModal` (observe) may move to a confirmed foreground modal; act
 * transactions pass `false` so actions and the successor capture stay on the root the state belongs to.
 */
async function resolveCurrentTarget(signal?: AbortSignal, options: { preferModal?: boolean } = {}): Promise<ResolvedTarget> {
	const current = currentTargetOrThrow();
	const windows = await listWindows(current.pid, signal);
	if (!windows.length) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const hadStableWindowId = current.windowId > 0;
	const titleQuery = normalizeText(current.windowTitle);
	let match = current.nativeWindowRef ? windows.find((window) => window.windowRef === current.nativeWindowRef || window.rootRef === current.nativeWindowRef) : undefined;
	match ??= hadStableWindowId ? windows.find((window) => window.windowId !== undefined && window.windowId === current.windowId) : undefined;
	if (!match) {
		const exactTitleMatches = titleQuery && titleQuery !== "(untitled)" ? windows.filter((window) => normalizeText(window.title) === titleQuery) : [];
		if (exactTitleMatches.length === 1) {
			match = exactTitleMatches[0];
		} else if (exactTitleMatches.length > 1) {
			match = chooseRankedWindowOrUndefined(exactTitleMatches);
			if (!match) {
				throw new Error(
					`${CURRENT_TARGET_GONE_ERROR} Multiple windows now match '${current.windowTitle}': ${summarizeWindowCandidates(exactTitleMatches)}.`,
				);
			}
		}
	}

	if (!match && !hadStableWindowId) {
		match = chooseRankedWindowOrUndefined(windows);
	}

	if (!match) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const modal = options.preferModal === false ? undefined : windows
		.filter((window) => shouldPreferForegroundModalWindow(match!, window))
		.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
	if (modal) match = modal;

	const app: HelperApp = {
		appName: current.appName,
		bundleId: current.bundleId,
		pid: current.pid,
	};

	const resolved = toResolvedTarget(app, match);
	setCurrentTarget(resolved);
	return resolved;
}

async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const frontmost = await getFrontmost(signal);
	const apps = await listApps(signal);
	const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
		appName: frontmost.appName,
		bundleId: frontmost.bundleId,
		pid: frontmost.pid,
	};

	const windows = await listWindows(frontmost.pid, signal);
	if (!windows.length) {
		throw new Error("No frontmost controllable root was found. Open an app window and call observe_ui again.");
	}

	if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
		assertBrowserUseAllowed(app);
	}

	let selected = windows.find((window) => window.windowId !== undefined && window.windowId === frontmost.windowId);
	if (!selected && frontmost.windowTitle) {
		const title = normalizeText(frontmost.windowTitle);
		selected = windows.find((window) => normalizeText(window.title) === title);
	}
	selected ??= choosePreferredWindow(windows);

	const resolved = toResolvedTarget(app, selected);
	setCurrentTarget(resolved);
	return resolved;
}

function matchesObserveSelection(target: ResolvedTarget, selection: ObserveTargetParams): boolean {
	const root = normalizeWindowSelector(selection.root);
	return !root || target.windowRef === root;
}

async function resolveTargetForObserve(signal?: AbortSignal): Promise<ResolvedTarget> {
	return operationState().currentTarget ? await resolveCurrentTarget(signal) : await resolveFrontmostTarget(signal);
}

async function ensureTargetWindowId(target: ResolvedTarget, signal?: AbortSignal): Promise<ResolvedTarget> {
	if (target.windowId > 0 || target.nativeWindowRef) {
		return target;
	}

	const refreshed = await resolveCurrentTarget(signal);
	if (refreshed.windowId <= 0 && !refreshed.nativeWindowRef) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}
	return refreshed;
}

interface CaptureResult {
	target: ResolvedTarget;
	capture: CurrentCapture;
	look: LookResponse;
	outline: Outline;
	activation: ActivationFlags;
}

function captureForLook(look: LookResponse): CurrentCapture {
	return {
		stateId: randomUUID(),
		width: look.image?.width ?? 0,
		height: look.image?.height ?? 0,
		scaleFactor: look.window.scaleFactor,
		timestamp: Date.now(),
	};
}

async function performLook(target: ResolvedTarget, options: { readText: "auto" | "always" | "never"; baseLookId?: string; scopeRef?: string; maxDimension?: number; includeImage?: boolean }, signal?: AbortSignal): Promise<LookResponse> {
	return await currentPlatformBackend.observe({
		target: nativeWindowRequest(target),
		baseLookId: options.baseLookId,
		readText: options.readText,
		scopeRef: options.scopeRef,
		maxDimension: options.maxDimension,
		includeImage: options.includeImage,
	}, { signal, timeoutMs: LOOK_TIMEOUT_MS });
}

function noteWindowForTarget(target: ResolvedTarget | CurrentTarget, look?: LookResponse) {
	return {
		windowRef: target.windowRef,
		title: target.windowTitle,
		pairing: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { confidence?: "exact" | "high" | "low" }).confidence : undefined,
		pairingScore: look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object" ? (look.window.metadata.pairing as { score?: number }).score : undefined,
	};
}

async function captureCurrentTarget(signal: AbortSignal | undefined, readText: "auto" | "always" | "never", maxDimension = AUTO_IMAGE_MAX_DIMENSION, targetOverride?: ResolvedTarget, includeImage = true): Promise<CaptureResult> {
	const state = operationState();
	const baseOutline = state.currentOutline;
	const baseTarget = state.currentTarget;
	let target = targetOverride ?? await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const look = await performLook(target, { maxDimension, readText, includeImage }, signal);
	const outline = stabilizeRefs(baseTarget && sameRootIdentity(baseTarget, target) ? baseOutline : undefined, look.parsedOutline!);
	look.parsedOutline = outline;
	look.outline = outline.root;
	const capture = captureForLook(look);

	setCurrentTarget(target);
	state.currentCapture = capture;
	state.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	state.currentLook = look;
	state.currentOutline = outline;
	state.currentNote = noteFromLook(state.currentNote, outline, noteWindowForTarget(target, look));
	state.resourceKey = desktopResourceKey(target);
	state.epoch ??= resourceScheduler.epoch(state.resourceKey);

	return {
		target,
		capture,
		look,
		outline,
		activation: emptyActivation(),
	};
}

function renderStateView(outline: Outline, stateId: string, detail: ObserveDetail, reason?: string): { detail: ObserveDetail; text: string } {
	const reasonText = reason ? `, full view: ${reason}` : "";
	const controls = detail === "compact" ? renderInteractiveControls(outline) : undefined;
	if (controls?.controlCount) {
		const unlabeled = controls.omittedUnlabeled ? `, including ${controls.omittedUnlabeled} unlabeled control${controls.omittedUnlabeled === 1 ? "" : "s"}` : "";
		const footer = `… ${controls.nodeCount - controls.renderedRefs.length} other nodes hidden${unlabeled}. Use search_ui to find more; expand_ui({ stateId: "${stateId}", ref: "${outline.root.ref}", depth: 2 }) or observe_ui detail "outline" for structure.`;
		return { detail, text: `Controls (${controls.renderedRefs.length} of ${controls.nodeCount} nodes, stateId ${stateId}, root ${outline.root.ref}${reasonText}):\n${controls.text}\n${footer}` };
	}
	const folded = foldToBudget(outline);
	return { detail: "outline", text: `Outline (${folded.nodeCount} nodes, stateId ${stateId}${reasonText}${controls ? ", no actionable controls found" : ""}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}` };
}

async function buildToolResult(
	tool: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	_signal?: AbortSignal,
	imageMode: ImageMode = operationState().currentImageMode ?? "auto",
	base?: { stateId: string; outline: Outline },
	detail: ObserveDetail = "compact",
): Promise<AgentToolResult<ComputerUseDetails>> {
	const state = operationState();
	const fallbackReason = imageFallbackReason(tool, result, imageMode);
	const transition = base ? changesBetween(base.outline, result.outline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(result.outline);
	const view = useDiff ? undefined : renderStateView(result.outline, result.capture.stateId, detail, transition?.reason);
	const renderedNote = renderNote(state.currentNote);

	// The session file keeps only `capture.stateId`/`lookId`; restore reads the outline back from here.
	saveStoredOutline(result.capture.stateId, serializeOutline(result.outline));
	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef,
			nativeWindowRef: result.target.nativeWindowRef,
		},
		capture: {
			stateId: result.capture.stateId,
			width: result.capture.width,
			height: result.capture.height,
			scaleFactor: result.capture.scaleFactor,
			timestamp: result.capture.timestamp,
			coordinateSpace: "window-relative-screenshot-pixels",
		},
		lookId: result.look.lookId,
		view: useDiff ? "diff" : "full",
		baseStateId: transition ? base?.stateId : undefined,
		changes: useDiff ? transition?.changes : undefined,
		viewReason: transition?.useFullView ? transition.reason : undefined,
		renderedOutline: folded.text,
		detail: view?.detail,
		note: state.currentNote,
		activation: result.activation,
		execution,
		status: "ok",
		config: getComputerUseConfig(),
		helper: runtimeState.helperDiagnostics,
		imageReason: fallbackReason?.reason,
	};

	// Console piggyback: when a CDP connection is active for this browser
	// window, surface console output collected since the last tool result.
	let consoleText = "";
	if (currentPlatformBackend.isChromeFamilyApp(result.target.appName, result.target.bundleId)) {
		const tab = await cdpTabForWindow(result.target.windowTitle, result.target.framePoints);
		const entries = tab?.drainConsole() ?? [];
		if (entries.length > 0) {
			details.console = entries;
			consoleText = `\n\nBrowser console since the last action:\n${entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`;
		}
	}

	const noteText = renderedNote ? `\n\n${renderedNote}` : "";
	// The model must echo capture.stateId into follow-up tools. Exposing only the
	// helper-internal lookId here makes a plausible but invalid stateId easy to use.
	const renderedChanges = useDiff ? renderChanges(transition!.changes) : "";
	const outlineText = view
		? `\n\n${view.text}`
		: `\n\nChanges (${transition!.changedNodeCount}, ${base!.stateId} → ${result.capture.stateId}):\n${renderedChanges || "(no element changes)"}\nUse stateId ${result.capture.stateId} for subsequent actions and queries.`;
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const deltaText = rootDeltaLines(execution).join("\n");
	const content: AgentToolResult<ComputerUseDetails>["content"] = [{ type: "text", text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}` }];
	if (fallbackReason && result.look.image?.jpegBase64) {
		content.push({ type: "image", data: result.look.image.jpegBase64, mimeType: result.look.image.mimeType ?? "image/jpeg" });
	}

	return { content, details };
}

/** Desktop acts only run once `currentCaptureOrThrow` passed, and every desktop capture or hydrated state carries its look. */
function currentLook(): LookResponse {
	return operationState().currentLook!;
}

function ensurePointIsInLookImage(x: number, y: number, look: LookResponse, errorPrefix = "Coordinates"): void {
	if (!look.image?.jpegBase64) {
		throw new Error(`${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
		throw new Error(`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe_ui again and retry.`);
	}
}

function executionTraceFromAct(result: HelperActResult, policy: DeliveryPolicy): ExecutionTrace {
	// Refs stay helper-native here; normalizeRootDeltaRefs() maps them to @rN once per transaction.
	const rootDelta = result.rootDelta?.map((delta) => ({ ...delta }));
	return executionTrace("act", result.performed?.delivery === "ax" ? "stealth" : "default", {
		outcome: result.outcome,
		performed: result.performed,
		evidence: result.evidence,
		error: result.error,
		stoppedAt: result.stoppedAt,
		rootDelta,
		delivery: result.performed?.delivery,
		deliveryPolicy: policy,
	});
}

async function helperAct(
	target: ResolvedTarget,
	action: PreparedAction,
	headless: boolean,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const checked = (candidate: HelperActResult): HelperActResult => {
		if (!candidate || !["worked", "didnt", "unknown"].includes(candidate.outcome)) {
			throw new Error("Helper act returned an invalid result without an outcome.");
		}
		return candidate;
	};
	const textTimeout = "text" in action.params ? action.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
	const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textTimeout);
	// Only foreground delivery posts real cursor/keyboard events; it alone takes the desktop lock shared with
	// desktop_input / desktop_screenshot, held to the end of the act_ui transaction once taken.
	// Background, pid, and AX acts stay concurrent per window.
	const actInForeground = () => withPhysicalInput(() => currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }), signal);
	if ((action.usesCurrentFocus || action.needsForeground) && !headless) {
		const foreground = checked(await actInForeground());
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = false;
		return trace;
	}
	try {
		const initialPolicy = headless ? "ax_only" : "background";
		const result = checked(await currentPlatformBackend.act(helperActRequest(target, action, initialPolicy), { signal, timeoutMs }));
		if (canRetryInForeground(action, result.outcome, headless)) {
			const foreground = checked(await actInForeground());
			const trace = executionTraceFromAct(foreground, "foreground");
			trace.backgroundFirst = true;
			trace.escalatedToForeground = true;
			trace.escalationReason = "side_effect_free_didnt";
			trace.backgroundAttempt = { outcome: "didnt", reason: "Background input produced no observable value change; a foreground retry was safe." };
			return trace;
		}
		const trace = executionTraceFromAct(result, "background");
		trace.backgroundFirst = true;
		return trace;
	} catch (error) {
		const code = (error as Error & { code?: string })?.code;
		if (code !== "foreground_required" || headless) throw error;
		const foreground = checked(await actInForeground());
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = true;
		trace.escalatedToForeground = true;
		trace.escalationReason = code;
		trace.backgroundAttempt = { outcome: "foreground_required", reason: error instanceof Error ? error.message : String(error) };
		return trace;
	}
}

function helperActRequest(target: ResolvedTarget, action: PreparedAction, policy: DeliveryPolicy): PlatformActRequest {
	const look = currentLook();
	const delivery = nativeInputDelivery(policy);
	const base = { lookId: look.lookId, pid: target.pid, target: action.target, policy };
	return (() => {
		switch (action.action) {
			case "press":
			case "click": return { ...base, action: action.action, params: { ...action.params, delivery } };
			case "setText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "typeText": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "paste": return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "keypress": return { ...base, action: action.action, params: { keys: action.params.keys, delivery } };
			case "secondaryAction": return { ...base, action: action.action, params: { name: action.params.name, delivery } };
			case "selectText": return { ...base, action: action.action, params: { start: action.params.start, length: action.params.length, delivery } };
			case "scroll": return { ...base, action: action.action, params: { scrollX: action.params.scrollX, scrollY: action.params.scrollY, delivery } };
			case "drag": return { ...base, action: action.action, params: { path: action.params.path, delivery } };
			case "moveMouse": return { ...base, action: action.action, params: { delivery } };
		}
	})();
}

function rootDeltaLines(execution: ExecutionTrace): string[] {
	return (execution.rootDelta ?? []).map((delta) => {
		const quotedTitle = delta.title ? ` ${JSON.stringify(delta.title)}` : "";
		const ref = delta.ref ? ` (${delta.ref.startsWith("@") ? delta.ref : `@${delta.ref}`})` : "";
		const sheetCount = typeof delta.metadata?.sheetCount === "number" && Number.isFinite(delta.metadata.sheetCount) ? Math.max(0, Math.trunc(delta.metadata.sheetCount)) : undefined;
		const flags = [delta.isModal ? "modal" : undefined, sheetCount ? `sheets=${sheetCount}` : undefined].filter(Boolean).join(", ");
		const suffix = `${quotedTitle}${flags ? ` (${flags})` : ""}${ref}`;
		if (delta.change === "appeared") return `New root: ${delta.kind}${suffix}`;
		if (delta.change === "closed") return `Root closed: ${delta.kind}${suffix}`;
		return `Root focused: ${delta.kind}${suffix}`;
	});
}

function windowDetails(app: HelperApp, window: HelperWindow, config: ReturnType<typeof getComputerUseConfig>): ListWindowsDetails["windows"][number] {
	const storedRef = storeWindowRefForAppWindow(app, window);
	return {
		app: app.appName,
		bundleId: app.bundleId,
		pid: app.pid,
		kind: window.kind,
		windowTitle: window.title || "(untitled)",
		windowId: window.windowId,
		windowRef: storedRef.ref,
		nativeWindowRef: window.windowRef,
		framePoints: window.framePoints,
		scaleFactor: window.scaleFactor,
		isMinimized: window.isMinimized,
		isOnscreen: window.isOnscreen,
		isMain: window.isMain,
		isFocused: window.isFocused,
		isModal: window.isModal,
		sheetCount: platformRootSheetCount(window),
		role: window.role,
		subrole: window.subrole,
		pairing: platformRootPairing(window),
		zOrder: window.zOrder,
		browserUseAllowed: config.browser_use || !currentPlatformBackend.isBrowserApp(app.appName, app.bundleId),
		blocked: isBlockedBundleId(app.bundleId),
		score: scoreWindow(window),
	};
}

function sortWindowDetails(windows: ListWindowsDetails["windows"]): ListWindowsDetails["windows"] {
	return windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));
}

// Side effect: stores stable @r refs for discovered windows in runtimeState.
async function collectWindowDetails(apps: HelperApp[], config: ReturnType<typeof getComputerUseConfig>, signal?: AbortSignal): Promise<ListWindowsDetails["windows"]> {
	const perApp = await Promise.all(apps.map(async (app) => ({ app, windows: await listWindows(app.pid, signal) })));
	return sortWindowDetails(perApp.flatMap(({ app, windows }) => windows.map((window) => windowDetails(app, window, config))));
}

function collectBroadWindowDetails(roots: HelperWindow[], config: ReturnType<typeof getComputerUseConfig>): ListWindowsDetails["windows"] {
	const windows: ListWindowsDetails["windows"] = [];
	for (const window of roots) {
		if (!window.pid) continue;
		windows.push(windowDetails({ appName: window.appName ?? "Unknown App", bundleId: window.bundleId, pid: window.pid }, window, config));
	}
	return sortWindowDetails(windows);
}

async function windowDetailsForFind(query: FindParams, config: ReturnType<typeof getComputerUseConfig>, signal?: AbortSignal): Promise<ListWindowsDetails["windows"]> {
	if (!query.app && !query.bundleId && !Number.isFinite(query.pid)) {
		return collectBroadWindowDetails(await currentPlatformBackend.listRoots({}, signal), config);
	}
	const apps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	return await collectWindowDetails(apps, config, signal);
}

async function performListWindows(params: FindParams, signal?: AbortSignal): Promise<AgentToolResult<ListWindowsDetails>> {
	const query = normalizeFindParams(params);
	const config = getComputerUseConfig();
	const desktopForest = await windowDetailsForFind(query, config, signal);
	const includeBrowserPages = !query.pid && !query.bundleId && (!query.app || normalizeText(query.app) === "browser") && config.browser_use;
	const browserForest: ListWindowsDetails["windows"] = !includeBrowserPages ? [] : (await listCdpPageContexts().catch(() => []))
		.map((page) => ({
			app: "Browser",
			pid: 0,
			kind: "browser_page",
			windowTitle: page.title || page.url,
			windowRef: storeBrowserRootRef(page.contextId),
			framePoints: { x: 0, y: 0, w: 1, h: 1 },
			scaleFactor: 1,
			isMinimized: false,
			isOnscreen: true,
			isMain: false,
			isFocused: false,
			isModal: false,
			zOrder: Number.MAX_SAFE_INTEGER,
			browserUseAllowed: true,
			blocked: false,
			score: 0,
			url: page.url,
		}));
	const allRoots = [...desktopForest, ...browserForest];
	const forest = allRoots.filter((root) => !query.kind || root.kind === query.kind);
	const ranked = forest.map((root, order) => ({ root, order, match: query.text ? rankedTextMatch([root.app, root.windowTitle], query.text) : { reason: "filter" as const, score: 1 } }))
		.filter((entry) => entry.match)
		.sort((a, b) => b.match!.score - a.match!.score || Number(b.root.isFocused) - Number(a.root.isFocused) || a.root.zOrder - b.root.zOrder || a.order - b.order);
	const totalMatches = ranked.length;
	const windows = ranked.slice(0, 12).map((entry) => entry.root);
	const details: ListWindowsDetails = { tool: "find_roots", query, windows, totalMatches, returned: windows.length, hasMore: totalMatches > windows.length, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${totalMatches} matching root${totalMatches === 1 ? "" : "s"}; returned ${windows.length}${totalMatches > windows.length ? ". Refine the filters for additional roots" : ""}. Use @r refs with observe_ui({ root: "@rN" }).\n${lines.join("\n")}`
		: query.text || query.app || query.bundleId || query.pid || query.kind
			? ["No roots matched the supplied filters.", currentPlatformBackend.emptyRootsHint?.()].filter(Boolean).join(" ")
			: ["No roots are currently visible to pi-computer-use.", currentPlatformBackend.emptyRootsHint?.()].filter(Boolean).join(" ");
	return { content: [{ type: "text", text }], details };
}

function normalizeImageMode(value: unknown): ImageMode {
	return value === "always" || value === "never" ? value : "auto";
}

function isBrowserContextId(contextId: string | undefined): contextId is string {
	return Boolean(contextId?.startsWith(BROWSER_CONTEXT_PREFIX));
}

function browserContextForOperation(): string | undefined {
	const contextId = operationState().contextId;
	return isBrowserContextId(contextId) ? contextId : undefined;
}

async function withBrowserWrite<T>(contextId: string, work: () => Promise<T>): Promise<T> {
	const state = operationState();
	const targetId = contextId.slice(BROWSER_CONTEXT_PREFIX.length);
	const resourceKey = `cdp:${targetId}`;
	// A browser state always hydrates with the epoch of the resource it was observed at.
	const result = await resourceScheduler.write(resourceKey, state.epoch!, async (nextEpoch) => {
		state.resourceKey = resourceKey;
		state.epoch = nextEpoch;
		return await work();
	});
	return result.value;
}

function browserObservationResult(browser: CdpPageSnapshot, resourceKey: string, epoch: number, tool: string, base?: { stateId: string; outline: SerializedOutline }, detail: ObserveDetail = "compact"): AgentToolResult<BrowserObservationDetails> {
	savedStates.set({ stateId: browser.snapshotId, resourceKey, epoch, value: { kind: "browser", snapshot: browser, outline: browser.outline } });
	const currentOutline = restoreOutline(browser.outline);
	const transition = base ? changesBetween(restoreOutline(base.outline), currentOutline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(currentOutline);
	const view = useDiff ? undefined : detail === "outline" ? { detail, text: folded.text } : renderStateView(currentOutline, browser.snapshotId, detail);
	const root = { ref: storeBrowserRootRef(browser.contextId), kind: "browser_page" as const, title: browser.title, url: browser.url };
	const details: BrowserObservationDetails = { tool, kind: "browser_page", stateId: browser.snapshotId, baseStateId: base?.stateId, view: useDiff ? "diff" : "full", changes: useDiff ? transition?.changes : undefined, root, renderedOutline: folded.text, detail: view?.detail };
	const viewText = view
		? view.text
		: `Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${browser.snapshotId}):\n${renderChanges(transition!.changes) || "(no element changes)"}\nUse stateId ${browser.snapshotId} for subsequent actions and queries.`;
	return { content: [{ type: "text", text: `${tool} completed for ${root.ref} ${JSON.stringify(browser.title)}. State ${browser.snapshotId}.\n${viewText}` }], details };
}

async function refreshBrowserSnapshot(contextId: string, tool: string, base?: { stateId: string; outline: SerializedOutline }): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = await cdpSnapshotForContext(contextId);
	if (!browser) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
	// Only called inside `withBrowserWrite`, which has recorded the resource key and the written epoch.
	const state = operationState();
	return browserObservationResult(browser, state.resourceKey!, state.epoch!, tool, base);
}

function sliceText(value: string, offsetValue: unknown, _limitValue?: unknown): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
	const offset = Math.max(0, Math.trunc(toFiniteNumber(offsetValue, 0)));
	const limit = UI_TEXT_PAGE_CHARS;
	const characters = Array.from(value);
	const end = Math.min(characters.length, offset + limit);
	return {
		offset,
		limit,
		totalChars: characters.length,
		hasMore: end < characters.length,
		text: offset >= characters.length ? "" : characters.slice(offset, end).join(""),
	};
}

async function performReadText(params: ReadTextParams, signal?: AbortSignal): Promise<AgentToolResult<ReadTextDetails>> {
	const ref = trimOrUndefined(params.ref);
	if (ref?.startsWith("@o")) {
		const page = readStoredOutput(ref, params.offset);
		if (!page) throw new Error(`Output ref '${ref}' is unavailable or was evicted. Rerun the focused query.`);
		const details: ReadTextDetails = { tool: "read_text", ref, ...page };
		const suffix = page.hasMore
			? `\n\ncontinue: read_text({ ref: "${ref}", offset: ${page.offset + page.limit} })`
			: page.complete ? "" : "\n\ncontinuation storage limit reached; rerun a more focused query for the remainder";
		return { content: [{ type: "text", text: `${page.text || "(empty output page)"}${suffix}` }], details };
	}
	const contextId = operationState().contextId;
	if (isBrowserContextId(contextId)) {
		const snapshot = operationState().browserSnapshot;
		if (!snapshot || snapshot.contextId !== contextId) throw new Error(`Browser state '${params.stateId}' is unavailable. Observe the browser root again.`);
		if (!ref) throw new Error("read_text requires an @e ref for browser contexts; use the outline root ref for whole-page text.");
		const outline = restoreOutline(snapshot.outline);
		const node = nodeByRef(outline, ref);
		if (!node) throw new Error(`Browser text ref '${ref}' is unavailable in this state.`);
		const collect = (current: OutlineNode): string[] => [outlineNodeLabel(current), ...current.text.map((item) => item.string), ...current.children.flatMap(collect)].filter(Boolean);
		const value = node === outline.root ? snapshot.text : [...new Set(collect(node))].join("\n");
		const sliced = sliceText(value, params.offset);
		const details: ReadTextDetails = { tool: "read_text", ref, ...sliced };
		return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
	}

	currentCaptureOrThrow();
	// A hydrated state restores its target without resolving it, so re-check the policy before the live read.
	assertAppNotBlocked(currentTargetOrThrow());
	if (!ref) throw new Error("read_text requires ref for desktop contexts. Call observe_ui/inspect_ui and use a text-bearing outline ref.");
	const node = outlineNodeByRef(ref);
	const state = operationState();
	if (!state.resourceKey || state.epoch === undefined) throw new Error("The observation has no live resource identity. Observe again.");
	const raw = (await resourceScheduler.readAt(state.resourceKey, state.epoch, async () => await currentPlatformBackend.readText({
		lookId: state.currentOutline!.lookId,
		elementRef: wireRefForNode(node),
		offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
		limit: UI_TEXT_PAGE_CHARS,
	}, { signal, timeoutMs: COMMAND_TIMEOUT_MS }))).value;
	const text = raw.text;
	const details: ReadTextDetails = {
		tool: "read_text",
		ref,
		offset: raw.offset,
		limit: raw.limit,
		totalChars: raw.totalChars,
		hasMore: raw.hasMore,
		text,
	};
	return { content: [{ type: "text", text: text || "(empty text slice)" }], details };
}

function normalizeWaitTimeoutMs(value: unknown): number {
	return Math.max(100, Math.min(60_000, Math.trunc(toFiniteNumber(value, 10_000))));
}

function conditionScopeRef(params: WaitForParams | NonNullable<ActParams["expect"]>): string | undefined {
	const ref = trimOrUndefined(params.ref);
	const scopeRef = trimOrUndefined(params.scopeRef);
	if (ref && scopeRef) throw new Error("A UI condition accepts ref or scopeRef, not both.");
	return ref ?? scopeRef;
}

function validateCondition(params: WaitForParams | NonNullable<ActParams["expect"]>): { text?: string; role?: string; value?: string; scopeRef?: string; scopeExact: boolean; gone: boolean; timeoutMs: number } {
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const value = trimOrUndefined(params.value);
	const scopeRef = conditionScopeRef(params);
	if (!text && !role && !value) throw new Error("A UI condition requires text, role, or value.");
	if (role && !text && !value && !scopeRef) throw new Error("A role-only UI condition requires ref or scopeRef.");
	if (value && !params.ref) throw new Error("A value UI condition requires an exact ref.");
	return { text, role, value, scopeRef, scopeExact: Boolean(params.ref), gone: params.until === "absent", timeoutMs: normalizeWaitTimeoutMs(params.timeoutMs) };
}

function nodeWithinScope(node: OutlineNode, scopeRef: string | undefined, scopeExact: boolean): boolean {
	if (!scopeRef) return true;
	if (scopeExact) return node.ref === scopeRef;
	let current: OutlineNode | undefined = node;
	while (current) {
		if (current.ref === scopeRef) return true;
		current = current.parent;
	}
	return false;
}

function normalizedRole(value: string): string {
	return value.toLowerCase().replace(/^ax/, "").replace(/[ _-]+/g, "");
}

function platformRole(outline: Outline, role: string | undefined): string | undefined {
	if (!role) return undefined;
	return outline.nodes.find((node) => normalizedRole(node.role) === normalizedRole(role))?.role ?? role;
}

function outlineConditionPresent(outline: Outline, condition: ReturnType<typeof validateCondition>): boolean {
	return searchOutline(outline, condition.text, undefined, undefined, outline.nodes.length)
		.some((match) => (!condition.role || normalizedRole(match.node.role) === normalizedRole(condition.role)) && nodeWithinScope(match.node, condition.scopeRef, condition.scopeExact) && (!condition.value || normalizeText(match.node.value) === normalizeText(condition.value)));
}

function conditionScopeNode(outline: Outline, condition: ReturnType<typeof validateCondition>): OutlineNode | undefined {
	const scopeNode = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
	if (condition.scopeRef && !scopeNode) throw new Error(`Condition scope ref '${condition.scopeRef}' is unavailable in this state.`);
	return scopeNode;
}

function waitForViewText(outline: Outline, stateId: string, transition: OutlineDiff): string {
	return transition.useFullView ? renderStateView(outline, stateId, "compact").text : `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${stateId} for subsequent actions and queries.`;
}

async function performWaitFor(params: WaitForParams, signal?: AbortSignal): Promise<AgentToolResult<WaitForDetails>> {
	const contextId = operationState().contextId;
	const condition = validateCondition(params);
	const { text, role, value, scopeRef, scopeExact, gone, timeoutMs } = condition;

	if (isBrowserContextId(contextId)) {
		// A browser state hydrates from a saved record, which always carries its resource identity and base snapshot.
		const state = operationState();
		const resourceKey = state.resourceKey!;
		const baseSnapshot = state.browserSnapshot!;
		conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
		const deadline = Date.now() + timeoutMs;
		const finish = (lastSnapshot: CdpPageSnapshot, lastEpoch: number, found: boolean, timedOut?: boolean): AgentToolResult<WaitForDetails> => {
			savedStates.set({ stateId: lastSnapshot.snapshotId, resourceKey, epoch: lastEpoch, value: { kind: "browser", snapshot: lastSnapshot, outline: lastSnapshot.outline } });
			const successorOutline = restoreOutline(lastSnapshot.outline);
			const transition = changesBetween(restoreOutline(baseSnapshot.outline), successorOutline);
			const useDiff = !transition.useFullView;
			const renderedOutline = foldToBudget(successorOutline).text;
			const details: WaitForDetails = { tool: "wait_for", stateId: lastSnapshot.snapshotId, baseStateId: baseSnapshot.snapshotId, view: useDiff ? "diff" : "full", changes: useDiff ? transition.changes : undefined, found, gone: found && gone || undefined, timedOut, nodeCount: lastSnapshot.targets.length, text, role, value, scopeRef, renderedOutline };
			const message = found ? (gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
			return { content: [{ type: "text", text: `${message}\n${waitForViewText(successorOutline, lastSnapshot.snapshotId, transition)}` }], details };
		};
		let snapshot: CdpPageSnapshot | undefined;
		let epoch: number;
		do {
			const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(contextId));
			snapshot = scheduled.value;
			epoch = scheduled.epoch;
			if (!snapshot) throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
			const present = outlineConditionPresent(restoreOutline(snapshot.outline), condition);
			if (present !== gone) return finish(snapshot, epoch, true);
			await sleep(200, signal);
		} while (Date.now() < deadline);
		return finish(snapshot, epoch, false, true);
	}

	const state = operationState();
	// A blank `stateId` hydrates nothing; fail with the coded error like search, expand and inspect.
	const baseView = { stateId: currentCaptureOrThrow().stateId, outline: state.currentOutline! };
	let target = await resolveCurrentTarget(signal);
	target = await ensureTargetWindowId(target, signal);
	const scopeNode = conditionScopeNode(state.currentOutline!, condition);
	const raw = await currentPlatformBackend.waitFor({
		...nativeWindowRequest(target),
		lookId: state.currentOutline!.lookId,
		text,
		role: platformRole(state.currentOutline!, role),
		value,
		scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
		scopeExact,
		gone,
		timeoutMs,
	}, { signal, timeoutMs: timeoutMs + 2_000 });
	// A desktop state hydrates from a saved record, which always carries its resource identity.
	const refreshed = (await resourceScheduler.readAt(state.resourceKey!, state.epoch!, async () => await captureCurrentTarget(signal, "auto"))).value;
	const transition = changesBetween(baseView.outline, refreshed.outline);
	const useDiff = !transition.useFullView;
	const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
	const foundTarget = matches[0];
	const details: WaitForDetails = {
		tool: "wait_for",
		stateId: refreshed.capture.stateId,
		baseStateId: baseView.stateId,
		view: useDiff ? "diff" : "full",
		changes: useDiff ? transition.changes : undefined,
		found: raw.found,
		gone: raw.gone || undefined,
		timedOut: raw.timedOut || undefined,
		target: foundTarget ? serializeOutlineSearchMatch(foundTarget) : undefined,
		nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : refreshed.outline.nodes.length,
		text,
		role,
		value,
		scopeRef,
		renderedOutline: foldToBudget(refreshed.outline).text,
	};
	const message = details.found ? (details.gone ? "Condition disappeared." : "Condition appeared.") : `Timed out after ${timeoutMs}ms waiting for condition.`;
	return { content: [{ type: "text", text: `${message}\n${waitForViewText(refreshed.outline, refreshed.capture.stateId, transition)}` }], details };
}

function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
	if (a.pid !== b.pid) return false;
	if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
async function performObserve(params: ObserveParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
	const requestedRoot = params.root;
	// Direct callers can bypass the schema; a non-string root must not silently fall back to the frontmost window.
	if (typeof requestedRoot !== "string" && requestedRoot !== undefined) throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	if (requestedRoot && !/^@r\d+$/.test(requestedRoot)) throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	const browserContextId = requestedRoot ? runtimeState.browserContextByRoot.get(requestedRoot) : undefined;
	if (isBrowserContextId(browserContextId)) {
		const targetId = browserContextId.slice(BROWSER_CONTEXT_PREFIX.length);
		const resourceKey = `cdp:${targetId}`;
		const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(browserContextId));
		const browser = scheduled.value;
		if (!browser) throw new Error(`Browser context '${browserContextId}' is no longer available. Call find_roots again.`);
		return browserObservationResult(browser, resourceKey, scheduled.epoch, "observe_ui", undefined, params.detail);
	}
	const state = operationState();
	const mode = params.mode ?? "fused";
	const image = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const defaultReadText = mode === "semantic" ? "never" : mode === "visual" ? "always" : "auto";
	const readText = params.readText ?? defaultReadText;
	state.currentImageMode = normalizeImageMode(image);
	const selection: ObserveTargetParams = { root: normalizeWindowSelector(params.root) };
	const requestedTarget = selection.root
		? await resolveTargetByWindowSelector(selection.root, signal)
		: await resolveTargetForObserve(signal);
	const imageMode = normalizeImageMode(image);
	const resourceKey = desktopResourceKey(requestedTarget);
	const scheduled = await resourceScheduler.read(resourceKey, async (epoch) => {
		state.resourceKey = resourceKey;
		state.epoch = epoch;
		return await captureCurrentTarget(signal, readText, imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION, requestedTarget, imageMode !== "never");
	});
	const captureResult = scheduled.value;
	// Model @r refs are re-minted on re-resolution, so ref string equality
	// alone false-positives as drift for the same root; compare stable
	// identity against the resolved request too.
	if (!matchesObserveSelection(captureResult.target, selection) && !sameRootIdentity(captureResult.target, requestedTarget)) {
		throw new Error(
			`Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe_ui again or specify a more exact window title.`,
		);
	}
	const summary = `Observed ${mode} ${captureResult.target.windowRef} ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult("observe_ui", summary, captureResult, executionTrace("look", "stealth"), signal, imageMode, undefined, params.detail);
}

/** `currentCaptureOrThrow` guarantees a capture, and captures are always stored with their outline. */
function currentOutlineOrThrow(): Outline {
	currentCaptureOrThrow();
	return operationState().currentOutline!;
}

function matchIsNonActionableStatic(match: OutlineSearchMatch): boolean {
	const node = match.node;
	return !node.canPress && !node.canFocus && !node.canSetValue && node.actions.length === 0 && !node.pictureOnly;
}

function shouldEscalateSearchOCR(matches: OutlineSearchMatch[], _text?: string): boolean {
	return matches.length === 0 || matches.every(matchIsNonActionableStatic);
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
async function performSearchUi(params: SearchUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow();
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const capability = trimOrUndefined(params.capability);
	if (!text && !role && !capability) throw new Error("search_ui requires text, role, or capability. Use observe_ui for a bounded overview.");
	const limit = 12;
	let ranked = searchOutlineRanked(outline, text, role, capability, limit);
	let matches = ranked.matches;
	let escalatedOCR = false;
	const look = state.currentLook;
	// A browser state has no desktop window to re-capture; report the outline matches as they are.
	if (!isBrowserContextId(state.contextId) && shouldEscalateSearchOCR(matches, text) && look && look.readText?.requested !== "never" && !look.readText?.executed) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		// captureCurrentTarget adopts the new look/outline/capture into
		// runtimeState, so refs in these matches stay actable. Keep the image
		// payload: OCR-only matches are clicked by coordinate, and coordinate
		// acts require the current look to be image-bearing.
		const captureResult = (await resourceScheduler.readAt(state.resourceKey!, state.epoch!, async () => await captureCurrentTarget(signal, "always", AUTO_IMAGE_MAX_DIMENSION, currentTarget))).value;
		outline = captureResult.outline;
		ranked = searchOutlineRanked(outline, text, role, capability, limit);
		matches = ranked.matches;
		escalatedOCR = true;
	}
	const detailMatches = matches.map(serializeOutlineSearchMatch);
	const details: OutlineToolDetails = { tool: "search_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, matches: detailMatches, totalMatches: ranked.totalMatches, returned: matches.length, hasMore: ranked.totalMatches > matches.length, note: state.currentNote };
	const collides = (match: OutlineSearchMatch) => matches.some((other) => other !== match && other.role === match.role && other.label === match.label);
	const lines = matches.map((match) => `${controlLine(match.node)} [${match.matchReason}${match.matchReason === "fuzzy" ? ` ${match.score!.toFixed(2)}` : ""}]${collides(match) ? `\n  path: ${match.path}` : ""}`);
	const noteHeader = renderNote(state.currentNote);
	const noteText = noteHeader ? `${noteHeader}\n\n` : "";
	const escalationText = escalatedOCR ? " OCR text was escalated for this search after the cached outline had no matches." : "";
	const moreText = ranked.totalMatches > matches.length ? ` Refine the query to inspect ${ranked.totalMatches - matches.length} additional matches.` : "";
	return { content: [{ type: "text", text: `${noteText}Found ${ranked.totalMatches} outline match${ranked.totalMatches === 1 ? "" : "es"}; returned ${matches.length}.${moreText}${escalationText}\n${lines.join("\n")}` }], details };
}

/** Reads cached outline; truncated refs trigger a scoped look. */
async function performExpandUi(params: ExpandUiParams, signal?: AbortSignal): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow();
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("expand_ui.ref is required.");
	const initialTarget = nodeByRef(outline, ref);
	if (!initialTarget) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	let target: OutlineNode = initialTarget;
	const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
	const regionKey = noteRegionKeyForRef(outline, ref);
	const regionChanged = Boolean(regionKey && state.currentNote?.regions.some((region) => region.key === regionKey && region.status === "changed"));
	// A browser state has no desktop window to scope a look into; render the cached subtree as is.
	if (!isBrowserContextId(state.contextId) && (target.truncated || regionChanged)) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		const targetWireRef = wireRefForNode(target);
		const scoped = (await resourceScheduler.readAt(state.resourceKey!, state.epoch!, async () => await performLook(currentTarget, {
			readText: "auto",
			baseLookId: outline.lookId,
			scopeRef: targetWireRef,
			maxDimension: 1,
			includeImage: false,
		}, signal))).value;
		target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
		outline.lookId = scoped.lookId;
		state.currentOutline = outline;
		state.currentLook = { ...scoped, image: state.currentLook?.image, outline: outline.root, parsedOutline: outline };
		persistOperation(state);
	}
	const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
	const details: OutlineToolDetails = { tool: "expand_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), renderedOutline: folded.text, note: state.currentNote };
	return { content: [{ type: "text", text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}` }], details };
}

/** Pure cached-outline inspection. */
async function performInspectUi(params: InspectUiParams): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	const outline = currentOutlineOrThrow();
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("inspect_ui.ref is required.");
	const target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const details: OutlineToolDetails = { tool: "inspect_ui", stateId: state.currentCapture?.stateId, lookId: outline.lookId, target: serializeOutlineNodeShallow(target), note: state.currentNote };
	const fields = [
		formatOutlineNodeLabel(target),
		`path: ${outlineNodePath(target)}`,
		`rect: ${JSON.stringify(target.rect)}`,
		`actions: ${target.actions.join(",") || "none"}`,
		`capabilities: ${[
			target.canPress ? "press" : undefined,
			target.canFocus ? "focus" : undefined,
			target.canSetValue ? "setValue" : undefined,
			target.canScroll ? "scroll" : undefined,
			target.canIncrement ? "increment" : undefined,
			target.canDecrement ? "decrement" : undefined,
			target.isTextInput ? "textInput" : undefined,
		].filter(Boolean).join(",") || "none"}`,
		`annotations: ${[
			target.offscreen ? "offscreen" : undefined,
			target.pictureOnly ? "pictureOnly" : undefined,
			target.truncated ? "truncated" : undefined,
			target.scrollExtent ? `scrollable ${target.scrollExtent.seen}/${target.scrollExtent.total}` : undefined,
		].filter(Boolean).join(",") || "none"}`,
	];
	return { content: [{ type: "text", text: fields.join("\n") }], details };
}

function prepareUiAction(action: UiAction, state: ActionState, look: LookResponse, headless: boolean): PreparedAction {
	return prepareAction(action, state, {
		headless,
		image: look.image,
		node: outlineNodeByRef,
		center: outlineNodeCenter,
		validatePoint: (x, y, label) => ensurePointIsInLookImage(x, y, look, label),
	});
}

async function dispatchUiAction(action: UiAction, target: ResolvedTarget, look: LookResponse, headless: boolean, state: ActionState, signal?: AbortSignal): Promise<ExecutionTrace> {
	const prepared = prepareUiAction(action, state, look, headless);
	const trace = await helperAct(target, prepared, headless, signal);
	if (!headless && (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))) {
		state.currentFocus = true;
	}
	return trace;
}

/**
 * Validates every action against the base look before the write lock is taken.
 * The write lock advances the resource epoch before dispatch, so a request that
 * fails pure validation must be rejected here or it would stale a state on which
 * nothing was delivered. Mirrors the `currentFocus` tracking of `dispatchUiTransaction`: keep the
 * two in step, or validation will disagree with dispatch.
 */
function preflightUiTransaction(actions: UiAction[], look: LookResponse, headless: boolean): void {
	const actionState: ActionState = { currentFocus: false };
	for (const action of actions) {
		const unsupported = unsupportedActionRejection(action, process.platform);
		if (unsupported) throw new ComputerUseError("unsupported_command", unsupported);
		const rejection = strictHeadlessRejection(action, headless, process.platform);
		if (rejection) throw new Error(rejection);
		const prepared = prepareUiAction(action, actionState, look, headless);
		if (!headless && (prepared.establishesFocus || (prepared.action === "click" && "x" in prepared.target))) {
			actionState.currentFocus = true;
		}
	}
}

async function dispatchUiTransaction(actions: UiAction[], target: ResolvedTarget, look: LookResponse, headless: boolean, signal?: AbortSignal): Promise<ExecutionTrace> {
	// Strict-headless batches have one immutable delivery class. When foreground
	// fallback is permitted, decide independently per action so a completed
	// background prefix is never replayed as part of a foreground batch.
	if (headless && currentPlatformBackend.actBatch) {
		const actionState: ActionState = { currentFocus: false };
		const requests = actions.map((action) => helperActRequest(target, prepareUiAction(action, actionState, look, true), "ax_only"));
		const textLength = actions.reduce((sum, action) => sum + (action.text?.length ?? 0), 0);
		const result = await currentPlatformBackend.actBatch(requests, { signal, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, textLength * 25 + 6_000) });
		if (!result.steps || result.steps.length === 0) throw new Error("Native action transaction returned no checked steps.");
		const execution = aggregateExecutions(result.steps.map((step) => executionTraceFromAct(step, "ax_only")));
		const batchTrace = executionTraceFromAct(result, "ax_only");
		execution.outcome = result.outcome;
		execution.performed = result.performed;
		execution.rootDelta = batchTrace.rootDelta;
		execution.stoppedAt = result.stoppedAt;
		return execution;
	}
	const steps: ExecutionTrace[] = [];
	const actionState: ActionState = { currentFocus: false };
	for (const action of actions) {
		const step = await dispatchUiAction(action, target, look, headless, actionState, signal);
		steps.push(step);
		if (step.outcome === "didnt") break;
	}
	return aggregateExecutions(steps);
}

function aggregateExecutions(steps: ExecutionTrace[]): ExecutionTrace {
	const outcomes = steps.map((step) => step.outcome);
	const outcome: ActOutcome = outcomes.includes("didnt") ? "didnt" : outcomes.includes("unknown") ? "unknown" : "worked";
	const fallback = steps.find((step) => step.escalatedToForeground);
	return executionTrace("act", steps.every((step) => step.variant === "stealth") ? "stealth" : "default", {
		outcome,
		steps,
		actionCount: steps.length,
		rootDelta: steps.flatMap((step) => step.rootDelta ?? []),
		backgroundFirst: true,
		escalatedToForeground: Boolean(fallback),
		escalationReason: fallback?.escalationReason,
		backgroundAttempt: fallback?.backgroundAttempt,
	});
}

function exactPlatformRootMatchesTarget(root: HelperWindow, target: ResolvedTarget): boolean {
	if (root.pid !== target.pid) return false;
	const nativeRefMatches = Boolean(target.nativeWindowRef && (root.rootRef === target.nativeWindowRef || root.windowRef === target.nativeWindowRef));
	const windowIdMatches = target.windowId > 0 && root.windowId === target.windowId;
	return nativeRefMatches || windowIdMatches;
}

function clearDesktopOperationState(state: OperationState): void {
	state.currentTarget = undefined;
	state.currentCapture = undefined;
	state.currentStateTarget = undefined;
	state.currentLook = undefined;
	state.currentOutline = undefined;
	state.currentNote = undefined;
}

/** Extension `@r` ref already issued for a helper-native root ref, without creating one. */
function extensionRefForNative(pid: number, nativeRef: string): string | undefined {
	for (const record of runtimeState.windowRefs.values()) {
		if (record.pid === pid && record.nativeWindowRef === nativeRef) return record.ref;
	}
	return undefined;
}

/**
 * Helper root deltas name roots by helper-native refs (`r2`), a different namespace from the `@rN` refs
 * the tools accept. Rewrite every delta ref to the extension ref (registering live roots), or drop it.
 */
export async function normalizeRootDeltaRefs(execution: ExecutionTrace, target: Pick<ResolvedTarget, "pid" | "appName" | "bundleId">): Promise<void> {
	if (!execution.rootDelta?.length) return;
	const rootsByPid = new Map<number, PlatformRoot[]>();
	const normalized: NonNullable<ExecutionTrace["rootDelta"]> = [];
	for (const delta of execution.rootDelta) {
		if (!delta.ref || delta.ref.startsWith("@")) {
			normalized.push(delta);
			continue;
		}
		let ext = extensionRefForNative(delta.pid, delta.ref);
		if (!ext && delta.change !== "closed") {
			if (!rootsByPid.has(delta.pid)) rootsByPid.set(delta.pid, await currentPlatformBackend.listRoots({ pid: delta.pid }).catch(() => []));
			const root = rootsByPid.get(delta.pid)!.find((candidate) => candidate.rootRef === delta.ref || candidate.windowRef === delta.ref);
			if (root) {
				const sameApp = delta.pid === target.pid;
				const app: HelperApp = { appName: sameApp ? target.appName : root.appName ?? "Unknown App", bundleId: sameApp ? target.bundleId : root.bundleId, pid: delta.pid };
				ext = storeWindowRefForAppWindow(app, root).ref;
			}
		}
		normalized.push({ ...delta, ref: ext });
	}
	execution.rootDelta = normalized;
}

/** Root kinds that can take over from a window. Menus, popovers and tooltips appearing are not replacements. */
const REPLACEMENT_ROOT_KINDS = new Set(["window", "dialog", "sheet"]);

/** Tell the agent when a confirmed modal is now in front of the root it just acted on. */
async function foregroundModalNote(target: ResolvedTarget): Promise<string | undefined> {
	try {
		const roots = await currentPlatformBackend.listRoots({ pid: target.pid });
		const current = roots.find((root) => exactPlatformRootMatchesTarget(root, target));
		if (!current || current.isModal) return undefined;
		const modal = roots.filter((root) => shouldPreferForegroundModalWindow(current, root)).sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
		return modal ? `Note: ${modal.kind} ${JSON.stringify(modal.title || "(untitled)")} is now a foreground modal in front of this root. Call find_roots, then observe_ui it.` : undefined;
	} catch {
		return undefined;
	}
}

export async function terminalDesktopActionResult(
	target: ResolvedTarget,
	baseStateId: string,
	execution: ExecutionTrace,
	error: unknown,
	condition?: ReturnType<typeof validateCondition>,
): Promise<AgentToolResult<TerminalDesktopActionDetails>> {
	await normalizeRootDeltaRefs(execution, target);
	let exactRootAvailable: boolean | undefined;
	let liveRoots: PlatformRoot[] = [];
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const roots = await currentPlatformBackend.listRoots({ pid: target.pid });
			liveRoots = roots;
			exactRootAvailable = roots.some((root) => exactPlatformRootMatchesTarget(root, target));
			if (exactRootAvailable) break;
			if (attempt < 2) await sleep(75);
		}
	} catch {
		// A failed identity probe cannot prove that the root closed.
	}
	const targetClosed = exactRootAvailable === false;
	if (targetClosed && !(execution.rootDelta ?? []).some((delta) => delta.change === "closed" && delta.pid === target.pid && (delta.ref === target.windowRef || delta.ref === target.nativeWindowRef))) {
		execution.rootDelta = [
			...(execution.rootDelta ?? []),
			{
				change: "closed",
				kind: "window",
				ref: target.windowRef,
				title: target.windowTitle,
				pid: target.pid,
				metadata: { source: "post_action_identity_probe" },
			},
		];
	}
	if (targetClosed && condition) {
		const verificationStatus = condition.gone ? "verified" : "failed";
		execution.verification = {
			status: verificationStatus,
			text: condition.text,
			role: condition.role,
			value: condition.value,
			gone: condition.gone || undefined,
			timeoutMs: condition.timeoutMs,
		};
		execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", verificationStatus);
		if (verificationStatus === "failed") {
			execution.error = {
				code: "postcondition_failed",
				message: "The source root closed before the requested presence or value postcondition could be verified.",
			};
		}
	}
	const successors = targetClosed
		? execution.rootDelta!.filter((delta) => delta.change === "appeared" && delta.pid === target.pid && REPLACEMENT_ROOT_KINDS.has(delta.kind) && Boolean(delta.ref) && liveRoots.some((root) => root.pid === target.pid && extensionRefForNative(target.pid, root.rootRef ?? root.windowRef ?? "") === delta.ref)).map((delta) => ({ ref: delta.ref, kind: delta.kind, title: delta.title, isModal: delta.isModal }))
		: [];
	const status = targetClosed ? "target_closed" : "post_action_observation_failed";
	const rawMessage = error instanceof Error ? error.message : String(error);
	// The probe saw the root listed, yet the helper cannot resolve it: the ref expired. A failed probe proves nothing.
	const rootExpired = exactRootAvailable === true && (error as { code?: string } | undefined)?.code === "root_not_found";
	const code = targetClosed ? "target_closed" : rootExpired ? "root_stale" : "post_action_observation_failed";
	const message = rootExpired ? `Root expired or was never valid for observation (${rawMessage}). Rediscover with find_roots.` : rawMessage;
	clearDesktopOperationState(operationState());
	const details: TerminalDesktopActionDetails = {
		tool: "act_ui",
		status,
		baseStateId,
		target: {
			app: target.appName,
			bundleId: target.bundleId,
			pid: target.pid,
			windowTitle: target.windowTitle,
			windowId: target.windowId,
			windowRef: target.windowRef,
			nativeWindowRef: target.nativeWindowRef,
		},
		execution,
		error: { code, message },
		...(targetClosed ? { cause: successors.length > 0 ? "replaced" as const : "closed" as const, successors } : {}),
	};
	const successorText = successors.length > 0 ? ` It was replaced by ${successors.map((item) => `${item.kind} ${JSON.stringify(item.title ?? "")}${item.isModal ? " (modal)" : ""}`).join(", ")}.` : "";
	const result = targetClosed
		? `The action was delivered, and its source root ${target.appName} — ${target.windowTitle} closed before a successor observation could be captured.${successorText}`
		: `The action was delivered, but its source root ${target.appName} — ${target.windowTitle} could not be observed afterward: ${message}`;
	return {
		content: [{ type: "text", text: `${result}\nNo successor state was created. Call find_roots, then observe_ui to continue.` }],
		details,
	};
}

async function performDesktopTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails>> {
	const state = operationState();
	state.currentImageMode = "auto";
	currentCaptureOrThrow();
	const look = currentLook();
	const baseView = { stateId: state.currentCapture!.stateId, outline: state.currentOutline! };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	const scopeNode = condition ? conditionScopeNode(look.parsedOutline!, condition) : undefined;
	const headless = getComputerUseConfig().headless;
	preflightUiTransaction(actions, look, headless);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal, { preferModal: false }), signal);
	return await withWindowWriteLock(target, () => withDesktopTransaction(async () => {
		const execution = await dispatchUiTransaction(actions, target, look, headless, signal);
		await normalizeRootDeltaRefs(execution, target);
		// Both dispatch paths aggregate their steps, which records how many ran.
		const executedActions = actions.slice(0, execution.actionCount!);
		try {
			if (condition) {
				const { text: expectedText, role: expectedRole, value: expectedValue, scopeExact, gone, timeoutMs } = condition;
				const beforePresent = outlineConditionPresent(look.parsedOutline!, condition);
				const desiredWasPreexisting = beforePresent !== gone;
				const verification = await currentPlatformBackend.waitFor({
					...nativeWindowRequest(target),
					lookId: look.parsedOutline!.lookId,
					text: expectedText,
					role: platformRole(look.parsedOutline!, expectedRole),
					value: expectedValue,
					scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
					scopeExact,
					gone,
					timeoutMs,
				}, { signal, timeoutMs: timeoutMs + 2_000 });
				execution.verification = {
					status: verification.found ? (desiredWasPreexisting ? "preexisting" : "verified") : "failed",
					text: expectedText,
					role: expectedRole,
					value: expectedValue,
					gone: gone || undefined,
					timeoutMs,
				};
				execution.outcome = outcomeAfterCheck(execution.outcome ?? "unknown", execution.verification.status);
				if (!verification.found) {
					execution.error = {
						code: "postcondition_failed",
						message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
					};
				}
			} else {
				await sleep(settleMsForExecution(execution), signal);
			}
			// An unpaired root (no CG window) cannot be captured; observe it semantically instead of failing the successor.
			const capture = await captureCurrentTarget(signal, "auto", AUTO_IMAGE_MAX_DIMENSION, target, target.windowId > 0);
			execution.outcome = outcomeAfterObservedValues(execution.outcome ?? "unknown", executedActions, (ref) => nodeByRef(capture.outline, ref)?.value);
			for (const action of executedActions) {
				state.currentNote = noteAfterAct(state.currentNote, action.ref, capture.outline, { window: noteWindowForTarget(capture.target, capture.look), rootDelta: execution.rootDelta });
			}
			const built = await buildToolResult("act_ui", `Executed ${executedActions.length} checked UI action${executedActions.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}. Returned state ${capture.capture.stateId}.`, capture, execution, signal, state.currentImageMode, baseView);
			const modalNote = await foregroundModalNote(target);
			const first = built.content[0];
			if (modalNote && first?.type === "text") first.text = `${first.text}\n${modalNote}`;
			return built;
		} catch (error) {
			if (signal?.aborted) {
				clearDesktopOperationState(state);
				throw error;
			}
			return await terminalDesktopActionResult(target, baseView.stateId, execution, error, condition);
		}
	}, signal));
}

function assertBrowserTransactionAction(action: UiAction): void {
	if (!BROWSER_TRANSACTION_ACTIONS.has(action.action)) throw new ComputerUseError("unsupported_command", `Browser transactions do not support '${action.action}'.`);
}

async function performBrowserTransaction(params: ActParams, actions: UiAction[], signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	// `performAct` routes here only for a hydrated browser state, which carries both.
	const contextId = browserContextForOperation()!;
	const baseSnapshot = operationState().browserSnapshot!;
	const baseView = { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	if (condition) conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
	const prepared = actions.map((action) => {
		assertBrowserTransactionAction(action);
		if (action.action === "click" && action.ref && action.button && action.button !== "left") throw new Error("Browser ref clicks support only the left button; use coordinate clicks for right or middle buttons.");
		const ref = trimOrUndefined(action.ref);
		const target = ref ? baseSnapshot.targets.find((candidate) => candidate.ref === ref) : undefined;
		if ((action.action === "press" || action.action === "setText" || (action.action === "click" && action.ref) || (action.action === "typeText" && action.ref)) && !Number.isFinite(target?.backendNodeId)) {
			throw new Error(`Browser ${action.action} requires an actionable @e ref owned by ${params.stateId}.`);
		}
		if (action.ref && !target) throw new Error(`Browser ${action.action} ref must be owned by ${params.stateId}.`);
		return { action, target };
	});
	return await withBrowserWrite(contextId, async () => {
		for (const { action, target } of prepared) {
			let worked = false;
			if (action.action === "press" || (action.action === "click" && action.ref)) {
				worked = true;
				for (let count = 0; count < (action.clickCount ?? 1); count += 1) worked = await cdpClickForContext(contextId, target!.backendNodeId!) && worked;
			} else if (action.action === "click") {
				worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mousePressed", action.button ?? "left", action.clickCount ?? 1)
					&& await cdpMouseForContext(contextId, action.x!, action.y!, "mouseReleased", action.button ?? "left", action.clickCount ?? 1);
			} else if (action.action === "setText") worked = await cdpTypeForContext(contextId, target!.backendNodeId!, action.text ?? "", true);
			else if (action.action === "typeText") worked = target?.backendNodeId
				? await cdpTypeForContext(contextId, target.backendNodeId, action.text ?? "", false)
				: await cdpTypeFocusedForContext(contextId, action.text ?? "");
			else if (action.action === "keypress") worked = await cdpKeypressForContext(contextId, action.keys ?? []);
			else if (action.action === "scroll") worked = await cdpScrollForContext(contextId, toFiniteNumber(action.scrollX, 0), toFiniteNumber(action.scrollY, 0), target?.backendNodeId);
			else if (action.action === "drag") worked = await cdpDragForContext(contextId, normalizeActionPath(action.path));
			else worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mouseMoved"); // `moveMouse`, the only action left
			if (!worked) throw new Error("The browser root became unavailable during the action transaction. Observe it again.");
		}
		if (condition) {
			const deadline = Date.now() + condition.timeoutMs;
			let satisfied = false;
			do {
				const snapshot = await cdpSnapshotForContext(contextId);
				if (!snapshot) throw new Error(`Browser root '${contextId}' is no longer available. Observe it again.`);
				const present = outlineConditionPresent(restoreOutline(snapshot.outline), condition);
				satisfied = present !== condition.gone;
				if (!satisfied) await sleep(100, signal);
			} while (!satisfied && Date.now() < deadline);
			if (!satisfied) throw new Error(`The browser action was delivered but its postcondition was not satisfied within ${condition.timeoutMs}ms.`);
		}
		return await refreshBrowserSnapshot(contextId, "act_ui", baseView);
	});
}

function normalizeActionPath(path: UiAction["path"]): Array<{ x: number; y: number }> {
	return (path ?? []).map((point) => Array.isArray(point) ? { x: toFiniteNumber(point[0], 0), y: toFiniteNumber(point[1], 0) } : { x: toFiniteNumber(point.x, 0), y: toFiniteNumber(point.y, 0) });
}

function validateActionTarget(action: UiAction): void {
	const hasRef = Boolean(trimOrUndefined(action.ref));
	const hasX = Number.isFinite(action.x);
	const hasY = Number.isFinite(action.y);
	if (hasX !== hasY) throw new Error(`${action.action} coordinates require both x and y.`);
	const hasPoint = hasX && hasY;
	if ((action.action === "click" || action.action === "moveMouse") && hasRef === hasPoint) {
		throw new Error(`${action.action} requires exactly one target: ref or x/y coordinates.`);
	}
	if (action.action === "press" && !hasRef) throw new Error("press requires an actionable ref.");
	if (action.action === "scroll" && toFiniteNumber(action.scrollX, 0) === 0 && toFiniteNumber(action.scrollY, 0) === 0) throw new Error("scroll requires a non-zero scrollX or scrollY delta.");
	if (action.clickCount !== undefined && (!Number.isInteger(action.clickCount) || action.clickCount < 1 || action.clickCount > 3)) throw new Error("clickCount must be an integer from 1 to 3.");
}

async function performAct(params: ActParams, signal?: AbortSignal): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails>> {
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) throw new Error("act_ui.actions must contain at least one action.");
	if (actions.length > 20) throw new Error("act_ui supports at most 20 actions per transaction.");
	for (const action of actions) validateActionTarget(action);
	if (operationState().contextId) return await performBrowserTransaction(params, actions, signal);
	return await performDesktopTransaction(params, actions, signal);
}

function managedBrowserExecutableCandidates(browser: ComputerUseConfig["managed_browser"]): string[] {
	const overrideName = browser === "helium" ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE" : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
	const override = trimOrUndefined(process.env[overrideName]);
	if (override) return [path.resolve(override)];

	const platformCandidates = process.platform === "darwin"
		? browser === "helium"
			? [
				"/Applications/Helium.app/Contents/MacOS/Helium",
				path.join(os.homedir(), "Applications", "Helium.app", "Contents", "MacOS", "Helium"),
			]
			: [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
			]
		: process.platform === "win32"
			? browser === "helium"
				? [
					process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Helium", "Application", "helium.exe"),
					process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Helium", "Application", "helium.exe"),
				]
				: [
					process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
					process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
					process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
				]
			: browser === "helium"
				? [
					"/usr/bin/helium",
					"/usr/bin/helium-browser",
					"/opt/helium/chrome",
					path.join(os.homedir(), ".local", "helium", "chrome"),
				]
				: [
					"/usr/bin/google-chrome",
					"/usr/bin/google-chrome-stable",
					"/usr/bin/chromium",
					"/usr/bin/chromium-browser",
					"/snap/bin/chromium",
				];
	const pathNames = browser === "helium"
		? process.platform === "win32" ? ["helium.exe"] : ["helium", "helium-browser"]
		: process.platform === "win32" ? ["chrome.exe"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.flatMap((directory) => pathNames.map((name) => path.join(directory, name)));
	return [...new Set([...platformCandidates.filter((candidate): candidate is string => Boolean(candidate)), ...pathCandidates])];
}

async function managedBrowserExecutable(browser: ComputerUseConfig["managed_browser"]): Promise<string> {
	const candidates = managedBrowserExecutableCandidates(browser);
	for (const candidate of candidates) {
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next platform-appropriate installation location.
		}
	}
	const overrideName = browser === "helium" ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE" : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
	if (trimOrUndefined(process.env[overrideName])) {
		throw new Error(`${browser} executable from ${overrideName} was not found or is not executable: ${candidates[0]}.`);
	}
	throw new Error(`${browser} executable was not found. Set ${overrideName} to its absolute path.`);
}

function freeTcpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// A TCP server that is listening always has an address with its ephemeral port.
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function waitForCdpPort(port: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + MANAGED_BROWSER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Browser launch was aborted.");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
			if (response.ok) return;
		} catch {
			// Browser is still starting.
		}
		await sleep(200, signal);
	}
	throw new Error(`Managed browser did not expose CDP on port ${port} within ${MANAGED_BROWSER_READY_TIMEOUT_MS}ms.`);
}

// Enabled with `NODE_DEBUG=pi-computer-use`; the bridge otherwise never writes to the TUI's stdio.
const debugLog = debuglog("pi-computer-use");

/**
 * Profile dirs of launched browsers that are not removed yet, with the browser using each one.
 * The `exit` hook empties it on a hard exit that skips session shutdown.
 */
const liveProfileDirs = new Map<string, ChildProcess>();
let profileExitHookInstalled = false;

/**
 * Track a managed browser's profile dir until it is removed, installing the exit hook once.
 * @param profileDir Private profile dir passed to the browser as `--user-data-dir`.
 * @param browser The browser process that owns `profileDir`.
 */
function trackProfileDir(profileDir: string, browser: ChildProcess): void {
	liveProfileDirs.set(profileDir, browser);
	if (profileExitHookInstalled) return;
	profileExitHookInstalled = true;
	process.once("exit", removeProfileDirsOnExit);
}

/**
 * Remove a managed browser profile dir. Failures are logged at debug level and the dir stays tracked,
 * so the exit hook retries it.
 * @param profileDir Profile dir to delete.
 */
async function removeProfileDir(profileDir: string): Promise<void> {
	try {
		await rm(profileDir, { recursive: true, force: true, maxRetries: 3 });
		liveProfileDirs.delete(profileDir);
	} catch (error) {
		debugLog("could not remove managed browser profile %s: %s", profileDir, error);
	}
}

/**
 * `exit` hook: the event loop is gone, so SIGKILL any still-running managed browser and delete
 * every tracked profile dir synchronously.
 */
function removeProfileDirsOnExit(): void {
	for (const [profileDir, browser] of liveProfileDirs) {
		if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
		try {
			rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
		} catch (error) {
			debugLog("could not remove managed browser profile %s on exit: %s", profileDir, error);
		}
	}
	liveProfileDirs.clear();
}

/**
 * Wait for a child's `close` event, bounded.
 * @param child Process to wait for.
 * @param timeoutMs Upper bound on the wait.
 * @returns Whether the child had exited or closed before the deadline.
 */
function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const onClose = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			child.off("close", onClose);
			resolve(false);
		}, timeoutMs);
		child.once("close", onClose);
	});
}

/**
 * Find the tracked profile dir a managed browser was launched with.
 * @param browser Managed browser process.
 * @returns Its profile dir, or `undefined` once that dir has been removed.
 */
function profileDirOf(browser: ChildProcess): string | undefined {
	for (const [profileDir, owner] of liveProfileDirs) if (owner === browser) return profileDir;
	return undefined;
}

/**
 * Stop a managed browser and delete its profile before returning. The browser is `unref()`ed, so
 * without this wait Pi exits before `close` fires and the profile, cookies included, stays behind.
 * @param browser Managed browser process; its profile dir is looked up in `liveProfileDirs`.
 */
async function stopManagedBrowser(browser: ChildProcess): Promise<void> {
	const terminated = waitForClose(browser, MANAGED_BROWSER_EXIT_TIMEOUT_MS);
	browser.kill("SIGTERM");
	if (!(await terminated)) {
		debugLog("managed browser %d ignored SIGTERM for %dms, sending SIGKILL", browser.pid, MANAGED_BROWSER_EXIT_TIMEOUT_MS);
		const killed = waitForClose(browser, MANAGED_BROWSER_EXIT_TIMEOUT_MS);
		browser.kill("SIGKILL");
		if (!(await killed)) debugLog("managed browser %d still running after SIGKILL", browser.pid);
	}
	// The `close` listener usually removed it already; a failed removal is still tracked and retried here.
	const profileDir = profileDirOf(browser);
	if (profileDir) await removeProfileDir(profileDir);
}

/**
 * Managed-browser lifecycle steps, chained so they never interleave. Tools run in parallel, and a
 * launch or shutdown that ran while another launch was between stopping the old browser and
 * recording the new one would miss a browser and leave it running until Pi exits.
 */
let managedBrowserLifecycle: Promise<void> = Promise.resolve();

/**
 * Run `step` once every earlier lifecycle step has settled.
 * @param step Reads or replaces `runtimeState.managedBrowser`.
 * @returns What `step` returns; its rejection does not block later steps.
 */
function withManagedBrowserLifecycle<T>(step: () => Promise<T>): Promise<T> {
	const run = managedBrowserLifecycle.then(step);
	managedBrowserLifecycle = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * Forget the managed browser, restore the CDP port it replaced, then stop it and remove its profile.
 * Call only inside `withManagedBrowserLifecycle`.
 */
async function releaseManagedBrowser(): Promise<void> {
	const managedBrowser = runtimeState.managedBrowser;
	runtimeState.managedBrowser = undefined;
	if (runtimeState.managedBrowserCdpPort && process.env.PI_COMPUTER_USE_CDP_PORT === runtimeState.managedBrowserCdpPort) {
		if (runtimeState.previousCdpPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
		else process.env.PI_COMPUTER_USE_CDP_PORT = runtimeState.previousCdpPort;
	}
	runtimeState.managedBrowserCdpPort = undefined;
	runtimeState.previousCdpPort = undefined;
	if (managedBrowser) await stopManagedBrowser(managedBrowser);
}

/**
 * Whether the managed browser must run headless: no graphical session to attach a window to.
 * `PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS` forces the answer either way (`1`/`true`, `0`/`false`).
 * macOS and Windows always have a desktop session.
 * @returns True when `--headless=new` should be passed.
 */
function managedBrowserNeedsHeadless(): boolean {
	const override = trimOrUndefined(process.env.PI_COMPUTER_USE_MANAGED_BROWSER_HEADLESS)?.toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	if (process.platform === "darwin" || process.platform === "win32") return false;
	return !trimOrUndefined(process.env.DISPLAY) && !trimOrUndefined(process.env.WAYLAND_DISPLAY);
}

/**
 * Pure argv builder for the managed browser, testable without spawning one. Headless adds
 * `--no-sandbox` only for root, whose Chromium refuses to start sandboxed.
 * @param opts Debugging port, private profile dir and first page.
 * @returns Browser arguments.
 */
function managedBrowserArgs({ remoteDebuggingPort, userDataDir, url }: { remoteDebuggingPort: number; userDataDir: string; url: string }): string[] {
	const headless = managedBrowserNeedsHeadless();
	const root = process.getuid?.() === 0;
	return [
		`--remote-debugging-port=${remoteDebuggingPort}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		...(headless ? ["--headless=new", "--disable-gpu", ...(root ? ["--no-sandbox"] : [])] : []),
		url,
	];
}

/**
 * Stop the previous managed browser, then start a new one with a private profile dir and record it.
 * Call only inside `withManagedBrowserLifecycle`.
 * @param browser Configured managed browser, which names the executable and the profile dir.
 * @param url First page to open.
 * @returns The spawned browser and its `--remote-debugging-port`, already recorded in `runtimeState`.
 * @throws {Error} If no executable is found, or `mkdtemp` or a synchronous `spawn` fails; a
 * failed spawn attempts to remove the new profile dir first.
 */
async function startManagedBrowser(browser: ComputerUseConfig["managed_browser"], url: string): Promise<{ managedBrowser: ChildProcess; port: number }> {
	const executable = await managedBrowserExecutable(browser);
	const port = await freeTcpPort();
	disconnectCdp();
	await releaseManagedBrowser();
	// A fixed name in a shared temp dir can be owned or pre-seeded by another account, so each
	// launch gets a private profile dir that lives exactly as long as its browser process.
	const profileDir = await mkdtemp(path.join(os.tmpdir(), `pi-${browser}-cdp-`));
	let managedBrowser: ChildProcess;
	try {
		const args = managedBrowserArgs({ remoteDebuggingPort: port, userDataDir: profileDir, url });
		managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
	} catch (error) {
		await removeProfileDir(profileDir);
		throw error;
	}
	// `close` also fires after an async spawn failure. Session shutdown waits for it and the exit hook
	// covers a hard exit, so the profile never outlives the browser.
	trackProfileDir(profileDir, managedBrowser);
	managedBrowser.once("close", () => void removeProfileDir(profileDir));
	managedBrowser.unref();
	runtimeState.previousCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	runtimeState.managedBrowser = managedBrowser;
	runtimeState.managedBrowserCdpPort = String(port);
	process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
	return { managedBrowser, port };
}

// Side effects: stops any previous managed browser (SIGTERM, then SIGKILL) and removes its profile,
// creates a private profile dir under os.tmpdir() tracked in `liveProfileDirs` until removed,
// installs the `exit` hook once, starts a Pi-managed browser process, and sets
// PI_COMPUTER_USE_CDP_PORT for subsequent CDP context discovery. Waits for any earlier launch or
// shutdown to finish its lifecycle step first.
async function performLaunchBrowser(params: LaunchBrowserParams, signal?: AbortSignal): Promise<AgentToolResult<BrowserObservationDetails>> {
	const requestedUrl = trimOrUndefined(params.url);
	if (requestedUrl && !/^https?:\/\//i.test(requestedUrl)) throw new Error("launch_browser.url must be an absolute HTTP(S) URL.");
	const browser = getComputerUseConfig().managed_browser;
	// Joins the lifecycle chain before the first `await`, so a shutdown called after this launch
	// always runs after it and stops the browser it starts.
	const { managedBrowser, port } = await withManagedBrowserLifecycle(async () => {
		throwIfAborted(signal);
		return await startManagedBrowser(browser, requestedUrl ?? "about:blank");
	});
	try {
		await waitForCdpPort(port, signal);
	} catch (error) {
		// A later launch or a shutdown that already took this browser over has stopped it.
		await withManagedBrowserLifecycle(async () => {
			if (runtimeState.managedBrowser === managedBrowser) await releaseManagedBrowser();
		});
		throw error;
	}
	const page = (await listCdpPageContexts())[0];
	if (!page) throw new Error("Managed browser launched without a CDP page context.");
	const resourceKey = `cdp:${page.targetId}`;
	const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(page.contextId));
	if (!scheduled.value) throw new Error("Managed browser page could not be observed after launch.");
	return browserObservationResult(scheduled.value, resourceKey, scheduled.epoch, "launch_browser");
}

async function performNavigateBrowser(params: NavigateBrowserParams): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	const url = trimOrUndefined(params.url);
	if (!contextId) throw new Error("navigate_browser.stateId must belong to a CDP browser-page observation. Native browser windows use act_ui.");
	if (!url || !/^https?:\/\//i.test(url)) throw new Error("navigate_browser.url must be an absolute HTTP(S) URL.");
	const baseSnapshot = operationState().browserSnapshot!;
	return await withBrowserWrite(contextId, async () => {
		const ok = await cdpNavigateContext(contextId, url);
		if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		return await refreshBrowserSnapshot(contextId, "navigate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
	});
}

async function performEvaluateBrowser(params: EvaluateBrowserParams): Promise<AgentToolResult<EvaluateBrowserDetails>> {
	const contextId = browserContextForOperation();
	const expression = typeof params.expression === "string" ? params.expression : "";
	if (!contextId) throw new Error("evaluate_browser.stateId must belong to a browser observation.");
	if (!expression.trim()) throw new Error("evaluate_browser.expression must be non-empty JavaScript.");
	const baseSnapshot = operationState().browserSnapshot!;
	return await withBrowserWrite(contextId, async () => {
		const result = await cdpEvaluateForContext(contextId, expression);
		if (!result) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		const successor = await refreshBrowserSnapshot(contextId, "evaluate_browser", { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline });
		const details: EvaluateBrowserDetails = {
			tool: "evaluate_browser",
			baseStateId: baseSnapshot.snapshotId,
			stateId: successor.details.stateId,
			view: successor.details.view,
			changes: successor.details.changes,
			renderedOutline: successor.details.renderedOutline,
		};
		return { content: [...successor.content, { type: "text", text: `Evaluation value: ${JSON.stringify(result.value)}` }], details };
	});
}

async function executeTool<P, T>(ctx: ExtensionContext, params: P, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
	const outputRef = trimOrUndefined((params as { ref?: string } | undefined)?.ref)?.startsWith("@o") === true;
	const requestedStateId = outputRef ? undefined : trimOrUndefined((params as { stateId?: string } | undefined)?.stateId);
	const stateRecord = requestedStateId ? savedStates.get(requestedStateId) : undefined;
	if (requestedStateId && !stateRecord) {
		throw new Error(`State '${requestedStateId}' is unavailable or was evicted. Observe the root again.`);
	}
	const operation = savedStates.hydrate(stateRecord);
	return await savedStates.operations.run(operation, async () => {
		const { value: pending } = await resourceScheduler.read("session-lifecycle", async () => {
			await ensureReady(ctx, signal);
			throwIfAborted(signal);
			// Start the tool before releasing readiness: launch_browser joins its lifecycle
			// synchronously, so shutdown cannot drain readiness and overtake that launch.
			// Do not await the tool here; unrelated operations must still overlap.
			const result = run();
			void result.catch(() => undefined);
			return { result };
		});
		const result = await pending.result;
		persistOperation(operation);
		return result;
	});
}

function makeToolExecutor<P, D>(tool: string, perform: (params: P, signal?: AbortSignal) => Promise<AgentToolResult<D>>) {
	return async (
		_toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<D> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<D>> => {
		try {
			return applyOutputEnvelope(tool, await executeTool(ctx, params, signal, () => perform(params, signal)));
		} catch (error) {
			throw boundToolError(tool, error);
		}
	};
}

export const executeFind = makeToolExecutor("find_roots", performListWindows);
export const executeReadText = makeToolExecutor("read_text", performReadText);
export const executeWaitFor = makeToolExecutor("wait_for", performWaitFor);
export const executeObserve = makeToolExecutor("observe_ui", performObserve);
export const executeSearchUi = makeToolExecutor("search_ui", performSearchUi);
export const executeExpandUi = makeToolExecutor("expand_ui", performExpandUi);
export const executeInspectUi = makeToolExecutor("inspect_ui", performInspectUi);
export const executeAct = makeToolExecutor<ActParams, ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails>("act_ui", performAct);
export const executeNavigateBrowser = makeToolExecutor("navigate_browser", performNavigateBrowser);
export const executeEvaluateBrowser = makeToolExecutor("evaluate_browser", performEvaluateBrowser);
export const executeLaunchBrowser = makeToolExecutor("launch_browser", performLaunchBrowser);

export function reconstructStateFromBranch(ctx: ExtensionContext): void {
	savedStates.clear();
	clearStoredOutputs();
	runtimeState.windowRefs.clear();
	runtimeState.windowRefByIdentity.clear();
	runtimeState.nextRootRefIndex = 1;

	const restoredResources = new Set<string>();
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if ((entry as any)?.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || message.role !== "toolResult") continue;
		if (!AGENT_TOOL_NAMES.has(message.toolName)) continue;

		const rawDetails = message.details as any;
		if (rawDetails?.tool === "find_roots" && Array.isArray(rawDetails.windows)) {
			for (const window of rawDetails.windows) {
				if (typeof window?.windowRef !== "string" || !Number.isFinite(window?.pid)) continue;
				const record: WindowRefRecord = {
					ref: window.windowRef,
					appName: typeof window.app === "string" ? window.app : "Unknown App",
					bundleId: typeof window.bundleId === "string" ? window.bundleId : undefined,
					pid: Math.trunc(window.pid),
					windowTitle: typeof window.windowTitle === "string" ? window.windowTitle : "(untitled)",
					windowId: Number.isFinite(window.windowId) ? Math.trunc(window.windowId) : undefined,
					nativeWindowRef: typeof window.nativeWindowRef === "string" ? window.nativeWindowRef : undefined,
					framePoints: {
						x: toFiniteNumber(window.framePoints?.x, 0),
						y: toFiniteNumber(window.framePoints?.y, 0),
						w: Math.max(1, toFiniteNumber(window.framePoints?.w, 1)),
						h: Math.max(1, toFiniteNumber(window.framePoints?.h, 1)),
					},
					scaleFactor: Math.max(1, toFiniteNumber(window.scaleFactor, 1)),
					isMinimized: toBoolean(window.isMinimized),
					isOnscreen: toBoolean(window.isOnscreen),
					isMain: toBoolean(window.isMain),
					isFocused: toBoolean(window.isFocused),
				};
				runtimeState.windowRefs.set(record.ref, record);
				runtimeState.windowRefByIdentity.set(windowRecordIdentity(record), record.ref);
				const match = /^@r(\d+)$/.exec(record.ref);
				if (match) runtimeState.nextRootRefIndex = Math.max(runtimeState.nextRootRefIndex, Number(match[1]) + 1);
			}
			continue;
		}

		const details = rawDetails as Partial<ComputerUseDetails> | undefined;
		if (!details?.target || !details?.capture) continue;

		const app = typeof details.target.app === "string" ? details.target.app : undefined;

		if (!app) continue;
		if (!Number.isFinite(details.target.pid) || !Number.isFinite(details.target.windowId)) continue;
		if (typeof details.capture.stateId !== "string") continue;

		const target: CurrentTarget = {
			appName: app,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
			windowRef: typeof details.target.windowRef === "string" ? details.target.windowRef : undefined,
			nativeWindowRef: typeof (details.target as any).nativeWindowRef === "string" ? (details.target as any).nativeWindowRef : undefined,
		};

		const resourceKey = desktopResourceKey(target);
		if (restoredResources.has(resourceKey)) continue;
		const capture: CurrentCapture = {
			stateId: details.capture.stateId,
			width: Math.max(1, Math.trunc(toFiniteNumber(details.capture.width, 1))),
			height: Math.max(1, Math.trunc(toFiniteNumber(details.capture.height, 1))),
			scaleFactor: Math.max(1, toFiniteNumber(details.capture.scaleFactor, 1)),
			timestamp: Number.isFinite(details.capture.timestamp) ? details.capture.timestamp : Date.now(),
		};
		// Sessions written before the outline store carry the outline inline; newer ones read it back by stateId.
		const outline = details.outline?.root && typeof details.outline.lookId === "string" ? details.outline : loadStoredOutline(capture.stateId);
		// The newest result for a resource decides it: if its outline was evicted, do not fall back to an older state.
		restoredResources.add(resourceKey);
		if (outline) {
			const epoch = 0;
			resourceScheduler.restoreEpoch(resourceKey, epoch);
			savedStates.set({
				stateId: capture.stateId,
				resourceKey,
				epoch,
				value: {
					kind: "desktop",
					target,
					capture,
					outline,
					look: {
				lookId: outline.lookId,
				capturedAt: details.capture.timestamp / 1000,
				window: {
					windowId: Math.trunc(details.target.windowId),
					framePoints: { x: 0, y: 0, w: details.capture.width, h: details.capture.height },
					scaleFactor: details.capture.scaleFactor,
					isModal: false,
					role: "",
					subrole: "",
				},
				image: { jpegBase64: "", width: details.capture.width, height: details.capture.height },
				timings: {},
					},
					note: details.note,
				},
			});
		}
	}
}

/*
PI_DOCS_REFERENCE_BEGIN reference/agent/contract

The normal loop is:

1. Find a desktop or browser root.
2. Observe that root and retain its `stateId`.
3. Search, expand, or inspect that immutable state.
4. Act using the same `stateId` and its `@e` refs.

## Tool surface

| Tool | Purpose |
| --- | --- |
| `find_roots` | Return a bounded, ranked set of desktop and CDP browser-page roots. |
| `observe_ui` | Capture the current/frontmost root or one exact `@r` root and return a compact list of actionable `@e` controls plus `stateId`. |
| `search_ui` | Run a bounded, ranked query over the full cached outline. |
| `expand_ui` | Show local outline context for one ref. |
| `inspect_ui` | Show fields, rects, actions, and evidence for one ref. |
| `act_ui` | Perform checked actions and return the resulting saved state, showing its changes or a full view when needed. |
| `read_text` | Read fixed pages from state-owned `@e` text or immutable `@o` output. |
| `wait_for` | Wait for a precise, optionally scoped condition. |
| `launch_browser` | Start a managed CDP browser and return its observed page state. |
| `navigate_browser` | Navigate the browser page owned by a state. |
| `evaluate_browser` | Evaluate JavaScript in the browser page owned by a state. |

The exact registered descriptions, prompt guidance, parameters, enums, and constraints are generated from source in [the tool reference](./tools.mdx). This page owns the cross-tool operating contract and examples instead of duplicating those schemas.

## Refs and state

`find_roots` returns roots such as `@r1`. Every desktop window, transient surface, and CDP page participates in that same forest. `observe_ui` returns element refs such as `@e12` and a `stateId`.

Every tool that consumes an `@e` ref also requires its owning `stateId`. A state remains queryable while it is in the bounded store, but a mutation from an old resource epoch is rejected as stale. `act_ui` returns the next usable `stateId`; consume it directly instead of observing again. Observe again only after an uncertain external mutation or state eviction.

Truncated textual output receives an immutable session-local ref such as `@o1`. Continue it with `read_text({ ref: "@o1", offset })`; output refs don't use a UI state id. Tool-provided `@o` offsets are UTF-8 byte offsets, while `@e` text offsets count Unicode characters.

Nodes marked `pictureOnly` have visual evidence but no platform accessibility element. Semantic actions cannot target them. Coordinate actions are available only from a current image-bearing desktop state.

## Progressive disclosure

Use `observe_ui({ root: "@r1" })` for the compact first view. It lists actionable controls only; containers, static text, tooltips, geometry, and unlabeled non-text controls are omitted and counted:

```text
Controls (3 of 212 nodes, stateId S7, root @e1):
@e12 textarea "Message" = "draft" [focused]
@e18 button "Search the web"
@e27 link "New chat"
… 209 other nodes hidden, including 4 unlabeled controls. Use search_ui to find more; expand_ui({ stateId: "S7", ref: "@e1", depth: 2 }) or observe_ui detail "outline" for structure.
```

The focused control is always listed first, followed by controls inside an open sheet or dialog. If a root exposes no actionable controls, the response falls back to the folded outline and says so. Use `observe_ui({ root: "@r1", detail: "outline" })` to get the folded outline directly. Then query without another capture:

```ts
search_ui({ stateId, text: "Save" })
expand_ui({ stateId, ref: "@e7", depth: 3 })
inspect_ui({ stateId, ref: "@e12" })
```

`semantic` observation is cheapest, `fused` is the default, and `visual` forces visual text evidence. Search requires at least one of `text`, `role`, or `capability`. It ranks exact, prefix, and substring text before conservative fuzzy matches, returns a fixed top set with the total match count, and asks the caller to refine broad queries. Search can escalate OCR once when the original desktop look omitted it; that refresh is checked against the state's resource epoch.

## Acting and batching

The public action shape is always transactional:

```ts
act_ui({ stateId, actions: [{ action: "press", ref: "@e12" }] })
```

When an action has an observable completion signal, attach it to the same
transaction. Pi waits through the platform change-notification path and marks
the execution `didnt` with `postcondition_failed` if the application swallowed
the delivered event:

```js
act_ui({
  stateId,
  actions: [{ action: "press", ref: "@e12" }],
  expect: { text: "Archive completed", until: "present", timeoutMs: 3000 }
})
```

Verification reports `verified`, `preexisting`, or `failed`. A preexisting
condition means the requested end state holds, but is not evidence that the
action caused it. Use `ref` for one exact element or `scopeRef` for a subtree;
role-only conditions must be scoped, and value checks require an exact `ref`.

Batch steps only when the second step does not need to inspect the result of the first:

```ts
act_ui({
  stateId,
  actions: [
    { action: "setText", ref: "@e18", text: "hello" },
    { action: "press", ref: "@e22" },
  ],
})
```

Steps run sequentially against one resource and retain helper checks. The native helper uses one root baseline and final settle for the transaction, and the bridge returns one final observation. If a transition can change the meaning of later refs or requires a decision, send one action, inspect the returned state, then continue.

Clicks into editable regions establish foreground focus for later keyboard steps in the same transaction. Omit `ref` from `typeText`, `paste` or `keypress` after such a click so input is sent to the editor established by that click:

```ts
act_ui({
  stateId,
  actions: [
    { action: "click", x: 420, y: 300 },
    { action: "typeText", text: "hello" },
  ],
  expect: { text: "hello" },
})
```

`secondaryAction` (`ref`, `name`) runs an accessibility action the element advertises, e.g. `AXShowMenu` to open a context menu; `inspect_ui` lists them. `selectText` (`ref`, `start`, `length`) sets the selection of a text element in UTF-16 units (`length` 0 places the caret). `paste` (`text`, optional `ref`) inserts through the pasteboard and cmd+v, then restores the previous clipboard, which suits input methods where per-key typing composes; like `typeText` it is refused in strict headless mode. These three are macOS-only and fail with `unsupported_command` elsewhere; browser (CDP) states do not support them.

The runtime prefers background semantics when they are credible, verifies the result, and escalates side-effect-free failed keyboard input to foreground delivery automatically. Ambiguous pointer actions are never replayed blindly.

### Successor views

The initial `observe_ui` response is the compact control list; expand for structure. A normal `act_ui` response saves the complete resulting state but renders only its trustworthy changes:

```text
Successor diff (1 change, S1 → S2):
~ @e9 (@e1 > @e9) value="hello"
Use stateId S2 for subsequent actions and queries.
```

Confidently matched elements retain their model-facing refs across resulting states. New nodes receive new refs and removed nodes are named explicitly. The runtime returns the compact control list instead when the root was replaced, identity confidence is low, or the change budget is too large. `search_ui`, `expand_ui`, and `inspect_ui` always query the complete saved state regardless of how it was rendered.

Coordinate fallback uses image pixels from the observed state:

```ts
act_ui({ stateId, actions: [{ action: "click", x: 420, y: 300 }] })
```

## Bounded output

Every model-visible textual result is limited to 48 KiB or 2,000 lines. Oversized results return a 16 KiB preview, focused-query guidance, and an immutable `@o` continuation. Discovery tools don't page through irrelevant matches: refine `find_roots` and `search_ui` instead. Continuation is intended for concrete long text, evaluation values, and diagnostics.

## Browser use

Browser-specific commands operate only on CDP browser-page states. `launch_browser` chooses the configured browser and debugging port internally and immediately returns an observed state:

```ts
const launched = launch_browser({ url: "https://example.com" })
act_ui({ stateId: launched.stateId, actions: [{ action: "press", ref: "@e7" }] })
navigate_browser({ stateId: returnedStateId, url: "https://openai.com" })
evaluate_browser({ stateId: returnedStateId, expression: "document.title" })
```

Browser states use the same outline, action, text, and condition contracts as desktop states. Native browser windows remain ordinary desktop UI; use `observe_ui` and `act_ui` rather than `navigate_browser` or `evaluate_browser` on them.

## Parallel calls

Pi may issue tool calls concurrently. Cached queries can overlap freely. Live work for different desktop processes or CDP pages can overlap; work for the same physical resource is ordered. Do not intentionally race two mutations derived from the same state: one wins and the other receives a stale-state error by design.
PI_DOCS_REFERENCE_END
*/
