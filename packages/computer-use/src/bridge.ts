import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, mkdirSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { debuglog } from "node:util";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ActionState,
	canRetryInForeground,
	outcomeAfterCheck,
	outcomeAfterObservedValues,
	type PreparedAction,
	prepareAction,
	strictHeadlessRejection,
	unsupportedActionRejection,
} from "./actions.ts";
import {
	type CdpConsoleEntry,
	type CdpPageSnapshot,
	cdpClickForContext,
	cdpDragForContext,
	cdpEvaluateForContext,
	cdpKeypressForContext,
	cdpMouseForContext,
	cdpNavigateContext,
	cdpScrollForContext,
	cdpSnapshotForContext,
	cdpTabForWindow,
	cdpTypeFocusedForContext,
	cdpTypeForContext,
	disconnectCdp,
	listCdpPageContexts,
} from "./cdp.ts";
import {
	blockedAppId,
	type ComputerUseConfig,
	getComputerUseConfig,
	isBrowserUseEnabled,
	isHeadlessMode,
	loadComputerUseConfig,
} from "./config.ts";
import {
	type ActParams,
	AGENT_TOOL_NAMES,
	type EvaluateBrowserParams,
	type ExpandUiParams,
	type FindParams,
	type ImageMode,
	type InspectUiParams,
	type LaunchBrowserParams,
	type NavigateBrowserParams,
	type ObserveDetail,
	type ObserveParams,
	type ObserveTargetParams,
	type ReadTextParams,
	type RootSelector,
	type SearchUiParams,
	type UiAction,
	type WaitForParams,
} from "./contract.ts";
import { withDesktopTransaction, withPhysicalInput } from "./desktop.ts";
import { normalizeFindParams } from "./find-params.ts";
import {
	noteAfterAct,
	noteForOutline,
	noteFromLook,
	noteRegionKeyForRef,
	renderNote,
	type WindowNote,
} from "./note.ts";
import {
	controlLine,
	foldToBudget,
	graftScopedOutline,
	type LookResponse,
	nodeByRef,
	type Outline,
	type OutlineChange,
	type OutlineDiff,
	type OutlineNode,
	type OutlineSearchMatch,
	outlineNodeLabel,
	outlineNodePath,
	rankedTextMatch,
	renderInteractiveControls,
	restoreOutline,
	type SerializedOutline,
	type SerializedOutlineNode,
	type SerializedOutlineSearchMatch,
	searchOutline,
	searchOutlineRanked,
	serializeOutline,
	serializeOutlineNodeShallow,
	serializeOutlineSearchMatch,
} from "./outline.ts";
import { loadStoredOutline, saveStoredOutline } from "./outline-store.ts";
import {
	applyOutputEnvelope,
	boundToolError,
	clearStoredOutputs,
	readStoredOutput,
	UI_TEXT_PAGE_CHARS,
} from "./output.ts";
import type { PermissionStatus } from "./permissions.ts";
import { toFiniteNumber } from "./platform/coerce.ts";
import { currentPlatformBackend } from "./platform/index.ts";
import type {
	FramePoints,
	PlatformFrontmostResult as FrontmostResult,
	HelperActPerformed,
	HelperActResult,
	PlatformApp as HelperApp,
	PlatformRoot as HelperWindow,
	NativeInputDelivery,
	PlatformActRequest,
	PlatformDiagnostics,
	PlatformRoot,
	PlatformRootList,
	PlatformWaitForResponse,
} from "./platform/types.ts";
import { scoreWindow, shouldPreferForegroundModalWindow } from "./root-selection.ts";
import { ResourceScheduler } from "./runtime.ts";
import { type CurrentCapture, type CurrentTarget, type OperationState, SavedStates } from "./state.ts";
import { changesBetween, renderChanges, stabilizeRefs } from "./view.ts";

export type {
	ActParams,
	EvaluateBrowserParams,
	ExpandUiParams,
	FindParams,
	ImageMode,
	InspectUiParams,
	LaunchBrowserParams,
	MouseButtonName,
	NavigateBrowserParams,
	ObserveParams,
	ObserveTargetParams,
	ReadTextParams,
	RootSelector,
	SearchUiParams,
	StateTargetParams,
	UiAction,
	WaitForParams,
} from "./contract.ts";

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
	strategy: "look" | "act" | "wait" | "browser_open_location" | "cdp_navigate";
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
		/** `inconclusive`: an `absent` condition was not found, but incomplete evidence cannot prove it gone. */
		status: "verified" | "preexisting" | "failed" | "inconclusive";
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
		appId?: string;
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
		appId?: string;
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
		identityUnresolved?: true;
		instanceUnavailable?: true;
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
	/** Heuristic, never an assertion that other pages are authenticated. */
	warning?: "authentication_required";
	/** Executable selected for this managed launch, not an attached browser. */
	executable?: string;
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
	/** Empty text from an unread (`truncated`) node: the text may exist but was not read. */
	inconclusive?: true;
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
	/** An `absent` condition was not found, but incomplete evidence cannot prove it gone; `found` stays false. */
	inconclusive?: true;
	/** Successor nodes in the condition's scope that could not be read (`truncated`); omitted when there are none. */
	unreadRefs?: string[];
	/** An inconclusive absence whose root could not be observed afterward: why. No successor state exists. */
	observationError?: string;
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
	/** Zero matches in an outline with unread (`truncated`) nodes do not prove absence. */
	inconclusive?: true;
	unreadRefs?: string[];
	target?: SerializedOutlineNode;
	note?: WindowNote;
}

interface ResolvedTarget extends CurrentTarget {
	/** Block-only names from this live root lookup; see `PlatformAppIdentity.blockAliases`. */
	blockAliases?: string[];
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
	appId?: string;
	blockAliases?: string[];
	legacyIdentity?: true;
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
const BROWSER_TRANSACTION_ACTIONS = new Set<UiAction["action"]>([
	"press",
	"click",
	"setText",
	"typeText",
	"keypress",
	"scroll",
	"drag",
	"moveMouse",
]);

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
export const testing = {
	assertBrowserTransactionAction,
	savedState: (stateId: string) => savedStates.get(stateId),
	runInOperation: <T>(fn: () => T, state: OperationState = {}): T => savedStates.operations.run(state, fn),
	buildToolResult,
	browserObservationResult,
	waitForViewText,
	sameRootIdentity,
	performSearchUi,
	performLaunchBrowser,
	persistentBrowserProfile: async (configured: string) => (await persistentBrowserProfile(configured)).directory,
	removeProfileDirsOnExit,
	managedBrowserNeedsHeadless,
	managedBrowserArgs,
	managedBrowserExecutableCandidates,
};
let resourceScheduler = new ResourceScheduler();

function operationState(): OperationState {
	return savedStates.current();
}

function desktopResourceKey(target: Pick<CurrentTarget, "pid">): string {
	return `desktop-pid:${target.pid}`;
}

function persistOperation(state: OperationState): void {
	// Every desktop capture and hydrated state carries its resource identity alongside the target and look.
	if (
		!state.currentTarget ||
		!state.currentCapture ||
		!state.currentLook ||
		!state.currentOutline ||
		!state.resourceKey ||
		state.epoch === undefined
	)
		return;
	savedStates.saveDesktop(state, state.resourceKey, state.epoch);
}

export async function setComputerUseActivity(active: boolean): Promise<void> {
	await currentPlatformBackend.setActivity?.(active);
}

/** Release handles and state owned by the current Pi session; `warn` receives a platform shutdown warning. */
export async function shutdownComputerUseSession(warn?: (message: string) => void): Promise<void> {
	await resourceScheduler.close();
	resourceScheduler = new ResourceScheduler();
	disconnectCdp();

	// Waits for a `launch_browser` already stopping, creating or spawning a browser, then stops what it produced.
	let browserStopError: unknown;
	try {
		await withManagedBrowserLifecycle(releaseManagedBrowser);
	} catch (error) {
		// A retained persistent-profile lease must not retain unrelated session state or native handles.
		browserStopError = error;
	}

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
	const warning = await currentPlatformBackend.shutdown?.();
	if (warning) warn?.(warning);
	if (browserStopError) throw browserStopError;
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
		throw new Error(
			`Outline ref '${node.ref}' has no full-look coordinates after scoped expansion. Re-observe for coordinates.`,
		);
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
		throw new Error(
			`Outline ref '${ref}' is stale or not available for the latest state. Call observe_ui${windowHint} again and choose a current @e ref.`,
		);
	}
	return node;
}

function wireRefForNode(node: OutlineNode): string {
	if (node.pictureOnly || !node.wireRef) {
		throw new Error(
			`Outline ref '${node.ref}' is pictureOnly and has no semantic element. It can be clicked by coordinates, but semantic-only actions are not available.`,
		);
	}
	return node.wireRef;
}

function imageFallbackReason(
	tool: string,
	result: CaptureResult,
	imageMode: ImageMode,
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always")
		return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	const outline = result.outline;
	const labeled = outline.nodes.filter((node) => outlineNodeLabel(node)).length;
	if (outline.nodes.length < 3) {
		return {
			reason: "sparse_ax_targets",
			message: "Only a few outline nodes were found, so the look image is attached for context.",
		};
	}
	if (labeled * 3 < outline.nodes.length) {
		return {
			reason: "unlabeled_ax_targets",
			message: "Most outline nodes are unlabeled, so the look image is attached for context.",
		};
	}
	if (tool === "wait" && currentPlatformBackend.isBrowserApp(result.target.appName, result.target.bundleId)) {
		return {
			reason: "browser_wait_verification",
			message: "Browser content may have changed visually during wait, so an image is attached for fallback.",
		};
	}
	return undefined;
}

function emptyActivation(): ActivationFlags {
	return { activated: false, unminimized: false, raised: false };
}

async function ensureReady(ctx: ExtensionContext, signal?: AbortSignal, preflight?: () => void): Promise<void> {
	loadComputerUseConfig(ctx.cwd, currentPlatformBackend.name);
	preflight?.();

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

async function listWindows(pid: number, signal?: AbortSignal): Promise<PlatformRootList> {
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

function platformRootPairing(
	window: Pick<HelperWindow, "metadata">,
): { confidence: "exact" | "high" | "low"; score: number } | undefined {
	const value = window.metadata?.pairing;
	if (!value || typeof value !== "object") return undefined;
	const pairing = value as { confidence?: unknown; score?: unknown };
	if (pairing.confidence !== "exact" && pairing.confidence !== "high" && pairing.confidence !== "low") return undefined;
	return {
		confidence: pairing.confidence,
		score:
			typeof pairing.score === "number" && Number.isFinite(pairing.score) ? pairing.score : Number.NEGATIVE_INFINITY,
	};
}

function formatWindowLine(window: ListWindowsDetails["windows"][number]): string {
	if (window.kind === "browser_page")
		return `- ${window.windowRef} browser_page ${JSON.stringify(window.windowTitle)}${window.url ? ` — ${window.url}` : ""}`;
	const flags = [
		window.isFocused ? "focused" : undefined,
		window.isMain ? "main" : undefined,
		window.isModal ? "modal" : undefined,
		window.sheetCount ? `sheets=${window.sheetCount}` : undefined,
		window.isOnscreen ? "onscreen" : undefined,
		window.isMinimized ? "minimized" : undefined,
		window.browserUseAllowed ? undefined : "browser_use_disabled",
		window.blocked ? "blocked" : undefined,
		window.identityUnresolved ? "unidentified" : undefined,
		window.instanceUnavailable ? "unbound" : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const frame = `${Math.round(window.framePoints.x)},${Math.round(window.framePoints.y)} ${Math.round(window.framePoints.w)}x${Math.round(window.framePoints.h)}`;
	const id = window.windowId
		? `windowId ${window.windowId}`
		: window.nativeWindowRef
			? `nativeRootRef ${window.nativeWindowRef}`
			: "unstable root id";
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
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ComputerUseError";
	}
}

type PolicyIdentity = Pick<HelperApp, "appId" | "bundleId" | "blockAliases">;

/** Windows and Linux resolve an executable identity per root; a root without one is refused. */
function requiresLiveIdentity(): boolean {
	return currentPlatformBackend.name === "windows" || currentPlatformBackend.name === "linux";
}

function appBlockReason(target: PolicyIdentity): string | { identityUnresolved: true } | undefined {
	if (requiresLiveIdentity() && !target.appId) return { identityUnresolved: true };
	return blockedAppId(currentPlatformBackend.name, target);
}

type AdmissionIdentity = Pick<HelperApp, "appName"> & PolicyIdentity & { legacyIdentity?: true };

function appPolicyRefusal(target: AdmissionIdentity): ComputerUseError | undefined {
	if (currentPlatformBackend.name === "windows" && target.legacyIdentity) {
		return new ComputerUseError(
			"root_stale",
			"Saved Windows root has no owner identity. Rediscover it with find_roots and observe it again.",
		);
	}
	const id = appBlockReason(target);
	if (typeof id === "object") {
		return new ComputerUseError(
			"app_blocked",
			`app_blocked: Cannot observe or control '${target.appName}': application identity could not be determined.`,
		);
	}
	if (!id) return undefined;
	return new ComputerUseError(
		"app_blocked",
		`app_blocked: '${target.appName}' (${id}) is blocked by pi-computer-use policy, so it cannot be observed or controlled. Adjust blocked_apps in ~/.pi/agent/extensions/pi-computer-use.json (system authentication agents are always blocked).`,
	);
}

function assertAppNotBlocked(target: AdmissionIdentity): void {
	const refusal = appPolicyRefusal(target);
	if (refusal) throw refusal;
}

function windowRecordIdentity(
	record: Pick<WindowRefRecord, "pid" | "windowId" | "nativeWindowRef" | "windowTitle" | "framePoints">,
): string {
	if (record.windowId && record.windowId > 0) {
		// A Windows native ref names one window instance: a same-HWND replacement gets a new `@r`.
		const instance = currentPlatformBackend.name === "windows" ? `|ref:${record.nativeWindowRef}` : "";
		return `pid:${record.pid}|id:${record.windowId}${instance}`;
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

function windowAppId(app: HelperApp, window: HelperWindow): string | undefined {
	// Windows and Linux resolve the owner on each root lookup. Never mask a failed lookup with a saved identity.
	return requiresLiveIdentity() ? window.appId : (window.appId ?? app.appId);
}

function storeWindowRefForAppWindow(app: HelperApp, window: HelperWindow): WindowRefRecord {
	return storeWindowRef({
		appName: app.appName,
		appId: windowAppId(app, window),
		// Block-only names come from this root lookup alone, like a live identity.
		blockAliases: window.blockAliases,
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
	const storedRef = storeWindowRefForAppWindow(app, window);
	const baseTarget = {
		appName: app.appName,
		appId: storedRef.appId,
		blockAliases: storedRef.blockAliases,
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
	return { ...baseTarget, windowRef: storedRef.ref };
}

/** Platform target for a resolved root: `windowId` only when real (> 0), the native ref under both spellings. */
export function nativeWindowRequest(target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">): {
	pid: number;
	windowId?: number;
	rootRef?: string;
	windowRef?: string;
} {
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
		appId: target.appId,
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

/**
 * A Windows root is bound to its original owner and window instance, not a matching title or HWND: the
 * helper issues a new native ref for a same-HWND replacement, so the saved ref must still be listed.
 * A Linux text read binds the same way to the exact AT-SPI root that owns the look (#1180).
 */
async function resolveExactRoot(
	saved: HelperApp & Pick<WindowRefRecord, "windowId" | "nativeWindowRef">,
	signal?: AbortSignal,
): Promise<ResolvedTarget> {
	const platform = currentPlatformBackend.name === "windows" ? "Windows" : "Linux";
	const windows = await listWindows(saved.pid, signal);
	const match = windows.find(
		(window) =>
			window.pid === saved.pid &&
			saved.nativeWindowRef !== undefined &&
			window.windowRef === saved.nativeWindowRef &&
			(!saved.windowId || window.windowId === saved.windowId),
	);
	if (!match)
		throw new ComputerUseError(
			"root_stale",
			`Saved ${platform} root is no longer available for its original owner and window instance. Rediscover it with find_roots.`,
		);
	if (match.instanceUnavailable)
		throw new ComputerUseError(
			"root_stale",
			"Windows root could not be admitted: its owner or window instance is unverifiable, so it cannot be observed or controlled.",
		);
	assertAppNotBlocked({ appName: saved.appName, appId: match.appId, blockAliases: match.blockAliases });
	if (match.appId!.toLowerCase() !== saved.appId!.toLowerCase()) {
		throw new ComputerUseError(
			"app_blocked",
			`${platform} root owner identity changed. Rediscover it with find_roots and observe it again.`,
		);
	}
	const target = toResolvedTarget(saved, match);
	setCurrentTarget(target);
	return target;
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
	assertAppNotBlocked(fromRef);
	if (currentPlatformBackend.name === "windows") return await resolveExactRoot(fromRef, signal);
	const app: HelperApp = fromRef;
	const windows = await listWindows(fromRef.pid, signal);
	// A partial listing admits the ref only by its verified identity: a same-title window is another root.
	const partial = windows.complete === false;
	const match =
		(fromRef.windowId ? windows.find((window) => window.windowId === fromRef.windowId) : undefined) ??
		(fromRef.nativeWindowRef ? windows.find((window) => window.windowRef === fromRef.nativeWindowRef) : undefined) ??
		(partial
			? undefined
			: windows.find((window) => normalizeText(window.title || "(untitled)") === normalizeText(fromRef.windowTitle)));
	if (!match && partial)
		throw new ComputerUseError(
			"inventory_incomplete",
			`Root ref '${selector}' could not be verified: the window listing was incomplete and does not name it; it may still be open. Call find_roots again, or observe_ui it later.`,
		);
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
 * `exact` (Linux `read_text`) re-lists the root only by its native ref and live owner identity, like Windows;
 * `exactIdentity` (a claimed `wait_for` absence) drops the title and ranking fallbacks of the listing path.
 */
async function resolveCurrentTarget(
	signal?: AbortSignal,
	options: { preferModal?: boolean; exact?: boolean; exactIdentity?: boolean } = {},
): Promise<ResolvedTarget> {
	// Selection checks/sets the target; desktop state consumers first require a capture.
	// Saved desktop captures always hydrate with a target (see the #755 call-path proof).
	const current = operationState().currentTarget!;
	assertAppNotBlocked(current);
	if (currentPlatformBackend.name === "windows" || options.exact) return await resolveExactRoot(current, signal);
	const windows = await listWindows(current.pid, signal);
	const partial = windows.complete === false;
	if (!windows.length && !partial) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const hadStableWindowId = current.windowId > 0;
	const titleQuery = normalizeText(current.windowTitle);
	let match = current.nativeWindowRef
		? windows.find(
				(window) => window.windowRef === current.nativeWindowRef || window.rootRef === current.nativeWindowRef,
			)
		: undefined;
	match ??= hadStableWindowId
		? windows.find((window) => window.windowId !== undefined && window.windowId === current.windowId)
		: undefined;
	// A partial listing, or a caller that needs this exact root, admits it only by its verified identity: a
	// title or ranking match could be another window.
	if (!match && partial)
		throw new ComputerUseError(
			"inventory_incomplete",
			"The current controlled window could not be verified: the window listing was incomplete and does not name it; it may still be open. Call observe_ui again, or find_roots to choose a root.",
		);
	if (!match && options.exactIdentity) throw new Error(CURRENT_TARGET_GONE_ERROR);
	if (!match) {
		const exactTitleMatches =
			titleQuery && titleQuery !== "(untitled)"
				? windows.filter((window) => normalizeText(window.title) === titleQuery)
				: [];
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

	const modal =
		options.preferModal === false
			? undefined
			: windows
					.filter((window) => shouldPreferForegroundModalWindow(match!, window))
					.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
	if (modal) match = modal;

	const app: HelperApp = {
		appName: current.appName,
		appId: current.appId,
		bundleId: current.bundleId,
		pid: current.pid,
	};

	const resolved = toResolvedTarget(app, match);
	setCurrentTarget(resolved);
	return resolved;
}

async function resolveFrontmostTarget(signal?: AbortSignal): Promise<ResolvedTarget> {
	const frontmost = await getFrontmost(signal);
	assertAppNotBlocked(frontmost);
	const apps = await listApps(signal);
	const app = apps.find((candidate) => candidate.pid === frontmost.pid) ?? {
		appName: frontmost.appName,
		appId: frontmost.appId,
		bundleId: frontmost.bundleId,
		pid: frontmost.pid,
	};
	assertAppNotBlocked(app);

	const windows = await listWindows(frontmost.pid, signal);
	if (!windows.length) {
		throw new Error("No frontmost controllable root was found. Open an app window and call observe_ui again.");
	}

	if (currentPlatformBackend.isBrowserApp(app.appName, app.bundleId)) {
		assertBrowserUseAllowed(app);
	}

	let selected = windows.find((window) => window.windowId !== undefined && window.windowId === frontmost.windowId);
	// A partial listing that omits the named frontmost window cannot stand in another for it, by title or rank.
	if (!selected && windows.complete === false && frontmost.windowId !== undefined)
		throw new ComputerUseError(
			"inventory_incomplete",
			"The frontmost window could not be verified: the window listing was incomplete and does not name it; it may still be open. Call observe_ui again, or find_roots to choose a root.",
		);
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

async function performLook(
	target: ResolvedTarget,
	options: {
		readText: "auto" | "always" | "never";
		baseLookId?: string;
		scopeRef?: string;
		maxDimension?: number;
		includeImage?: boolean;
	},
	signal?: AbortSignal,
): Promise<LookResponse> {
	return await currentPlatformBackend.observe(
		{
			target: nativeWindowRequest(target),
			baseLookId: options.baseLookId,
			readText: options.readText,
			scopeRef: options.scopeRef,
			maxDimension: options.maxDimension,
			includeImage: options.includeImage,
		},
		{ signal, timeoutMs: LOOK_TIMEOUT_MS },
	);
}

function noteWindowForTarget(target: ResolvedTarget | CurrentTarget, look?: LookResponse) {
	return {
		windowRef: target.windowRef,
		title: target.windowTitle,
		pairing:
			look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object"
				? (look.window.metadata.pairing as { confidence?: "exact" | "high" | "low" }).confidence
				: undefined,
		pairingScore:
			look?.window.metadata?.pairing && typeof look.window.metadata.pairing === "object"
				? (look.window.metadata.pairing as { score?: number }).score
				: undefined,
	};
}

/** Capture `resolved`, the root the caller already resolved, as the new current state. */
async function captureCurrentTarget(
	signal: AbortSignal | undefined,
	readText: "auto" | "always" | "never",
	maxDimension: number,
	resolved: ResolvedTarget,
	includeImage = true,
): Promise<CaptureResult> {
	const state = operationState();
	const baseOutline = state.currentOutline;
	const baseTarget = state.currentTarget;
	const target = await ensureTargetWindowId(resolved, signal);
	const look = await performLook(target, { maxDimension, readText, includeImage }, signal);
	const outline = stabilizeRefs(
		baseTarget && sameRootIdentity(baseTarget, target) ? baseOutline : undefined,
		look.parsedOutline!,
	);
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

function renderStateView(
	outline: Outline,
	stateId: string,
	detail: ObserveDetail,
	reason?: string,
): { detail: ObserveDetail; text: string } {
	const reasonText = reason ? `, full view: ${reason}` : "";
	const controls = detail === "compact" ? renderInteractiveControls(outline) : undefined;
	if (controls?.controlCount) {
		const unlabeled = controls.omittedUnlabeled
			? `, including ${controls.omittedUnlabeled} unlabeled control${controls.omittedUnlabeled === 1 ? "" : "s"}`
			: "";
		const footer = `… ${controls.nodeCount - controls.renderedRefs.length} other nodes hidden${unlabeled}. Use search_ui to find more; expand_ui({ stateId: "${stateId}", ref: "${outline.root.ref}", depth: 2 }) or observe_ui detail "outline" for structure.`;
		return {
			detail,
			text: `Controls (${controls.renderedRefs.length} of ${controls.nodeCount} nodes, stateId ${stateId}, root ${outline.root.ref}${reasonText}):\n${controls.text}\n${footer}`,
		};
	}
	const folded = foldToBudget(outline);
	return {
		detail: "outline",
		text: `Outline (${folded.nodeCount} nodes, stateId ${stateId}${reasonText}${controls ? ", no actionable controls found" : ""}${folded.truncated ? ", folded output truncated" : ""}):\n${folded.text}`,
	};
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
	const view = useDiff
		? undefined
		: renderStateView(result.outline, result.capture.stateId, detail, transition?.reason);
	const renderedNote = renderNote(state.currentNote);

	// The session file keeps only `capture.stateId`/`lookId`; restore reads the outline back from here.
	saveStoredOutline(result.capture.stateId, serializeOutline(result.outline));
	const details: ComputerUseDetails = {
		tool,
		target: {
			app: result.target.appName,
			appId: result.target.appId,
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
	const content: AgentToolResult<ComputerUseDetails>["content"] = [
		{
			type: "text",
			text: `${summary}${deltaText ? `\n${deltaText}` : ""}${consoleText}${noteText}${outlineText}${fallbackText}`,
		},
	];
	if (fallbackReason && result.look.image?.jpegBase64) {
		content.push({
			type: "image",
			data: result.look.image.jpegBase64,
			mimeType: result.look.image.mimeType ?? "image/jpeg",
		});
	}

	return { content, details };
}

/** Desktop acts only run once `currentCaptureOrThrow` passed, and every desktop capture or hydrated state carries its look. */
function currentLook(): LookResponse {
	return operationState().currentLook!;
}

function ensurePointIsInLookImage(x: number, y: number, look: LookResponse, errorPrefix = "Coordinates"): void {
	if (!look.image?.jpegBase64) {
		throw new Error(
			`${errorPrefix} require an image-bearing root. This look is outline-only; use an @e ref with a semantic action or observe an image-bearing root.`,
		);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= look.image.width || y >= look.image.height) {
		throw new Error(
			`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest look image bounds (${look.image.width}x${look.image.height}). Call observe_ui again and retry.`,
		);
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
	// A native semantic timeout (Linux AT-SPI2 rejects `act` with code `timeout`) leaves delivery indeterminate.
	// Report it as an unknown step so the transaction accounts for it instead of failing the completed prefix.
	const timedOut = (error: unknown): HelperActResult => {
		const failure = error as (Error & { code?: string }) | undefined;
		if (failure?.code !== "timeout") throw error;
		return { outcome: "unknown", error: { code: "timeout", message: failure.message } };
	};
	const textTimeout = "text" in action.params ? action.params.text.length * 25 + 4_000 : COMMAND_TIMEOUT_MS;
	const timeoutMs = Math.max(COMMAND_TIMEOUT_MS, textTimeout);
	// Only foreground delivery posts real cursor/keyboard events; it alone takes the desktop lock shared with
	// desktop_input / desktop_screenshot, held to the end of the act_ui transaction once taken.
	// Background, pid, and AX acts stay concurrent per window.
	const actInForeground = () =>
		withPhysicalInput(
			() => currentPlatformBackend.act(helperActRequest(target, action, "foreground"), { signal, timeoutMs }),
			signal,
		).catch(timedOut);
	if ((action.usesCurrentFocus || action.needsForeground) && !headless) {
		const foreground = checked(await actInForeground());
		const trace = executionTraceFromAct(foreground, "foreground");
		trace.backgroundFirst = false;
		return trace;
	}
	try {
		const initialPolicy = headless ? "ax_only" : "background";
		const result = checked(
			await currentPlatformBackend
				.act(helperActRequest(target, action, initialPolicy), { signal, timeoutMs })
				.catch(timedOut),
		);
		if (canRetryInForeground(action, result, headless)) {
			const foreground = checked(await actInForeground());
			const trace = executionTraceFromAct(foreground, "foreground");
			trace.backgroundFirst = true;
			trace.escalatedToForeground = true;
			trace.escalationReason = "side_effect_free_didnt";
			trace.backgroundAttempt = {
				outcome: "didnt",
				reason: "Background input posted nothing; a foreground retry was safe.",
			};
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
		trace.backgroundAttempt = {
			outcome: "foreground_required",
			reason: error instanceof Error ? error.message : String(error),
		};
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
			case "click":
				return { ...base, action: action.action, params: { ...action.params, delivery } };
			case "setText":
				return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "typeText":
				return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "paste":
				return { ...base, action: action.action, params: { text: action.params.text, delivery } };
			case "keypress":
				return { ...base, action: action.action, params: { keys: action.params.keys, delivery } };
			case "secondaryAction":
				return { ...base, action: action.action, params: { name: action.params.name, delivery } };
			case "selectText":
				return {
					...base,
					action: action.action,
					params: { start: action.params.start, length: action.params.length, delivery },
				};
			case "scroll":
				return {
					...base,
					action: action.action,
					params: { scrollX: action.params.scrollX, scrollY: action.params.scrollY, delivery },
				};
			case "drag":
				return { ...base, action: action.action, params: { path: action.params.path, delivery } };
			case "moveMouse":
				return { ...base, action: action.action, params: { delivery } };
		}
	})();
}

function rootDeltaLines(execution: ExecutionTrace): string[] {
	return (execution.rootDelta ?? []).map((delta) => {
		const quotedTitle = delta.title ? ` ${JSON.stringify(delta.title)}` : "";
		const ref = delta.ref ? ` (${delta.ref.startsWith("@") ? delta.ref : `@${delta.ref}`})` : "";
		const sheetCount =
			typeof delta.metadata?.sheetCount === "number" && Number.isFinite(delta.metadata.sheetCount)
				? Math.max(0, Math.trunc(delta.metadata.sheetCount))
				: undefined;
		const flags = [delta.isModal ? "modal" : undefined, sheetCount ? `sheets=${sheetCount}` : undefined]
			.filter(Boolean)
			.join(", ");
		const suffix = `${quotedTitle}${flags ? ` (${flags})` : ""}${ref}`;
		if (delta.change === "appeared") return `New root: ${delta.kind}${suffix}`;
		if (delta.change === "closed") return `Root closed: ${delta.kind}${suffix}`;
		return `Root focused: ${delta.kind}${suffix}`;
	});
}

function windowDetails(
	app: HelperApp,
	window: HelperWindow,
	config: ReturnType<typeof getComputerUseConfig>,
): ListWindowsDetails["windows"][number] {
	const storedRef = storeWindowRefForAppWindow(app, window);
	const blockReason = appBlockReason(storedRef);
	return {
		app: app.appName,
		appId: storedRef.appId,
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
		blocked: blockReason !== undefined,
		...(typeof blockReason === "object" ? blockReason : {}),
		...(window.instanceUnavailable ? { instanceUnavailable: true as const } : {}),
		score: scoreWindow(window),
	};
}

function sortWindowDetails(windows: ListWindowsDetails["windows"]): ListWindowsDetails["windows"] {
	return windows.sort(
		(a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle),
	);
}

// Side effect: stores stable @r refs for discovered windows in runtimeState.
async function collectWindowDetails(
	apps: HelperApp[],
	config: ReturnType<typeof getComputerUseConfig>,
	signal?: AbortSignal,
): Promise<ListWindowsDetails["windows"]> {
	const perApp = await Promise.all(apps.map(async (app) => ({ app, windows: await listWindows(app.pid, signal) })));
	return sortWindowDetails(
		perApp.flatMap(({ app, windows }) => windows.map((window) => windowDetails(app, window, config))),
	);
}

function collectBroadWindowDetails(
	roots: HelperWindow[],
	config: ReturnType<typeof getComputerUseConfig>,
): ListWindowsDetails["windows"] {
	const windows: ListWindowsDetails["windows"] = [];
	for (const window of roots) {
		if (!window.pid) continue;
		windows.push(
			windowDetails(
				{ appName: window.appName ?? "Unknown App", bundleId: window.bundleId, pid: window.pid },
				window,
				config,
			),
		);
	}
	return sortWindowDetails(windows);
}

async function windowDetailsForFind(
	query: FindParams,
	config: ReturnType<typeof getComputerUseConfig>,
	signal?: AbortSignal,
): Promise<ListWindowsDetails["windows"]> {
	if (!query.app && !query.bundleId && !Number.isFinite(query.pid)) {
		return collectBroadWindowDetails(await currentPlatformBackend.listRoots({}, signal), config);
	}
	const apps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	return await collectWindowDetails(apps, config, signal);
}

async function performListWindows(
	params: FindParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<ListWindowsDetails>> {
	const query = normalizeFindParams(params, currentPlatformBackend.name);
	const config = getComputerUseConfig();
	const desktopForest = await windowDetailsForFind(query, config, signal);
	const includeBrowserPages =
		!query.pid && !query.bundleId && (!query.app || normalizeText(query.app) === "browser") && config.browser_use;
	const browserForest: ListWindowsDetails["windows"] = !includeBrowserPages
		? []
		: (await listCdpPageContexts().catch(() => [])).map((page) => ({
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
	const ranked = forest
		.map((root, order) => ({
			root,
			order,
			match: query.text
				? rankedTextMatch([root.app, root.windowTitle], query.text)
				: { reason: "filter" as const, score: 1 },
		}))
		.filter((entry) => entry.match)
		.sort(
			(a, b) =>
				b.match!.score - a.match!.score ||
				Number(b.root.isFocused) - Number(a.root.isFocused) ||
				a.root.zOrder - b.root.zOrder ||
				a.order - b.order,
		);
	const totalMatches = ranked.length;
	const windows = ranked.slice(0, 12).map((entry) => entry.root);
	const details: ListWindowsDetails = {
		tool: "find_roots",
		query,
		windows,
		totalMatches,
		returned: windows.length,
		hasMore: totalMatches > windows.length,
		config,
	};
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${totalMatches} matching root${totalMatches === 1 ? "" : "s"}; returned ${windows.length}${totalMatches > windows.length ? ". Refine the filters for additional roots" : ""}. Use @r refs with observe_ui({ root: "@rN" }).\n${lines.join("\n")}`
		: query.text || query.app || query.bundleId || query.pid || query.kind
			? ["No roots matched the supplied filters.", currentPlatformBackend.emptyRootsHint?.()].filter(Boolean).join(" ")
			: ["No roots are currently visible to pi-computer-use.", currentPlatformBackend.emptyRootsHint?.()]
					.filter(Boolean)
					.join(" ");
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

function browserObservationResult(
	browser: CdpPageSnapshot,
	resourceKey: string,
	epoch: number,
	tool: string,
	base?: { stateId: string; outline: SerializedOutline },
	detail: ObserveDetail = "compact",
): AgentToolResult<BrowserObservationDetails> {
	savedStates.set({
		stateId: browser.snapshotId,
		resourceKey,
		epoch,
		value: { kind: "browser", snapshot: browser, outline: browser.outline },
	});
	const currentOutline = restoreOutline(browser.outline);
	const transition = base ? changesBetween(restoreOutline(base.outline), currentOutline) : undefined;
	const useDiff = Boolean(transition && !transition.useFullView);
	const folded = foldToBudget(currentOutline);
	const view = useDiff
		? undefined
		: detail === "outline"
			? { detail, text: folded.text }
			: renderStateView(currentOutline, browser.snapshotId, detail);
	const root = {
		ref: storeBrowserRootRef(browser.contextId),
		kind: "browser_page" as const,
		title: browser.title,
		url: browser.url,
	};
	const authenticationRequired =
		/\b(?:sign[ -]?in|log[ -]?in)\b/i.test(browser.title) ||
		/\/(?:login|signin|sign-in)(?:[/?#]|$)/i.test(browser.url) ||
		browser.targets.some((target) => target.role === "textbox" && /\bpassword\b/i.test(target.name));
	const warning = authenticationRequired ? ("authentication_required" as const) : undefined;
	const details: BrowserObservationDetails = {
		warning,
		tool,
		kind: "browser_page",
		stateId: browser.snapshotId,
		baseStateId: base?.stateId,
		view: useDiff ? "diff" : "full",
		changes: useDiff ? transition?.changes : undefined,
		root,
		renderedOutline: folded.text,
		detail: view?.detail,
	};
	const viewText = view
		? view.text
		: `Changes (${transition!.changedNodeCount}, ${base!.stateId} → ${browser.snapshotId}):\n${renderChanges(transition!.changes) || "(no element changes)"}\nUse stateId ${browser.snapshotId} for subsequent actions and queries.`;
	return {
		content: [
			{
				type: "text",
				text: `${tool} completed for ${root.ref} ${JSON.stringify(browser.title)}. State ${browser.snapshotId}.\n${warning ? "Warning: authentication_required (possible login wall). Ask the user before any sign-in; credentials are not authorized by this observation.\n" : ""}${viewText}`,
			},
		],
		details,
	};
}

async function refreshBrowserSnapshot(
	contextId: string,
	tool: string,
	base?: { stateId: string; outline: SerializedOutline },
): Promise<AgentToolResult<BrowserObservationDetails>> {
	const browser = await cdpSnapshotForContext(contextId);
	if (!browser)
		throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
	// Only called inside `withBrowserWrite`, which has recorded the resource key and the written epoch.
	const state = operationState();
	return browserObservationResult(browser, state.resourceKey!, state.epoch!, tool, base);
}

function sliceText(
	value: string,
	offsetValue: unknown,
	_limitValue?: unknown,
): Pick<ReadTextDetails, "offset" | "limit" | "totalChars" | "hasMore" | "text"> {
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

async function performReadText(
	params: ReadTextParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadTextDetails>> {
	const ref = trimOrUndefined(params.ref);
	if (ref?.startsWith("@o")) {
		const page = readStoredOutput(ref, params.offset);
		if (!page) throw new Error(`Output ref '${ref}' is unavailable or was evicted. Rerun the focused query.`);
		const details: ReadTextDetails = { tool: "read_text", ref, ...page };
		const suffix = page.hasMore
			? `\n\ncontinue: read_text({ ref: "${ref}", offset: ${page.offset + page.limit} })`
			: page.complete
				? ""
				: "\n\ncontinuation storage limit reached; rerun a more focused query for the remainder";
		return { content: [{ type: "text", text: `${page.text || "(empty output page)"}${suffix}` }], details };
	}
	const contextId = operationState().contextId;
	if (isBrowserContextId(contextId)) {
		const snapshot = operationState().browserSnapshot!;
		if (!ref)
			throw new Error(
				"read_text requires an @e ref for browser contexts; use the outline root ref for whole-page text.",
			);
		const outline = restoreOutline(snapshot.outline);
		const node = nodeByRef(outline, ref);
		if (!node) throw new Error(`Browser text ref '${ref}' is unavailable in this state.`);
		const collect = (current: OutlineNode): string[] =>
			[
				outlineNodeLabel(current),
				...current.text.map((item) => item.string),
				...current.children.flatMap(collect),
			].filter(Boolean);
		const value = node === outline.root ? snapshot.text : [...new Set(collect(node))].join("\n");
		const sliced = sliceText(value, params.offset);
		const details: ReadTextDetails = { tool: "read_text", ref, ...sliced };
		return { content: [{ type: "text", text: sliced.text || "(empty text slice)" }], details };
	}

	currentCaptureOrThrow();
	if (!ref)
		throw new Error(
			"read_text requires ref for desktop contexts. Call observe_ui/inspect_ui and use a text-bearing outline ref.",
		);
	const node = outlineNodeByRef(ref);
	const state = operationState();
	const raw = (
		await resourceScheduler.readAt(state.resourceKey!, state.epoch!, async () => {
			// Revalidate the exact root owning the look and its live identity before any live read.
			const target = requiresLiveIdentity() ? await resolveCurrentTarget(signal, { exact: true }) : undefined;
			return await currentPlatformBackend.readText(
				{
					...(target ? { pid: target.pid, windowId: target.windowId } : {}),
					lookId: state.currentOutline!.lookId,
					elementRef: wireRefForNode(node),
					offset: Math.max(0, Math.trunc(toFiniteNumber(params.offset, 0))),
					limit: UI_TEXT_PAGE_CHARS,
				},
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			);
		})
	).value;
	const text = raw.text;
	// A backend can default a timed-out or failed text read to empty; on an unread node that is not evidence.
	const unread = !text && node.truncated;
	const details: ReadTextDetails = {
		tool: "read_text",
		ref,
		offset: raw.offset,
		limit: raw.limit,
		totalChars: raw.totalChars,
		hasMore: raw.hasMore,
		text,
		...(unread ? { inconclusive: true as const } : {}),
	};
	const empty = unread
		? `(no text read: ${ref} is unread (truncated), so empty text is not evidence. expand_ui it or observe_ui again, then retry read_text.)`
		: "(empty text slice)";
	return { content: [{ type: "text", text: text || empty }], details };
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

function validateCondition(params: WaitForParams | NonNullable<ActParams["expect"]>): {
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	scopeExact: boolean;
	gone: boolean;
	timeoutMs: number;
} {
	const text = trimOrUndefined(params.text);
	const role = trimOrUndefined(params.role);
	const value = trimOrUndefined(params.value);
	const scopeRef = conditionScopeRef(params);
	if (!text && !role && !value) throw new Error("A UI condition requires text, role, or value.");
	if (role && !text && !value && !scopeRef) throw new Error("A role-only UI condition requires ref or scopeRef.");
	if (value && !params.ref) throw new Error("A value UI condition requires an exact ref.");
	return {
		text,
		role,
		value,
		scopeRef,
		scopeExact: Boolean(params.ref),
		gone: params.until === "absent",
		timeoutMs: normalizeWaitTimeoutMs(params.timeoutMs),
	};
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
	return value
		.toLowerCase()
		.replace(/^ax/, "")
		.replace(/[ _-]+/g, "");
}

function platformRole(outline: Outline, role: string | undefined): string | undefined {
	if (!role) return undefined;
	return outline.nodes.find((node) => normalizedRole(node.role) === normalizedRole(role))?.role ?? role;
}

function outlineConditionPresent(outline: Outline, condition: ReturnType<typeof validateCondition>): boolean {
	return searchOutline(outline, condition.text, undefined, undefined, outline.nodes.length).some(
		(match) =>
			(!condition.role || normalizedRole(match.node.role) === normalizedRole(condition.role)) &&
			nodeWithinScope(match.node, condition.scopeRef, condition.scopeExact) &&
			(!condition.value || normalizeText(match.node.value) === normalizeText(condition.value)),
	);
}

/** Why a successor outline cannot corroborate a `gone` condition (see `absenceUnproven`). */
interface AbsenceUnproven {
	/** `present`: the successor still shows it; `unread`: nodes it could hide in are unread; `scope_unmatched`: its scope did not carry over and the condition shows elsewhere. */
	reason: "present" | "unread" | "scope_unmatched";
	/** Unread (`truncated`) successor nodes that could hold the condition. */
	unreadRefs: string[];
}

/**
 * Why a successor outline cannot corroborate a `gone` condition: it still shows the condition, or a node that is
 * the condition's scope, above it, or (unless exact) inside it is unread (`truncated`). The Windows UIA wait does
 * not report its own truncation, so absence is checked here on every platform. Element wire refs are look-local and
 * public refs carry over structurally, so a moved scope can arrive under a fresh ref: a scope ref missing from the
 * successor proves nothing while the condition shows anywhere in it. `undefined` when corroborated.
 */
function absenceUnproven(
	outline: Outline,
	condition: ReturnType<typeof validateCondition>,
): AbsenceUnproven | undefined {
	if (outlineConditionPresent(outline, condition)) return { reason: "present", unreadRefs: [] };
	const scope = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
	if (condition.scopeRef && !scope && outlineConditionPresent(outline, { ...condition, scopeRef: undefined }))
		return { reason: "scope_unmatched", unreadRefs: [] };
	const unreadRefs = outline.nodes
		.filter(
			(node) =>
				node.truncated &&
				(!scope ||
					nodeWithinScope(scope, node.ref, false) ||
					(!condition.scopeExact && nodeWithinScope(node, scope.ref, false))),
		)
		.map((node) => node.ref);
	return unreadRefs.length > 0 ? { reason: "unread", unreadRefs } : undefined;
}

function absenceUnprovenMessage(unproven: AbsenceUnproven): string {
	if (unproven.reason === "present") return "the successor observation still shows the condition";
	if (unproven.reason === "scope_unmatched")
		return "its scope could not be matched in the successor observation, which shows the condition elsewhere";
	const { unreadRefs } = unproven;
	const list = `${unreadRefs.slice(0, 5).join(", ")}${unreadRefs.length > 5 ? ", ..." : ""}`;
	return `${unreadRefs.length} node${unreadRefs.length === 1 ? "" : "s"} in its scope could not be read (${list})`;
}

function conditionScopeNode(
	outline: Outline,
	condition: ReturnType<typeof validateCondition>,
): OutlineNode | undefined {
	const scopeNode = condition.scopeRef ? nodeByRef(outline, condition.scopeRef) : undefined;
	if (condition.scopeRef && !scopeNode)
		throw new Error(`Condition scope ref '${condition.scopeRef}' is unavailable in this state.`);
	return scopeNode;
}

function waitForViewText(outline: Outline, stateId: string, transition: OutlineDiff): string {
	return transition.useFullView
		? renderStateView(outline, stateId, "compact").text
		: `${renderChanges(transition.changes) || "(no element changes)"}\nUse stateId ${stateId} for subsequent actions and queries.`;
}

/**
 * A claimed absence whose root could not be observed afterward: without a successor observation it stays
 * `inconclusive`, and the base state is left as the current one.
 */
function unobservedAbsence(
	baseStateId: string,
	raw: PlatformWaitForResponse,
	condition: ReturnType<typeof validateCondition>,
	error: unknown,
): AgentToolResult<WaitForDetails> {
	const { text, role, value, scopeRef } = condition;
	const reason = error instanceof Error ? error.message : String(error);
	return {
		content: [
			{
				type: "text",
				text: `Inconclusive: the condition is not proven gone: its root could not be observed afterward (${reason}). No successor state was created; state ${baseStateId} is unchanged. Call find_roots, then observe_ui before treating it as gone.`,
			},
		],
		details: {
			tool: "wait_for",
			stateId: baseStateId,
			baseStateId,
			view: "full",
			found: false,
			timedOut: raw.timedOut || undefined,
			inconclusive: true,
			observationError: reason,
			nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : undefined,
			text,
			role,
			value,
			scopeRef,
			renderedOutline: "",
		},
	};
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
		const finish = (
			lastSnapshot: CdpPageSnapshot,
			lastEpoch: number,
			found: boolean,
			timedOut?: boolean,
		): AgentToolResult<WaitForDetails> => {
			savedStates.set({
				stateId: lastSnapshot.snapshotId,
				resourceKey,
				epoch: lastEpoch,
				value: { kind: "browser", snapshot: lastSnapshot, outline: lastSnapshot.outline },
			});
			const successorOutline = restoreOutline(lastSnapshot.outline);
			const transition = changesBetween(restoreOutline(baseSnapshot.outline), successorOutline);
			const useDiff = !transition.useFullView;
			const renderedOutline = foldToBudget(successorOutline).text;
			const details: WaitForDetails = {
				tool: "wait_for",
				stateId: lastSnapshot.snapshotId,
				baseStateId: baseSnapshot.snapshotId,
				view: useDiff ? "diff" : "full",
				changes: useDiff ? transition.changes : undefined,
				found,
				gone: (found && gone) || undefined,
				timedOut,
				nodeCount: lastSnapshot.targets.length,
				text,
				role,
				value,
				scopeRef,
				renderedOutline,
			};
			const message = found
				? gone
					? "Condition disappeared."
					: "Condition appeared."
				: `Timed out after ${timeoutMs}ms waiting for condition.`;
			return {
				content: [
					{
						type: "text",
						text: `${message}\n${waitForViewText(successorOutline, lastSnapshot.snapshotId, transition)}`,
					},
				],
				details,
			};
		};
		let snapshot: CdpPageSnapshot | undefined;
		let epoch: number;
		do {
			const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(contextId));
			snapshot = scheduled.value;
			epoch = scheduled.epoch;
			if (!snapshot)
				throw new Error(`Browser root '${contextId}' is no longer available. Call find_roots and observe_ui again.`);
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
	const raw = await currentPlatformBackend.waitFor(
		{
			...nativeWindowRequest(target),
			lookId: state.currentOutline!.lookId,
			text,
			role: platformRole(state.currentOutline!, role),
			value,
			scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
			scopeExact,
			gone,
			timeoutMs,
		},
		{ signal, timeoutMs: timeoutMs + 2_000 },
	);
	// A helper's `gone`, or its incomplete walk, holds only when the successor observation corroborates it.
	const absenceClaimed = gone && (raw.found || raw.incomplete === true);
	let refreshed: CaptureResult;
	try {
		// A desktop state hydrates from a saved record, which always carries its resource identity. The successor
		// re-resolves the root the wait read (by its native ref, so a changed window id is followed) without
		// moving to a foreground modal: a modal opened meanwhile is another root, not evidence for this one. Only the
		// exact waited root corroborates an absence: a same-title window reached by fallback never does.
		refreshed = (
			await resourceScheduler.readAt(
				state.resourceKey!,
				state.epoch!,
				async () =>
					await captureCurrentTarget(
						signal,
						"auto",
						AUTO_IMAGE_MAX_DIMENSION,
						await resolveCurrentTarget(signal, { preferModal: false, exactIdentity: absenceClaimed }),
					),
			)
		).value;
	} catch (error) {
		if (signal?.aborted || !absenceClaimed) throw error;
		return unobservedAbsence(baseView.stateId, raw, condition, error);
	}
	const transition = changesBetween(baseView.outline, refreshed.outline);
	const useDiff = !transition.useFullView;
	const matches = searchOutline(refreshed.outline, text, role, undefined, 1);
	const foundTarget = matches[0];
	const helperIncomplete = gone && raw.incomplete === true;
	const unproven = absenceClaimed ? absenceUnproven(refreshed.outline, condition) : undefined;
	const inconclusive = helperIncomplete || unproven !== undefined;
	const details: WaitForDetails = {
		tool: "wait_for",
		stateId: refreshed.capture.stateId,
		baseStateId: baseView.stateId,
		view: useDiff ? "diff" : "full",
		changes: useDiff ? transition.changes : undefined,
		found: raw.found && !inconclusive,
		gone: (raw.gone && !inconclusive) || undefined,
		timedOut: raw.timedOut || undefined,
		...(inconclusive ? { inconclusive: true as const } : {}),
		...(unproven?.unreadRefs.length ? { unreadRefs: unproven.unreadRefs } : {}),
		target: foundTarget ? serializeOutlineSearchMatch(foundTarget) : undefined,
		nodeCount: Number.isFinite(raw.nodeCount) ? Number(raw.nodeCount) : refreshed.outline.nodes.length,
		text,
		role,
		value,
		scopeRef,
		renderedOutline: foldToBudget(refreshed.outline).text,
	};
	const message = inconclusive
		? `Inconclusive: the condition is not proven gone: ${helperIncomplete ? `the accessibility tree could not be read completely within ${timeoutMs}ms` : absenceUnprovenMessage(unproven!)}. Observe or wait again before treating it as gone.`
		: details.found
			? details.gone
				? "Condition disappeared."
				: "Condition appeared."
			: `Timed out after ${timeoutMs}ms waiting for condition.`;
	return {
		content: [
			{
				type: "text",
				text: `${message}\n${waitForViewText(refreshed.outline, refreshed.capture.stateId, transition)}`,
			},
		],
		details,
	};
}

function sameRootIdentity(a: CurrentTarget, b: CurrentTarget): boolean {
	if (a.pid !== b.pid) return false;
	// A Windows native ref names one window instance; a same-HWND replacement is another root.
	if (currentPlatformBackend.name === "windows")
		return a.nativeWindowRef !== undefined && a.nativeWindowRef === b.nativeWindowRef;
	if (a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return normalizeText(a.windowTitle) === normalizeText(b.windowTitle);
}

/** Side effects: captures/updates current target, capture state, look, and parsed outline. */
async function performObserve(
	params: ObserveParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails | BrowserObservationDetails>> {
	const requestedRoot = params.root;
	// Direct callers can bypass the schema; a non-string root must not silently fall back to the frontmost window.
	if (typeof requestedRoot !== "string" && requestedRoot !== undefined)
		throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	if (requestedRoot && !/^@r\d+$/.test(requestedRoot))
		throw new Error("observe_ui.root must be an exact @r ref issued by find_roots.");
	const browserContextId = requestedRoot ? runtimeState.browserContextByRoot.get(requestedRoot) : undefined;
	if (isBrowserContextId(browserContextId)) {
		const targetId = browserContextId.slice(BROWSER_CONTEXT_PREFIX.length);
		const resourceKey = `cdp:${targetId}`;
		const scheduled = await resourceScheduler.read(
			resourceKey,
			async () => await cdpSnapshotForContext(browserContextId),
		);
		const browser = scheduled.value;
		if (!browser)
			throw new Error(`Browser context '${browserContextId}' is no longer available. Call find_roots again.`);
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
		return await captureCurrentTarget(
			signal,
			readText,
			imageMode === "always" ? EXPLICIT_IMAGE_MAX_DIMENSION : AUTO_IMAGE_MAX_DIMENSION,
			requestedTarget,
			imageMode !== "never",
		);
	});
	const captureResult = scheduled.value;
	// Model @r refs are re-minted on re-resolution, so ref string equality
	// alone false-positives as drift for the same root; compare stable
	// identity against the resolved request too.
	if (
		!matchesObserveSelection(captureResult.target, selection) &&
		!sameRootIdentity(captureResult.target, requestedTarget)
	) {
		throw new Error(
			`Observation target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call observe_ui again or specify a more exact window title.`,
		);
	}
	const summary = `Observed ${mode} ${captureResult.target.windowRef} ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest outline state.`;
	return await buildToolResult(
		"observe_ui",
		summary,
		captureResult,
		executionTrace("look", "stealth"),
		signal,
		imageMode,
		undefined,
		params.detail,
	);
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

const SEARCH_UI_LIMIT = 12;

function searchUiFilters(params: SearchUiParams) {
	return {
		text: trimOrUndefined(params.text),
		role: trimOrUndefined(params.role),
		capability: trimOrUndefined(params.capability),
	};
}

function canEscalateSearchOCR(): boolean {
	const { contextId, currentLook } = operationState();
	return Boolean(
		!isBrowserContextId(contextId) &&
			currentLook &&
			currentLook.readText?.requested !== "never" &&
			!currentLook.readText?.executed,
	);
}

function shouldEscalateSearchOCR(matches: OutlineSearchMatch[]): boolean {
	return canEscalateSearchOCR() && matches.every(matchIsNonActionableStatic);
}

/** Pure outline query unless a window selector is supplied, in which case current target selection may change. */
async function performSearchUi(
	params: SearchUiParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	let outline = currentOutlineOrThrow();
	const { text, role, capability } = searchUiFilters(params);
	if (!text && !role && !capability)
		throw new Error("search_ui requires text, role, or capability. Use observe_ui for a bounded overview.");
	let ranked = searchOutlineRanked(outline, text, role, capability, SEARCH_UI_LIMIT);
	let matches = ranked.matches;
	let escalatedOCR = false;
	if (shouldEscalateSearchOCR(matches)) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		// captureCurrentTarget adopts the new look/outline/capture into
		// runtimeState, so refs in these matches stay actable. Keep the image
		// payload: OCR-only matches are clicked by coordinate, and coordinate
		// acts require the current look to be image-bearing.
		const captureResult = (
			await resourceScheduler.readAt(
				state.resourceKey!,
				state.epoch!,
				async () => await captureCurrentTarget(signal, "always", AUTO_IMAGE_MAX_DIMENSION, currentTarget),
			)
		).value;
		outline = captureResult.outline;
		ranked = searchOutlineRanked(outline, text, role, capability, SEARCH_UI_LIMIT);
		matches = ranked.matches;
		escalatedOCR = true;
	}
	const detailMatches = matches.map(serializeOutlineSearchMatch);
	// A cached query rechecks the note: a graft or a restored session note may name a node no longer readable.
	const note = noteForOutline(state.currentNote, outline);
	// Browser snapshots are not partial reads; expand_ui cannot re-read them.
	const unreadRefs =
		ranked.totalMatches === 0 && !isBrowserContextId(state.contextId)
			? outline.nodes.filter((node) => node.truncated).map((node) => node.ref)
			: [];
	const inconclusive = unreadRefs.length > 0;
	const details: OutlineToolDetails = {
		tool: "search_ui",
		stateId: state.currentCapture?.stateId,
		lookId: outline.lookId,
		matches: detailMatches,
		totalMatches: ranked.totalMatches,
		returned: matches.length,
		hasMore: ranked.totalMatches > matches.length,
		note,
		...(inconclusive ? { inconclusive: true as const, unreadRefs } : {}),
	};
	const collides = (match: OutlineSearchMatch) =>
		matches.some((other) => other !== match && other.role === match.role && other.label === match.label);
	const lines = matches.map(
		(match) =>
			`${controlLine(match.node)} [${match.matchReason}${match.matchReason === "fuzzy" ? ` ${match.score!.toFixed(2)}` : ""}]${collides(match) ? `\n  path: ${match.path}` : ""}`,
	);
	const noteHeader = renderNote(note);
	const noteText = noteHeader ? `${noteHeader}\n\n` : "";
	const escalationText = escalatedOCR
		? " OCR text was escalated for this search after the cached outline had no matches."
		: "";
	const moreText =
		ranked.totalMatches > matches.length
			? ` Refine the query to inspect ${ranked.totalMatches - matches.length} additional matches.`
			: "";
	const unreadList = `${unreadRefs.slice(0, 5).join(", ")}${unreadRefs.length > 5 ? ", ..." : ""}`;
	// An incomplete read never leads with a zero count: the count only covers what could be read.
	const lead = inconclusive
		? `Inconclusive: no matches in the part of the outline that could be read; ${unreadRefs.length} node${unreadRefs.length === 1 ? "" : "s"} unread (${unreadList}). expand_ui an unread ref before concluding the element is absent.`
		: `Found ${ranked.totalMatches} outline match${ranked.totalMatches === 1 ? "" : "es"}; returned ${matches.length}.${moreText}`;
	return {
		content: [
			{
				type: "text",
				text: `${noteText}${lead}${escalationText}\n${lines.join("\n")}`,
			},
		],
		details,
	};
}

function needsScopedLook(outline: Outline, target: OutlineNode): boolean {
	const state = operationState();
	if (isBrowserContextId(state.contextId)) return false;
	const regionKey = noteRegionKeyForRef(outline, target.ref);
	return (
		target.truncated ||
		Boolean(
			regionKey && state.currentNote?.regions.some((region) => region.key === regionKey && region.status === "changed"),
		)
	);
}

/** Reads cached outline; truncated refs trigger a scoped look. */
async function performExpandUi(
	params: ExpandUiParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	const outline = currentOutlineOrThrow();
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("expand_ui.ref is required.");
	const initialTarget = nodeByRef(outline, ref);
	if (!initialTarget) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	let target: OutlineNode = initialTarget;
	const depth = Math.max(1, Math.min(8, Math.trunc(toFiniteNumber(params.depth, 3))));
	if (needsScopedLook(outline, target)) {
		const currentTarget = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
		const targetWireRef = wireRefForNode(target);
		const scoped = (
			await resourceScheduler.readAt(
				state.resourceKey!,
				state.epoch!,
				async () =>
					await performLook(
						currentTarget,
						{
							readText: "auto",
							baseLookId: outline.lookId,
							scopeRef: targetWireRef,
							maxDimension: 1,
							includeImage: false,
						},
						signal,
					),
			)
		).value;
		target = graftScopedOutline(outline, target.ref, scoped.parsedOutline!);
		outline.lookId = scoped.lookId;
		state.currentOutline = outline;
		state.currentLook = { ...scoped, image: state.currentLook?.image, outline: outline.root, parsedOutline: outline };
		persistOperation(state);
	}
	const folded = foldToBudget(outline, { maxDepth: depth, maxNodes: 150 }, [target.ref]);
	const details: OutlineToolDetails = {
		tool: "expand_ui",
		stateId: state.currentCapture?.stateId,
		lookId: outline.lookId,
		target: serializeOutlineNodeShallow(target),
		renderedOutline: folded.text,
		note: noteForOutline(state.currentNote, outline),
	};
	return {
		content: [
			{ type: "text", text: `${formatOutlineNodeLabel(target)}\npath: ${outlineNodePath(target)}\n\n${folded.text}` },
		],
		details,
	};
}

/** Pure cached-outline inspection. */
async function performInspectUi(params: InspectUiParams): Promise<AgentToolResult<OutlineToolDetails>> {
	const state = operationState();
	const outline = currentOutlineOrThrow();
	const ref = trimOrUndefined(params.ref);
	if (!ref) throw new Error("inspect_ui.ref is required.");
	const target = nodeByRef(outline, ref);
	if (!target) throw new Error(`Outline ref '${ref}' is not available in the current outline.`);
	const details: OutlineToolDetails = {
		tool: "inspect_ui",
		stateId: state.currentCapture?.stateId,
		lookId: outline.lookId,
		target: serializeOutlineNodeShallow(target),
		note: noteForOutline(state.currentNote, outline),
	};
	const fields = [
		formatOutlineNodeLabel(target),
		`path: ${outlineNodePath(target)}`,
		`rect: ${JSON.stringify(target.rect)}`,
		`actions: ${target.actions.join(",") || "none"}`,
		`capabilities: ${
			[
				target.canPress ? "press" : undefined,
				target.canFocus ? "focus" : undefined,
				target.canSetValue ? "setValue" : undefined,
				target.canScroll ? "scroll" : undefined,
				target.canIncrement ? "increment" : undefined,
				target.canDecrement ? "decrement" : undefined,
				target.isTextInput ? "textInput" : undefined,
			]
				.filter(Boolean)
				.join(",") || "none"
		}`,
		`annotations: ${
			[
				target.offscreen ? "offscreen" : undefined,
				target.pictureOnly ? "pictureOnly" : undefined,
				target.truncated ? "truncated" : undefined,
				target.scrollExtent ? `scrollable ${target.scrollExtent.seen}/${target.scrollExtent.total}` : undefined,
			]
				.filter(Boolean)
				.join(",") || "none"
		}`,
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

async function dispatchUiAction(
	action: UiAction,
	target: ResolvedTarget,
	look: LookResponse,
	headless: boolean,
	state: ActionState,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
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

async function dispatchUiTransaction(
	actions: UiAction[],
	target: ResolvedTarget,
	look: LookResponse,
	headless: boolean,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	// Strict-headless batches have one immutable delivery class. When foreground
	// fallback is permitted, decide independently per action so a completed
	// background prefix is never replayed as part of a foreground batch.
	if (headless && currentPlatformBackend.actBatch) {
		const actionState: ActionState = { currentFocus: false };
		const requests = actions.map((action) =>
			helperActRequest(target, prepareUiAction(action, actionState, look, true), "ax_only"),
		);
		const textLength = actions.reduce((sum, action) => sum + (action.text?.length ?? 0), 0);
		let result: Awaited<ReturnType<NonNullable<typeof currentPlatformBackend.actBatch>>>;
		try {
			result = await currentPlatformBackend.actBatch(requests, {
				signal,
				timeoutMs: Math.max(COMMAND_TIMEOUT_MS, textLength * 25 + 6_000),
			});
		} catch (error) {
			// Any step may have run, so no step index is known: the whole batch is unknown.
			if (!isReplyLost(error)) throw error;
			return { ...aggregateExecutions([]), outcome: "unknown", ...replyLostStop(error) };
		}
		if (!result.steps || result.steps.length === 0)
			throw new Error("Native action transaction returned no checked steps.");
		const execution = aggregateExecutions(result.steps.map((step) => executionTraceFromAct(step, "ax_only")));
		const batchTrace = executionTraceFromAct(result, "ax_only");
		execution.outcome = result.outcome;
		execution.performed = result.performed;
		execution.rootDelta = batchTrace.rootDelta;
		execution.stoppedAt = result.stoppedAt;
		// Native helpers can report the failure on the last checked step rather than the batch.
		const failure = result.error ? result : result.steps.at(-1);
		execution.error = failure?.error;
		execution.evidence = failure?.evidence;
		return execution;
	}
	const steps: ExecutionTrace[] = [];
	const actionState: ActionState = { currentFocus: false };
	for (const action of actions) {
		try {
			const step = await dispatchUiAction(action, target, look, headless, actionState, signal);
			steps.push(step);
			// A later action would run on an unknown state and its outcome would mask the indeterminate delivery.
			if (isIndeterminateStep(step)) return stoppedTransaction(steps);
			// The stop index is recorded whether or not the refusal carries an error.
			if (step.outcome === "didnt") return { ...aggregateExecutions(steps), stoppedAt: steps.length - 1 };
			// A helper that stopped after posting part of the action reports the count; never run the next action.
			if (step.error && typeof step.evidence?.deliveredUnits === "number") return stoppedTransaction(steps);
		} catch (error) {
			const failure = error as (Error & { code?: string; evidence?: Record<string, unknown> }) | undefined;
			// The request reached the helper but its reply was lost: the action may have run, in part or in full.
			if (isReplyLost(failure)) {
				const step = executionTraceFromAct({ outcome: "unknown", ...replyLostStop(failure) }, "foreground");
				steps.push(step);
				return stoppedTransaction(steps);
			}
			// A refusal thrown after an earlier step ran, e.g. sticky `input_unsafe` or a helper shutting down,
			// keeps that checked prefix and its stop index: the transaction is `unknown`, never a bare error.
			if (!isStopRefusal(failure)) throw error;
			if (!failure.evidence && steps.length === 0) throw error;
			steps.push(
				executionTraceFromAct(
					{ outcome: "didnt", error: { code: failure.code, message: failure.message }, evidence: failure.evidence },
					"foreground",
				),
			);
			return stoppedTransaction(steps);
		}
	}
	return aggregateExecutions(steps);
}

/** Refusals a per-action dispatch records as a `didnt` stop instead of throwing, once a step ran or with evidence. */
const STOP_REFUSAL_CODES = new Set(["app_blocked", "input_deadline_expired", "input_unsafe", "cancelled"]);

function isStopRefusal(error: unknown): error is Error & { code: string; evidence?: Record<string, unknown> } {
	return STOP_REFUSAL_CODES.has((error as { code?: string } | undefined)?.code ?? "");
}

function isReplyLost(error: unknown): error is Error & { code: "reply_lost" } {
	return (error as { code?: string } | undefined)?.code === "reply_lost";
}

/** The error and evidence of a stop whose request reached the helper but whose reply was lost. */
function replyLostStop(error: Error & { code: "reply_lost" }): Pick<ExecutionTrace, "error" | "evidence"> {
	return { error: { code: error.code, message: error.message }, evidence: { deliveryUncertain: true } };
}

/** The serial transaction stopped at its last step: carry that step's error and its index. */
function stoppedTransaction(steps: ExecutionTrace[]): ExecutionTrace {
	const step = steps.at(-1)!;
	return { ...aggregateExecutions(steps), error: step.error, evidence: step.evidence, stoppedAt: steps.length - 1 };
}

/**
 * Why a step's delivery is explicitly indeterminate, or undefined: a timeout, an AX press that may have landed
 * (`ax_delivery_unknown`), or posted input the helper flagged `evidence.deliveryUnknown`. A generic `unknown` is not.
 */
function indeterminateReason(step: ExecutionTrace): string | undefined {
	if (step.outcome !== "unknown") return undefined;
	if (step.error?.code === "timeout") return "timed out";
	if (step.error?.code === "ax_delivery_unknown") return "failed with an AX error after the press may have landed";
	return step.evidence?.deliveryUnknown === true ? "posted input that its readback did not confirm" : undefined;
}

function isIndeterminateStep(step: ExecutionTrace): boolean {
	return indeterminateReason(step) !== undefined;
}

/**
 * A transaction is `didnt` only when its first step stopped as `didnt`: any step before a stop ran and
 * may have delivered input, so a later refusal leaves it `unknown`, never `didnt`.
 */
function aggregateExecutions(steps: ExecutionTrace[]): ExecutionTrace {
	const outcomes = steps.map((step) => step.outcome);
	const stop = outcomes.indexOf("didnt");
	const outcome: ActOutcome = stop === 0 ? "didnt" : stop > 0 || outcomes.includes("unknown") ? "unknown" : "worked";
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
	const nativeRefMatches = Boolean(
		target.nativeWindowRef && (root.rootRef === target.nativeWindowRef || root.windowRef === target.nativeWindowRef),
	);
	// Windows: only the instance's native ref identifies it; a same-HWND replacement must not pass.
	if (currentPlatformBackend.name === "windows") return nativeRefMatches;
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
export async function normalizeRootDeltaRefs(
	execution: ExecutionTrace,
	target: Pick<ResolvedTarget, "pid" | "appName" | "appId" | "bundleId">,
): Promise<void> {
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
			if (!rootsByPid.has(delta.pid))
				rootsByPid.set(delta.pid, await currentPlatformBackend.listRoots({ pid: delta.pid }).catch(() => []));
			const root = rootsByPid
				.get(delta.pid)!
				.find((candidate) => candidate.rootRef === delta.ref || candidate.windowRef === delta.ref);
			if (root) {
				const sameApp = delta.pid === target.pid;
				const app: HelperApp = {
					appName: sameApp ? target.appName : (root.appName ?? "Unknown App"),
					appId: sameApp ? target.appId : root.appId,
					bundleId: sameApp ? target.bundleId : root.bundleId,
					pid: delta.pid,
				};
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
		const modal = roots
			.filter((root) => shouldPreferForegroundModalWindow(current, root))
			.sort((a, b) => scoreWindow(b) - scoreWindow(a))[0];
		return modal
			? `Note: ${modal.kind} ${JSON.stringify(modal.title || "(untitled)")} is now a foreground modal in front of this root. Call find_roots, then observe_ui it.`
			: undefined;
	} catch {
		return undefined;
	}
}

/** A helper's `gone` verdict awaiting corroboration, kept with the delivery outcome it falls back to. */
interface ProvisionalAbsence {
	/** The transaction's outcome before the check: an unproven absence settles back to it. */
	fallback: ActOutcome;
}

/**
 * Settle an `absent` check the evidence could not prove: `inconclusive`, keeping the delivery outcome from before
 * the check. The message claims delivery only when that outcome says it worked.
 */
function settleUnprovenAbsence(execution: ExecutionTrace, fallback: ActOutcome, reason: string): void {
	execution.verification!.status = "inconclusive";
	execution.outcome = settledOutcome(execution, fallback);
	const lead = execution.outcome === "worked" ? "The action was delivered, but its" : "The";
	execution.error = {
		code: "postcondition_inconclusive",
		message: `${lead} absent postcondition is not proven: ${reason}.`,
	};
}

export async function terminalDesktopActionResult(
	target: ResolvedTarget,
	baseStateId: string,
	execution: ExecutionTrace,
	error: unknown,
	condition?: ReturnType<typeof validateCondition>,
	provisional?: ProvisionalAbsence,
): Promise<AgentToolResult<TerminalDesktopActionDetails>> {
	await normalizeRootDeltaRefs(execution, target);
	const unknownIndex = indeterminateStepIndex(execution);
	let exactRootAvailable: boolean | undefined;
	let liveRoots: PlatformRoot[] = [];
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			// Only a complete listing proves the root closed; a partial one fails the probe.
			const roots = await currentPlatformBackend.listRoots({ pid: target.pid, authoritative: true });
			liveRoots = roots;
			exactRootAvailable = roots.some((root) => exactPlatformRootMatchesTarget(root, target));
			if (exactRootAvailable) break;
			if (attempt < 2) await sleep(75);
		}
	} catch {
		// A failed identity probe cannot prove that the root closed, even after an earlier empty listing.
		exactRootAvailable = undefined;
	}
	const targetClosed = exactRootAvailable === false;
	if (
		targetClosed &&
		!(execution.rootDelta ?? []).some(
			(delta) =>
				delta.change === "closed" &&
				delta.pid === target.pid &&
				(delta.ref === target.windowRef || delta.ref === target.nativeWindowRef),
		)
	) {
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
	const staleWaitRoot =
		currentPlatformBackend.name === "windows" && (error as { code?: string } | undefined)?.code === "root_stale";
	if (targetClosed && condition && !staleWaitRoot) {
		const verificationStatus = condition.gone ? "verified" : "failed";
		execution.verification = {
			status: verificationStatus,
			text: condition.text,
			role: condition.role,
			value: condition.value,
			gone: condition.gone || undefined,
			timeoutMs: condition.timeoutMs,
		};
		// A transaction that already stopped, an indeterminate step included, keeps its outcome and original error;
		// the check is recorded beside it.
		const stopped = execution.error !== undefined || execution.stoppedAt !== undefined || unknownIndex >= 0;
		if (!stopped)
			execution.outcome = settledOutcome(
				execution,
				outcomeAfterCheck(execution.outcome ?? "unknown", verificationStatus),
			);
		if (!stopped && verificationStatus === "failed") {
			execution.error = {
				code: "postcondition_failed",
				message: "The source root closed before the requested presence or value postcondition could be verified.",
			};
		} else if (execution.error?.code === "postcondition_inconclusive") {
			// The proven closure settles an absence the helper could not confirm.
			execution.error = undefined;
		}
	}
	// Without a successor observation or a proven closure, the helper's absence stays uncorroborated.
	if (provisional && !targetClosed)
		settleUnprovenAbsence(execution, provisional.fallback, "no successor observation could be captured");
	const successors = targetClosed
		? execution
				.rootDelta!.filter(
					(delta) =>
						delta.change === "appeared" &&
						delta.pid === target.pid &&
						REPLACEMENT_ROOT_KINDS.has(delta.kind) &&
						Boolean(delta.ref) &&
						liveRoots.some(
							(root) =>
								root.pid === target.pid &&
								extensionRefForNative(target.pid, root.rootRef ?? root.windowRef ?? "") === delta.ref,
						),
				)
				.map((delta) => ({ ref: delta.ref, kind: delta.kind, title: delta.title, isModal: delta.isModal }))
		: [];
	const status = targetClosed ? "target_closed" : "post_action_observation_failed";
	const rawMessage = error instanceof Error ? error.message : String(error);
	// The probe saw the root listed, yet the helper cannot resolve it: the ref expired. A failed probe proves nothing.
	const rootExpired =
		exactRootAvailable === true && (error as { code?: string } | undefined)?.code === "root_not_found";
	const code =
		staleWaitRoot || rootExpired ? "root_stale" : targetClosed ? "target_closed" : "post_action_observation_failed";
	const message = rootExpired
		? `Root expired or was never valid for observation (${rawMessage}). Rediscover with find_roots.`
		: rawMessage;
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
		...(targetClosed ? { cause: successors.length > 0 ? ("replaced" as const) : ("closed" as const), successors } : {}),
	};
	const successorText =
		successors.length > 0
			? ` It was replaced by ${successors.map((item) => `${item.kind} ${JSON.stringify(item.title ?? "")}${item.isModal ? " (modal)" : ""}`).join(", ")}.`
			: "";
	const root = `${target.appName} — ${target.windowTitle}`;
	const rootFate = targetClosed
		? `closed before a successor observation could be captured.${successorText}`
		: `could not be observed afterward: ${message}`;
	// The text follows the settled outcome: an unknown delivery is never claimed, and never invites a replay.
	// An indeterminate step names itself; any other unknown outcome, e.g. an unproven absence, says so generically.
	const deliveryUnknown = unknownIndex >= 0 || execution.outcome === "unknown";
	const unknownLead =
		unknownIndex >= 0
			? `${indeterminateSentence(execution, unknownIndex)} Its`
			: "Delivery of the action is unknown, and its";
	const result = deliveryUnknown
		? `${unknownLead} source root ${root} ${rootFate}`
		: `The action was delivered, ${targetClosed ? "and" : "but"} its source root ${root} ${rootFate}`;
	const next = deliveryUnknown
		? `Do not replay the transaction: call find_roots, then observe_ui to check whether ${unknownIndex >= 0 ? `action ${unknownIndex + 1}` : "it"} took effect.`
		: "Call find_roots, then observe_ui to continue.";
	return {
		content: [
			{
				type: "text",
				text: `${keyboardStopSummary(execution) ?? result}\nNo successor state was created. ${next}`,
			},
		],
		details,
	};
}

function keyboardStopSummary(execution: ExecutionTrace): string | undefined {
	const code = execution.error?.code;
	const delivered = execution.evidence?.deliveredUnits;
	const uncertain = execution.evidence?.deliveryUncertain === true;
	const partial = code !== undefined && (typeof delivered === "number" || uncertain);
	if (code !== "app_blocked" && code !== "input_deadline_expired" && !partial) return undefined;
	const units = execution.evidence?.postedUnits;
	const posted =
		typeof units === "number"
			? ` ${units} key ${units === 1 ? "pair" : "pairs"} posted.`
			: typeof delivered === "number"
				? ` ${delivered} input ${delivered === 1 ? "event" : "events"} posted.`
				: "";
	const unknown = uncertain ? " More input may have been delivered." : "";
	const held = execution.evidence?.unconfirmedReleases;
	const stuck = Array.isArray(held) && held.length > 0 ? ` Release of ${held.join(", ")} is unconfirmed.` : "";
	const atAction = execution.stoppedAt === undefined ? "" : ` at action ${execution.stoppedAt + 1}`;
	return `Stopped${atAction} (${code}).${posted}${unknown}${stuck} Do not replay the transaction.`;
}

/** Index of the step whose delivery is indeterminate, or -1: it stays unknown whatever is observed afterward. */
function indeterminateStepIndex(execution: ExecutionTrace): number {
	return (execution.steps ?? []).findIndex(isIndeterminateStep);
}

/** Later evidence settles an act's outcome, except after an indeterminate step: postconditions and values cannot prove delivery. */
function settledOutcome(execution: ExecutionTrace, settled: ActOutcome): ActOutcome {
	return indeterminateStepIndex(execution) < 0 ? settled : execution.outcome!;
}

/** The numbered indeterminate-delivery sentence plus the completed prefix, shared by successor and terminal results. */
function indeterminateSentence(execution: ExecutionTrace, index: number): string {
	const prefix = index === 0 ? "" : index === 1 ? " Action 1 completed." : ` Actions 1-${index} completed.`;
	return `Action ${index + 1} ${indeterminateReason(execution.steps![index]!)}; whether it was delivered is unknown.${prefix}`;
}

function indeterminateSummary(execution: ExecutionTrace, stateId: string): string | undefined {
	const index = indeterminateStepIndex(execution);
	return index < 0
		? undefined
		: `${indeterminateSentence(execution, index)} Do not replay the transaction: check state ${stateId} for whether action ${index + 1} took effect before retrying it.`;
}

async function performDesktopTransaction(
	params: ActParams,
	actions: UiAction[],
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails>> {
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
	return await withWindowWriteLock(target, () =>
		withDesktopTransaction(async () => {
			const execution = await dispatchUiTransaction(actions, target, look, headless, signal);
			await normalizeRootDeltaRefs(execution, target);
			// Both dispatch paths aggregate their steps, which records how many ran.
			const executedActions = actions.slice(0, execution.actionCount!);
			// The helper's `gone`, pending corroboration by the successor observation or a proven closure.
			let provisional: ProvisionalAbsence | undefined;
			// Any stop, even an errorless first-step `didnt`, or an error: neither `expect` nor observed values upgrade it.
			const partial = execution.error !== undefined || execution.stoppedAt !== undefined;
			try {
				// An indeterminate step skips the postcondition: a passing or stale check cannot settle its delivery.
				if (condition && !partial && indeterminateStepIndex(execution) < 0) {
					const {
						text: expectedText,
						role: expectedRole,
						value: expectedValue,
						scopeExact,
						gone,
						timeoutMs,
					} = condition;
					const beforePresent = outlineConditionPresent(look.parsedOutline!, condition);
					const desiredWasPreexisting = beforePresent !== gone;
					const verification = await currentPlatformBackend.waitFor(
						{
							...nativeWindowRequest(target),
							lookId: look.parsedOutline!.lookId,
							text: expectedText,
							role: platformRole(look.parsedOutline!, expectedRole),
							value: expectedValue,
							scopeRef: scopeNode ? wireRefForNode(scopeNode) : undefined,
							scopeExact,
							gone,
							timeoutMs,
						},
						{ signal, timeoutMs: timeoutMs + 2_000 },
					);
					const before = execution.outcome ?? "unknown";
					const status = verification.found ? (desiredWasPreexisting ? "preexisting" : "verified") : "failed";
					execution.verification = {
						status,
						text: expectedText,
						role: expectedRole,
						value: expectedValue,
						gone: gone || undefined,
						timeoutMs,
					};
					if (gone && !verification.found && verification.incomplete) {
						settleUnprovenAbsence(
							execution,
							before,
							`the accessibility tree could not be read completely within ${timeoutMs}ms`,
						);
					} else {
						execution.outcome = settledOutcome(execution, outcomeAfterCheck(before, status));
						if (gone && verification.found) provisional = { fallback: before };
						if (!verification.found)
							execution.error = {
								code: "postcondition_failed",
								message: `The action was delivered but its postcondition was not satisfied within ${timeoutMs}ms.`,
							};
					}
				} else {
					await sleep(settleMsForExecution(execution), signal);
				}
				// An unpaired root (no CG window) cannot be captured; observe it semantically instead of failing the successor.
				const capture = await captureCurrentTarget(
					signal,
					"auto",
					AUTO_IMAGE_MAX_DIMENSION,
					target,
					target.windowId > 0,
				);
				if (provisional) {
					const unproven = absenceUnproven(capture.outline, condition!);
					if (unproven) settleUnprovenAbsence(execution, provisional.fallback, absenceUnprovenMessage(unproven));
					provisional = undefined;
				}
				// A stopped transaction may have delivered more than its values show, e.g. a held key: it stays unknown.
				// An indeterminate step is always a stop; `settledOutcome` keeps it unknown should one ever arrive unstopped.
				// An explicit delivery error also blocks the observed-value upgrade.
				if (!partial)
					execution.outcome = settledOutcome(
						execution,
						outcomeAfterObservedValues(
							execution.outcome ?? "unknown",
							executedActions,
							(ref) => nodeByRef(capture.outline, ref)?.value,
							execution.error,
						),
					);
				const unknownIndex = indeterminateStepIndex(execution);
				for (const [index, action] of executedActions.entries()) {
					state.currentNote = noteAfterAct(state.currentNote, action.ref, capture.outline, {
						window: noteWindowForTarget(capture.target, capture.look),
						rootDelta: execution.rootDelta,
						// The saved note carries the indeterminate delivery to every later call on this state.
						unknownDelivery:
							index === unknownIndex
								? `action ${index + 1} ${indeterminateReason(execution.steps![index]!)}`
								: undefined,
					});
				}
				const built = await buildToolResult(
					"act_ui",
					keyboardStopSummary(execution) ??
						indeterminateSummary(execution, capture.capture.stateId) ??
						`Executed ${executedActions.length} checked UI action${executedActions.length === 1 ? "" : "s"} in ${target.appName} — ${target.windowTitle}. Returned state ${capture.capture.stateId}.`,
					capture,
					execution,
					signal,
					state.currentImageMode,
					baseView,
				);
				const modalNote = await foregroundModalNote(target);
				const first = built.content[0];
				if (modalNote && first?.type === "text") first.text = `${first.text}\n${modalNote}`;
				return built;
			} catch (error) {
				if (signal?.aborted) {
					clearDesktopOperationState(state);
					// The abort ends only the follow-up observation: a stopped transaction keeps its unknown outcome.
					const code = execution.error?.code;
					const stop = keyboardStopSummary(execution);
					if (code && stop)
						throw Object.assign(new ComputerUseError(code, `${stop} The follow-up observation was aborted.`), {
							execution,
							cause: error,
						});
					throw error;
				}
				return await terminalDesktopActionResult(target, baseView.stateId, execution, error, condition, provisional);
			}
		}, signal),
	);
}

function assertBrowserTransactionAction(action: UiAction): void {
	if (!BROWSER_TRANSACTION_ACTIONS.has(action.action))
		throw new ComputerUseError("unsupported_command", `Browser transactions do not support '${action.action}'.`);
}

async function performBrowserTransaction(
	params: ActParams,
	actions: UiAction[],
	signal?: AbortSignal,
): Promise<AgentToolResult<BrowserObservationDetails>> {
	// `performAct` routes here only for a hydrated browser state, which carries both.
	const contextId = browserContextForOperation()!;
	const baseSnapshot = operationState().browserSnapshot!;
	const baseView = { stateId: baseSnapshot.snapshotId, outline: baseSnapshot.outline };
	const condition = params.expect ? validateCondition(params.expect) : undefined;
	if (condition) conditionScopeNode(restoreOutline(baseSnapshot.outline), condition);
	const prepared = actions.map((action) => {
		assertBrowserTransactionAction(action);
		// Same rule and message as the desktop `keys()` preparation; an empty chord would "work" without sending anything.
		if (action.action === "keypress" && (!Array.isArray(action.keys) || action.keys.length === 0))
			throw new ComputerUseError("invalid_args", "keypress.keys must contain at least one key.");
		// Browser snapshots carry node identities, not desktop-style target points. Never send absent coordinates to CDP.
		if (action.action === "moveMouse" && action.ref)
			throw new ComputerUseError(
				"invalid_args",
				"Browser moveMouse requires x/y coordinates; ref targets are not supported.",
			);
		if (action.action === "click" && action.ref && action.button && action.button !== "left")
			throw new Error(
				"Browser ref clicks support only the left button; use coordinate clicks for right or middle buttons.",
			);
		const ref = trimOrUndefined(action.ref);
		const target = ref ? baseSnapshot.targets.find((candidate) => candidate.ref === ref) : undefined;
		if (
			(action.action === "press" ||
				action.action === "setText" ||
				(action.action === "click" && action.ref) ||
				(action.action === "typeText" && action.ref)) &&
			!Number.isFinite(target?.backendNodeId)
		) {
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
				for (let count = 0; count < (action.clickCount ?? 1); count += 1)
					worked = (await cdpClickForContext(contextId, target!.backendNodeId!)) && worked;
			} else if (action.action === "click") {
				worked =
					(await cdpMouseForContext(
						contextId,
						action.x!,
						action.y!,
						"mousePressed",
						action.button ?? "left",
						action.clickCount ?? 1,
					)) &&
					(await cdpMouseForContext(
						contextId,
						action.x!,
						action.y!,
						"mouseReleased",
						action.button ?? "left",
						action.clickCount ?? 1,
					));
			} else if (action.action === "setText")
				worked = await cdpTypeForContext(contextId, target!.backendNodeId!, action.text ?? "", true);
			else if (action.action === "typeText")
				worked = target?.backendNodeId
					? await cdpTypeForContext(contextId, target.backendNodeId, action.text ?? "", false)
					: await cdpTypeFocusedForContext(contextId, action.text ?? "");
			else if (action.action === "keypress") worked = await cdpKeypressForContext(contextId, action.keys!);
			else if (action.action === "scroll")
				worked = await cdpScrollForContext(
					contextId,
					toFiniteNumber(action.scrollX, 0),
					toFiniteNumber(action.scrollY, 0),
					target?.backendNodeId,
				);
			else if (action.action === "drag") worked = await cdpDragForContext(contextId, normalizeActionPath(action.path));
			else worked = await cdpMouseForContext(contextId, action.x!, action.y!, "mouseMoved"); // `moveMouse`, the only action left
			if (!worked)
				throw new Error("The browser root became unavailable during the action transaction. Observe it again.");
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
			if (!satisfied)
				throw new Error(
					`The browser action was delivered but its postcondition was not satisfied within ${condition.timeoutMs}ms.`,
				);
		}
		return await refreshBrowserSnapshot(contextId, "act_ui", baseView);
	});
}

function normalizeActionPath(path: UiAction["path"]): Array<{ x: number; y: number }> {
	return (path ?? []).map((point) =>
		Array.isArray(point)
			? { x: toFiniteNumber(point[0], 0), y: toFiniteNumber(point[1], 0) }
			: { x: toFiniteNumber(point.x, 0), y: toFiniteNumber(point.y, 0) },
	);
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
	if (action.action === "scroll" && toFiniteNumber(action.scrollX, 0) === 0 && toFiniteNumber(action.scrollY, 0) === 0)
		throw new Error("scroll requires a non-zero scrollX or scrollY delta.");
	if (
		action.clickCount !== undefined &&
		(!Number.isInteger(action.clickCount) || action.clickCount < 1 || action.clickCount > 3)
	)
		throw new Error("clickCount must be an integer from 1 to 3.");
}

async function performAct(
	params: ActParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails>> {
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

	const platformCandidates =
		process.platform === "darwin"
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
							process.env.LOCALAPPDATA &&
								path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
							process.env.PROGRAMFILES &&
								path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
							process.env["PROGRAMFILES(X86)"] &&
								path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
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
	const pathNames =
		browser === "helium"
			? process.platform === "win32"
				? ["helium.exe"]
				: ["helium", "helium-browser"]
			: process.platform === "win32"
				? ["chrome.exe"]
				: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.flatMap((directory) => pathNames.map((name) => path.join(directory, name)));
	return [
		...new Set([
			...platformCandidates.filter((candidate): candidate is string => Boolean(candidate)),
			...pathCandidates,
		]),
	];
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

/** Identity retained across asynchronous launch stages; a path string alone cannot establish ownership. */
interface ValidatedPersistentProfile {
	directory: string;
	dev: number;
	ino: number;
}

/** Only this exact empty Pi lease may be released, inside the original validated profile. */
interface PersistentProfileLease {
	profile: ValidatedPersistentProfile;
	dev: number;
	ino: number;
}

/** Tracked profile ownership. Hard exit kills browsers, deletes temporary data and leaves persistent leases fail-closed. */
const liveProfileDirs = new Map<string, { browser: ChildProcess; persistent?: PersistentProfileLease }>();
const profileCleanup = new Map<string, Promise<void>>();
let profileExitHookInstalled = false;

/**
 * Track a managed browser's profile dir until it is removed, installing the exit hook once.
 * @param profileDir Private profile dir passed to the browser as `--user-data-dir`.
 * @param browser The browser process that owns `profileDir`.
 */
function trackProfileDir(profileDir: string, browser: ChildProcess, persistent?: PersistentProfileLease): void {
	liveProfileDirs.set(profileDir, { browser, persistent });
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
	const previous = profileCleanup.get(profileDir);
	if (previous) return await previous;
	const current = removeProfileDirOnce(profileDir);
	profileCleanup.set(profileDir, current);
	try {
		await current;
	} finally {
		profileCleanup.delete(profileDir);
	}
}

/** Remove one temporary profile; concurrent close and shutdown callers share this attempt. */
async function removeProfileDirOnce(profileDir: string): Promise<void> {
	const owner = liveProfileDirs.get(profileDir);
	if (owner?.persistent) {
		// Only called once the browser has closed. Never remove browser-owned lock files.
		if (releasePersistentProfileLease(owner.persistent)) liveProfileDirs.delete(profileDir);
		return;
	}
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
	for (const [profileDir, { browser, persistent }] of liveProfileDirs) {
		if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
		if (persistent) continue;
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
	for (const [profileDir, owner] of liveProfileDirs) if (owner.browser === browser) return profileDir;
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
		debugLog(
			"managed browser %d ignored SIGTERM for %dms, sending SIGKILL",
			browser.pid,
			MANAGED_BROWSER_EXIT_TIMEOUT_MS,
		);
		const killed = waitForClose(browser, MANAGED_BROWSER_EXIT_TIMEOUT_MS);
		browser.kill("SIGKILL");
		if (!(await killed)) {
			debugLog("managed browser %d still running after SIGKILL", browser.pid);
			const profile = profileDirOf(browser);
			if (profile && liveProfileDirs.get(profile)?.persistent)
				throw new Error("Managed browser did not stop; its profile remains locked. Stop it before retrying.");
		}
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
	if (
		runtimeState.managedBrowserCdpPort &&
		process.env.PI_COMPUTER_USE_CDP_PORT === runtimeState.managedBrowserCdpPort
	) {
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
function managedBrowserArgs({
	remoteDebuggingPort,
	userDataDir,
	url,
}: {
	remoteDebuggingPort: number;
	userDataDir: string;
	url: string;
}): string[] {
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

/** Resolve directory metadata only; missing roots retain their lexical path and other failures refuse launch. */
async function canonicalProfileRoot(root: string): Promise<string> {
	const absolute = path.resolve(root);
	try {
		// Resolve before lexical normalization: `link/..` follows the link's filesystem parent.
		return await realpath(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
		throw error;
	}
}

/** Compare directory ancestry by filesystem identity, retaining alias parents and filesystem case semantics. */
async function profilePathContains(parent: Stats, descendant: string): Promise<boolean> {
	const absolute = path.isAbsolute(descendant) ? descendant : `${process.cwd()}${path.sep}${descendant}`;
	for (let entry = absolute; ; entry = path.dirname(entry)) {
		try {
			const info = await stat(entry);
			if (info.dev === parent.dev && info.ino === parent.ino) return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (path.dirname(entry) === entry) return false;
	}
}

/** Match metadata identities, not path spellings, across validation and use. */
function sameProfileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** No other unprivileged UID may replace an ancestry component; root and sticky shared parents are trusted. */
function assertSafeProfileAncestor(info: Stats): void {
	if ((info.uid !== 0 && info.uid !== process.getuid!()) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0))
		throw new Error(
			"managed_browser_profile has an unsafe ancestor: require current-user/root ownership and no group/world write unless sticky.",
		);
}

/** Inspect synchronously so final identity/permissions checks and spawn share one event-loop turn. */
function inspectPersistentProfile(directory: string): Stats {
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)
		throw new Error(
			"managed_browser_profile must be a real directory, not a symlink, owned by the current user with mode 0700.",
		);
	for (let parent = path.dirname(directory); ; parent = path.dirname(parent)) {
		const ancestor = lstatSync(parent);
		if (ancestor.isSymbolicLink())
			throw new Error("managed_browser_profile must not contain symlink components; use its canonical path.");
		assertSafeProfileAncestor(ancestor);
		if (path.dirname(parent) === parent) break;
	}
	return info;
}

/** Refuse identity or permission changes without ever repairing an unvalidated directory. */
function assertPersistentProfileIdentity(profile: ValidatedPersistentProfile): void {
	if (!sameProfileIdentity(inspectPersistentProfile(profile.directory), profile))
		throw new Error(
			"managed_browser_profile identity changed during launch; retry only after verifying the dedicated directory.",
		);
}

/** Validate the exact lease as well as its parent before releasing or launching through a pathname. */
function assertPersistentProfileLease(lease: PersistentProfileLease): void {
	assertPersistentProfileIdentity(lease.profile);
	const info = lstatSync(path.join(lease.profile.directory, ".pi-computer-use.lock"));
	if (
		!info.isDirectory() ||
		info.uid !== process.getuid!() ||
		(info.mode & 0o777) !== 0o700 ||
		!sameProfileIdentity(info, lease)
	)
		throw new Error("Persistent managed profile lease changed; refusing to use or remove it.");
}

/** Never follow a swapped parent or remove another owner's lease. Uncertain ownership stays fail-closed. */
function releasePersistentProfileLease(lease: PersistentProfileLease): boolean {
	try {
		assertPersistentProfileLease(lease);
		rmdirSync(path.join(lease.profile.directory, ".pi-computer-use.lock"));
		return true;
	} catch (error) {
		debugLog("could not release persistent profile lease: %s", error);
		return false;
	}
}

/** Chromium-family default data directories under HOME and under every configuration root. */
function browserDefaultProfileRoots(home: string, configurationRoots: readonly string[]): string[] {
	const channels = ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "helium"];
	return [
		path.join(home, "Library/Application Support/Google/Chrome"),
		path.join(home, "Library/Application Support/Chromium"),
		path.join(home, "Library/Application Support/Google/Chrome Canary"),
		path.join(home, "Library/Application Support/Google/Chrome Beta"),
		path.join(home, "Library/Application Support/Google/Chrome Dev"),
		path.join(home, "Library/Application Support/net.imput.helium"),
		path.join(home, ".config/google-chrome"),
		path.join(home, ".config/chromium"),
		path.join(home, ".config/google-chrome-beta"),
		path.join(home, ".config/google-chrome-unstable"),
		path.join(home, ".config/helium"),
		...configurationRoots.flatMap((root) => channels.map((name) => path.join(root, name))),
	];
}

/**
 * Validate an operator-created profile without reading any profile contents or changing its permissions.
 *
 * Check-then-use design: a pathname does not pin an inode, so the validated `dev`/`ino` is retained and the
 * full policy is repeated after port allocation and previous-browser shutdown (which yield), and again after
 * the lease is acquired. Lease check/create/capture and the final profile, lease and Chromium-lock checks run
 * synchronously immediately before `spawn`, using the verified resolved path. Ancestors must be owned by the
 * current user or root and not group/world writable unless sticky, so another UID cannot swap them. Cleanup
 * releases only the lease whose identity was captured inside the unchanged profile; uncertainty leaves it in
 * place. Same-UID attackers are out of scope, and only POSIX owner/mode bits are read (no extended ACLs).
 */
async function persistentBrowserProfile(
	configured: string,
	expected?: ValidatedPersistentProfile,
): Promise<ValidatedPersistentProfile> {
	if (process.platform === "win32")
		throw new Error(
			"Persistent managed profiles require owner-only POSIX permissions; Windows ACL validation is not supported.",
		);
	const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
	if (!path.isAbsolute(expanded)) throw new Error("managed_browser_profile must be an absolute path or start with ~/.");
	const directory = path.resolve(expanded);
	const info = inspectPersistentProfile(directory);
	if (expected && !sameProfileIdentity(info, expected))
		throw new Error("managed_browser_profile identity changed during launch; refusing the replacement.");
	const canonical = await realpath(directory);
	const home = await realpath(os.homedir());
	// Resolve directory metadata only, never enumerate or open browser profile contents.
	const configuredRootPaths = [
		path.join(home, ".config"),
		process.env.XDG_CONFIG_HOME,
		process.env.CHROME_CONFIG_HOME,
	].filter((root): root is string => Boolean(root));
	const configuredRoots = await Promise.all(configuredRootPaths.map(canonicalProfileRoot));
	const defaultPaths = browserDefaultProfileRoots(home, configuredRoots);
	const defaults = await Promise.all(defaultPaths.map(canonicalProfileRoot));
	const refusal =
		"managed_browser_profile must not use a default browser data directory (or its ancestor/descendants).";
	// HOME may contain a dedicated profile, but HOME itself and its ancestors must never become one.
	if ((await profilePathContains(info, home)) || (await profilePathContains(info, os.homedir())))
		throw new Error(refusal);
	// Keep declared paths as well as resolved targets: a symlinked child must not erase its parent's protection.
	// Configuration roots are independently protected, even when every recognized child points elsewhere.
	for (const root of [...configuredRootPaths, ...configuredRoots, ...defaultPaths, ...defaults]) {
		if (await profilePathContains(info, root)) throw new Error(refusal);
		let rootInfo: Stats;
		try {
			rootInfo = await stat(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (await profilePathContains(rootInfo, canonical)) throw new Error(refusal);
	}
	// Walk metadata only. A checkout's .git may be a directory or a worktree marker file.
	for (let parent = canonical; ; parent = path.dirname(parent)) {
		try {
			await lstat(path.join(parent, ".git"));
			throw new Error("managed_browser_profile must be outside every Git checkout.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (path.dirname(parent) === parent) break;
	}
	const validated = { directory: canonical, dev: info.dev, ino: info.ino };
	assertPersistentProfileIdentity(validated);
	return validated;
}

/** Refuse browser-owned locks, including dangling symlinks, without removing any of them. */
function assertNoChromiumProfileLocks(directory: string): void {
	for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
		try {
			lstatSync(path.join(directory, name));
			throw new Error(
				"Persistent managed profile is in use or has a stale Chromium lock. Close its browser and resolve the lock manually; Pi never removes browser locks.",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

/** Check, create and capture the lease without yielding; fail closed on any post-creation replacement. */
function lockPersistentBrowserProfile(profile: ValidatedPersistentProfile): PersistentProfileLease {
	assertPersistentProfileIdentity(profile);
	assertNoChromiumProfileLocks(profile.directory);
	try {
		mkdirSync(path.join(profile.directory, ".pi-computer-use.lock"), { mode: 0o700 });
	} catch (error) {
		throw new Error(
			"Persistent managed profile could not be locked. It may be in use or have a stale .pi-computer-use.lock; after verifying all users of this profile have stopped, remove that empty lease directory manually.",
			{ cause: error },
		);
	}
	assertPersistentProfileIdentity(profile);
	const info = lstatSync(path.join(profile.directory, ".pi-computer-use.lock"));
	return { profile, dev: info.dev, ino: info.ino };
}

/**
 * Stop the previous managed browser, acquire its replacement's profile, then spawn and track it.
 * Call only inside `withManagedBrowserLifecycle`.
 * @param browser Configured managed browser, which names the executable and the temporary profile prefix.
 * @param url First page to open.
 * @returns The spawned browser, its `--remote-debugging-port` and the executable used.
 * @throws {Error} If no executable is found, `mkdtemp` or a synchronous `spawn` fails (a temporary profile is
 * removed first), or a persistent `managed_browser_profile` is refused: native Windows, a missing or unsafe
 * directory, a default or configuration root, an unsafe ancestor, a Git checkout, an existing Pi lease or Chromium
 * lock, or a profile or lease that changed identity during launch. Refusals leave the profile untouched.
 */
async function startManagedBrowser(
	browser: ComputerUseConfig["managed_browser"],
	url: string,
): Promise<{ managedBrowser: ChildProcess; port: number; executable: string }> {
	const executable = await managedBrowserExecutable(browser);
	const configured = getComputerUseConfig().managed_browser_profile;
	const persistent = configured ? await persistentBrowserProfile(configured) : undefined;
	const port = await freeTcpPort();
	disconnectCdp();
	await releaseManagedBrowser();
	// A fixed name in a shared temp dir can be owned or pre-seeded by another account, so each
	// launch gets a private profile dir that lives exactly as long as its browser process.
	// Revalidate before creating any lease: allocation and previous-browser shutdown may have yielded.
	if (persistent) await persistentBrowserProfile(persistent.directory, persistent);
	let profileDir = persistent?.directory ?? (await mkdtemp(path.join(os.tmpdir(), `pi-${browser}-cdp-`)));
	const lease = persistent ? lockPersistentBrowserProfile(persistent) : undefined;
	let managedBrowser: ChildProcess;
	try {
		// Full refusal policy AFTER lease acquisition, followed by synchronous final identity/lock checks.
		if (lease) {
			profileDir = (await persistentBrowserProfile(profileDir, lease.profile)).directory;
			assertPersistentProfileLease(lease);
			assertNoChromiumProfileLocks(profileDir);
		}
		const args = managedBrowserArgs({ remoteDebuggingPort: port, userDataDir: profileDir, url });
		managedBrowser = spawn(executable, args, { stdio: "ignore", detached: false });
	} catch (error) {
		if (lease) releasePersistentProfileLease(lease);
		else await removeProfileDir(profileDir);
		throw error;
	}
	// `close` also fires after an async spawn failure. Session shutdown waits for it and the exit hook
	// covers a hard exit, so the profile never outlives the browser.
	trackProfileDir(profileDir, managedBrowser, lease);
	managedBrowser.once("close", () => {
		// The hard-exit hook forgets leases but must never turn a persistent profile into temp data.
		if (lease && liveProfileDirs.get(profileDir)?.browser !== managedBrowser) return;
		void removeProfileDir(profileDir);
	});
	managedBrowser.unref();
	runtimeState.previousCdpPort = process.env.PI_COMPUTER_USE_CDP_PORT;
	runtimeState.managedBrowser = managedBrowser;
	runtimeState.managedBrowserCdpPort = String(port);
	process.env.PI_COMPUTER_USE_CDP_PORT = String(port);
	return { managedBrowser, port, executable };
}

// Side effects: stops any previous managed browser (SIGTERM, then SIGKILL) and releases its profile,
// then either creates a private temporary profile dir under os.tmpdir() (removed with the browser) or,
// when `managed_browser_profile` is set, validates that dedicated profile and takes Pi's lease on it
// (the profile itself is never deleted). Either is tracked in `liveProfileDirs` until released,
// installs the `exit` hook once, starts a Pi-managed browser process, and sets
// PI_COMPUTER_USE_CDP_PORT for subsequent CDP context discovery. Waits for any earlier launch or
// shutdown to finish its lifecycle step first.
async function performLaunchBrowser(
	params: LaunchBrowserParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<BrowserObservationDetails>> {
	const requestedUrl = trimOrUndefined(params.url);
	if (requestedUrl && !/^https?:\/\//i.test(requestedUrl))
		throw new Error("launch_browser.url must be an absolute HTTP(S) URL.");
	const browser = getComputerUseConfig().managed_browser;
	// Joins the lifecycle chain before the first `await`, so a shutdown called after this launch
	// always runs after it and stops the browser it starts.
	const { managedBrowser, port, executable } = await withManagedBrowserLifecycle(async () => {
		throwIfAborted(signal);
		return await startManagedBrowser(browser, requestedUrl ?? "about:blank");
	});
	try {
		await waitForCdpPort(port, signal);
	} catch (error) {
		// A later launch or a shutdown that already took this browser over has stopped it.
		try {
			await withManagedBrowserLifecycle(async () => {
				if (runtimeState.managedBrowser === managedBrowser) await releaseManagedBrowser();
			});
		} catch (stopError) {
			// waitForCdpPort rejects with an Error; keep that readiness failure primary.
			Object.assign(error as Error, { cause: stopError });
		}
		throw error;
	}
	const page = (await listCdpPageContexts())[0];
	if (!page) throw new Error("Managed browser launched without a CDP page context.");
	const resourceKey = `cdp:${page.targetId}`;
	const scheduled = await resourceScheduler.read(resourceKey, async () => await cdpSnapshotForContext(page.contextId));
	if (!scheduled.value) throw new Error("Managed browser page could not be observed after launch.");
	const result = browserObservationResult(scheduled.value, resourceKey, scheduled.epoch, "launch_browser");
	result.details.executable = executable;
	result.content.push({ type: "text", text: `Managed browser executable: ${JSON.stringify(executable)}.` });
	return result;
}

async function performNavigateBrowser(
	params: NavigateBrowserParams,
): Promise<AgentToolResult<BrowserObservationDetails>> {
	const contextId = browserContextForOperation();
	const url = trimOrUndefined(params.url);
	if (!contextId)
		throw new Error(
			"navigate_browser.stateId must belong to a CDP browser-page observation. Native browser windows use act_ui.",
		);
	if (!url || !/^https?:\/\//i.test(url)) throw new Error("navigate_browser.url must be an absolute HTTP(S) URL.");
	const baseSnapshot = operationState().browserSnapshot!;
	return await withBrowserWrite(contextId, async () => {
		const ok = await cdpNavigateContext(contextId, url);
		if (!ok) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
		return await refreshBrowserSnapshot(contextId, "navigate_browser", {
			stateId: baseSnapshot.snapshotId,
			outline: baseSnapshot.outline,
		});
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
		const successor = await refreshBrowserSnapshot(contextId, "evaluate_browser", {
			stateId: baseSnapshot.snapshotId,
			outline: baseSnapshot.outline,
		});
		const details: EvaluateBrowserDetails = {
			tool: "evaluate_browser",
			baseStateId: baseSnapshot.snapshotId,
			stateId: successor.details.stateId,
			view: successor.details.view,
			changes: successor.details.changes,
			renderedOutline: successor.details.renderedOutline,
		};
		return {
			content: [...successor.content, { type: "text", text: `Evaluation value: ${JSON.stringify(result.value)}` }],
			details,
		};
	});
}

type PolicyPreflightParams = SearchUiParams & { root?: unknown; ref?: string };

function assertCdpUseAllowed(tool: string, params: PolicyPreflightParams): void {
	const root = params?.root;
	const contextId =
		tool === "observe_ui" && typeof root === "string"
			? runtimeState.browserContextByRoot.get(root)
			: operationState().contextId;
	if ((tool === "launch_browser" || isBrowserContextId(contextId)) && !isBrowserUseEnabled()) {
		throw new Error("Browser use is disabled by pi-computer-use config. Enable browser_use to use CDP.");
	}
}

/** A known blocked root must not even reach helper readiness for a live operation. */
function assertKnownRootNotBlocked(tool: string, params: PolicyPreflightParams, outputRef: boolean): void {
	const root = params?.root;
	const { currentTarget } = operationState();
	if (tool === "observe_ui" && root !== undefined) {
		const known = typeof root === "string" ? runtimeState.windowRefs.get(root) : undefined;
		if (known) assertAppNotBlocked(known);
		if (currentTarget && currentTarget.windowRef === root) assertAppNotBlocked(currentTarget);
		return;
	}
	if (!currentTarget) return;
	const refusalForState = () => {
		const savedRef = currentTarget.windowRef;
		const latest = requiresLiveIdentity() && savedRef ? runtimeState.windowRefs.get(savedRef) : undefined;
		return appPolicyRefusal(currentTarget) ?? (latest && appPolicyRefusal(latest));
	};
	if (tool === "observe_ui" || tool === "act_ui" || tool === "wait_for" || (tool === "read_text" && !outputRef)) {
		const refusal = refusalForState();
		if (refusal) throw refusal;
	} else if (tool === "search_ui" || tool === "expand_ui") {
		// Reuse the live-path predicates; cached queries do not require policy admission.
		const refusal = refusalForState();
		if (!refusal) return;
		const currentOutline = currentOutlineOrThrow();
		if (tool === "search_ui") {
			const { text, role, capability } = searchUiFilters(params);
			if (
				(text || role || capability) &&
				shouldEscalateSearchOCR(searchOutlineRanked(currentOutline, text, role, capability, SEARCH_UI_LIMIT).matches)
			)
				throw refusal;
		} else {
			const ref = trimOrUndefined(params.ref);
			const node = ref ? nodeByRef(currentOutline, ref) : undefined;
			if (node && needsScopedLook(currentOutline, node)) throw refusal;
		}
	}
}

async function executeTool<P, T>(
	tool: string,
	ctx: ExtensionContext,
	params: P,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const outputRef = trimOrUndefined((params as { ref?: string } | undefined)?.ref)?.startsWith("@o") === true;
	const requestedStateId = outputRef
		? undefined
		: trimOrUndefined((params as { stateId?: string } | undefined)?.stateId);
	const stateRecord = requestedStateId ? savedStates.get(requestedStateId) : undefined;
	if (requestedStateId && !stateRecord) {
		throw new Error(`State '${requestedStateId}' is unavailable or was evicted. Observe the root again.`);
	}
	const operation = savedStates.hydrate(stateRecord);
	return await savedStates.operations.run(operation, async () => {
		const { value: pending } = await resourceScheduler.read("session-lifecycle", async () => {
			await ensureReady(ctx, signal, () => {
				assertCdpUseAllowed(tool, params as PolicyPreflightParams);
				assertKnownRootNotBlocked(tool, params as PolicyPreflightParams, outputRef);
			});
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

function makeToolExecutor<P, D>(
	tool: string,
	perform: (params: P, signal?: AbortSignal) => Promise<AgentToolResult<D>>,
) {
	return async (
		_toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<D> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<D>> => {
		try {
			return applyOutputEnvelope(tool, await executeTool(tool, ctx, params, signal, () => perform(params, signal)));
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
export const executeAct = makeToolExecutor<
	ActParams,
	ComputerUseDetails | TerminalDesktopActionDetails | BrowserObservationDetails
>("act_ui", performAct);
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
				// Results are newest first; older discoveries must not overwrite a more recent refusal.
				if (runtimeState.windowRefs.has(window.windowRef)) continue;
				const record: WindowRefRecord = {
					ref: window.windowRef,
					appName: typeof window.app === "string" ? window.app : "Unknown App",
					appId: typeof window.appId === "string" ? window.appId : undefined,
					legacyIdentity: !window.appId && window.identityUnresolved !== true ? true : undefined,
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
			appId: details.target.appId,
			legacyIdentity: !details.target.appId ? true : undefined,
			bundleId: details.target.bundleId,
			pid: Math.trunc(details.target.pid),
			windowTitle: details.target.windowTitle ?? "(untitled)",
			windowId: Math.trunc(details.target.windowId),
			windowRef: typeof details.target.windowRef === "string" ? details.target.windowRef : undefined,
			nativeWindowRef:
				typeof (details.target as any).nativeWindowRef === "string"
					? (details.target as any).nativeWindowRef
					: undefined,
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
		const outline =
			details.outline?.root && typeof details.outline.lookId === "string"
				? details.outline
				: loadStoredOutline(capture.stateId);
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

`semantic` observation is cheapest, `fused` is the default, and `visual` forces visual text evidence. Search requires at least one of `text`, `role`, or `capability`. It ranks exact, prefix, and substring text before conservative fuzzy matches, returns a fixed top set with the total match count, and asks the caller to refine broad queries. Search can escalate OCR once when the original desktop look omitted it; that refresh is checked against the state's resource epoch. A desktop search with zero matches in an outline that has `truncated` (unread) nodes leads with `Inconclusive: no matches in the part of the outline that could be read; N nodes unread (...)` instead of a zero count; its details keep `totalMatches: 0` and add `inconclusive: true` and `unreadRefs`, the unread refs to `expand_ui`. Both fields are omitted when there is a match or nothing is unread. Likewise an empty `read_text` page from a `truncated` node returns `inconclusive: true` and says the text was not read.

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

Verification reports `verified`, `preexisting`, `failed`, or `inconclusive`. A
preexisting condition means the requested end state holds, but is not evidence
that the action caused it. Use `ref` for one exact element or `scopeRef` for a
subtree; role-only conditions must be scoped, and value checks require an exact
`ref`.

An `absent` condition holds only on complete evidence. The helper must walk the
whole scope and read every field the condition tests (the macOS walk stops at
depth 12 and 2,000 nodes) and say so: the macOS client reads a `gone` reply
without the helper's `complete: true`, e.g. from an older external helper, as
incomplete. The successor observation, captured from the exact root the wait read
(its native ref or window id, never a same-title window and never a foreground
modal that opened meanwhile), must neither show the
condition nor mark a node `truncated` in the scope, above it or, unless the
scope is an exact `ref`, below it. Element refs are look-local, so a scope ref
missing from the successor proves nothing while the condition shows anywhere in
it. A root closure proven from a complete listing also settles it. Otherwise
`act_ui` reports the check `inconclusive` with `postcondition_inconclusive`,
keeping the delivery outcome from before the check (its message claims delivery
only when that outcome is `worked`), and `wait_for` returns `inconclusive: true`
instead of `gone`, with `unreadRefs` only when the successor has unread nodes
there. When the root of a claimed absence cannot be observed or resolved by that
identity afterward, `wait_for` returns `inconclusive: true` with `observationError` and no successor
state. A `wait_for` that timed out while the helper still saw the condition is a
failed wait (`found: false`, `timedOut: true`), not an inconclusive one, and a
failed successor observation after it, or after any presence wait, is an error.
The Windows UIA wait still answers `gone` from a truncated walk; only the
successor's `truncated` root catches that.

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

Confidently matched elements retain their model-facing refs across resulting states. New nodes receive new refs and removed nodes are named explicitly; a node missing under any surviving ancestor the successor could not read (`truncated`) is not reported as removed. A `search_ui` with zero matches in an outline with `truncated` nodes is `inconclusive` and lists them in `unreadRefs`. The runtime returns the compact control list instead when the root was replaced, identity confidence is low, or the change budget is too large. `search_ui`, `expand_ui`, and `inspect_ui` always query the complete saved state regardless of how it was rendered.

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
