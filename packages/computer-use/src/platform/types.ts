import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LookResponse } from "../outline.ts";
import type { PermissionStatus } from "../permissions.ts";

export type PlatformName = "macos" | "windows" | "linux";
export type NativeInputDelivery = "hid" | "pid";
export type ActOutcome = "worked" | "didnt" | "unknown";
/**
 * Best-effort presentation hint for a root. The seam guarantees only the
 * `window` vs transient distinction; specific transient kinds are display hints
 * and must never drive behavior in shared code. Platforms that need precise
 * distinctions internally should use native signals.
 */
export type PlatformRootKind = "window" | "menu" | "sheet" | "popover" | "dialog";

export interface PlatformDiagnostics {
	protocolVersion: number;
	architectureVersion?: number;
	invariants?: string[];
	pid: number;
	parentPid?: number;
	parentAppName?: string;
	parentBundleId?: string;
	parentPath?: string;
	executablePath?: string;
	/** macOS kernel vnode identity (`"<dev>:<ino>"`) of the helper's mapped executable image. */
	executableId?: string;
	os?: string;
	arch?: string;
	accessibility?: boolean;
	screenRecording?: boolean;
}

export interface PlatformReadyState {
	permissionStatus?: PermissionStatus;
	lastPermissionCheckAt: number;
	helperDiagnostics?: PlatformDiagnostics;
}

export interface PlatformRootQuery {
	pid?: number;
	title?: string;
	/**
	 * The caller reads a missing root as closed. The macOS backend then fails with `inventory_incomplete` unless the
	 * helper reported the listing `complete`; a reply without the field (an older external helper) fails closed.
	 */
	authoritative?: boolean;
}

interface PlatformAppIdentity {
	/** Host app identifier: macOS bundle id, Windows or Linux executable basename. */
	appId?: string;
	/** macOS alias for the bundle identifier. */
	bundleId?: string;
	/**
	 * Linux block-only names: the X11 `WM_CLASS` instance and class, a literal `exe` link name ending in
	 * ` (deleted)`, and an interpreter's script or module name from `/proc/<pid>/cmdline`. A match refuses
	 * the root; these names never admit or identify one.
	 */
	blockAliases?: string[];
}

/** What a backend classifies a browser by; Linux ignores the app-controlled accessible `appName` (#1295). */
export type BrowserAppIdentity = { appName: string } & Pick<PlatformAppIdentity, "appId" | "bundleId">;

export interface PlatformApp extends PlatformAppIdentity {
	appName: string;
	pid: number;
	isFrontmost?: boolean;
}

export interface FramePoints {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PlatformRoot extends PlatformAppIdentity {
	kind: PlatformRootKind;
	rootRef?: string;
	windowRef?: string;
	windowId?: number;
	pid?: number;
	appName?: string;
	title: string;
	role?: string;
	subrole?: string;
	zOrder: number;
	framePoints: FramePoints;
	scaleFactor: number;
	/**
	 * State flags: `undefined` means the platform did not read the flag (the macOS helper omits an unread one), never
	 * `false`. Ranking and modal selection in `root-selection.ts` treat unknown as no evidence either way.
	 */
	isOnscreen?: boolean;
	isFocused?: boolean;
	isMinimized?: boolean;
	/** Best-effort; platforms without a main-window concept may mirror `isFocused`. */
	isMain?: boolean;
	/** Platform-reported modality fact, including platform-specific modal/dialog/sheet signals. */
	isModal: boolean;
	/** Windows: discovery could not bind this root to a verifiable window instance, so it is refused. */
	instanceUnavailable?: true;
	metadata?: Record<string, unknown>;
}

/**
 * A root listing. `complete: false` (macOS) marks one the helper could not read completely: a root it omits is
 * unknown, not closed, and a saved root resolves from it only by its verified identity, never a lookalike.
 */
export type PlatformRootList = PlatformRoot[] & { complete?: boolean };

export interface PlatformFrontmostResult extends PlatformAppIdentity {
	appName: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
	rootRef?: string;
}

export interface PlatformFocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

export interface HelperActPerformed {
	grounding?: "description" | "coordinates" | "keyboard-events";
	/** `ax` means the platform accessibility API (AX on macOS, UIA on Windows). */
	delivery?: "ax" | NativeInputDelivery;
	refound?: boolean;
	/** Free-form diagnostic naming the platform's delta mechanism. */
	deltaSource?: string;
	selectionGrounding?: "ax" | "keyboard";
	/** macOS scroll diagnostic: `scroll_bar_value` when the scroll bar value was written and confirmed, `scroll_bar_value_unconfirmed` when the write was accepted but not yet visible, `scroll_bar_value_partial` when only some requested axes were written (the rest used the wheel), otherwise why the accessibility path was skipped before the wheel fallback. */
	axScroll?: string;
	transaction?: boolean;
	actionCount?: number;
	activated?: boolean;
	raised?: boolean;
	focused?: boolean;
}

export interface PlatformRootDelta {
	change: "appeared" | "closed" | "focused";
	kind: string;
	ref?: string;
	title?: string;
	pid: number;
	isModal?: boolean;
	metadata?: Record<string, unknown>;
}

export interface HelperActResult {
	outcome: ActOutcome;
	performed?: HelperActPerformed;
	evidence?: Record<string, unknown>;
	error?: { code?: string; message?: string; whatIsThere?: unknown };
	rootDelta?: PlatformRootDelta[];
	steps?: HelperActResult[];
	stoppedAt?: number;
}

/**
 * Native root identity. `windowId` is a CoreGraphics-style id and is omitted (never `0`) when the
 * root has no capturable window. `rootRef` and `windowRef` are two spellings of the same native
 * root reference; backends normalize them with `normalizeTarget`.
 */
export interface PlatformTarget {
	pid?: number;
	windowId?: number;
	rootRef?: string;
	windowRef?: string;
}

export interface PlatformObserveRequest {
	target: PlatformTarget;
	/** Existing immutable look whose untouched refs/coordinate geometry survive a scoped refresh. */
	baseLookId?: string;
	readText: "auto" | "always" | "never";
	scopeRef?: string;
	maxDimension?: number;
	includeImage?: boolean;
}

export type PlatformActTarget = { ref: string } | { x: number; y: number } | { focus: PlatformPoint };
type PlatformDeliveryPolicy = "ax_only" | "background" | "default" | "foreground";
type PlatformMouseButton = "left" | "right" | "middle";
type PlatformActDeliveryParam = { delivery?: NativeInputDelivery };
export type PlatformPoint = { x: number; y: number };

export interface PlatformActRequestBase {
	lookId: string;
	pid?: number;
	target: PlatformActTarget;
	policy: PlatformDeliveryPolicy;
}

export type PlatformActRequest = PlatformActRequestBase &
	(
		| {
				action: "press" | "click";
				params: { button?: PlatformMouseButton; clickCount?: number } & PlatformActDeliveryParam;
		  }
		| { action: "setText"; params: { text: string } & PlatformActDeliveryParam }
		| { action: "typeText"; params: { text: string } & PlatformActDeliveryParam }
		| { action: "paste"; params: { text: string } & PlatformActDeliveryParam }
		| { action: "keypress"; params: { keys: string[] } & PlatformActDeliveryParam }
		| { action: "secondaryAction"; params: { name: string } & PlatformActDeliveryParam }
		| { action: "selectText"; params: { start: number; length: number } & PlatformActDeliveryParam }
		| { action: "scroll"; params: { scrollX: number; scrollY: number } & PlatformActDeliveryParam }
		| { action: "drag"; params: { path: PlatformPoint[] } & PlatformActDeliveryParam }
		| { action: "moveMouse"; params: PlatformActDeliveryParam }
	);

export interface PlatformReadTextRequest {
	/** Observation that owns the element ref. Native backends must not resolve across observations. */
	lookId: string;
	elementRef: string;
	/** Required by the Windows helper for live reads. */
	pid?: number;
	windowId?: number;
	offset: number;
	limit: number;
}

export interface PlatformReadTextResponse {
	text: string;
	offset: number;
	limit: number;
	totalChars: number;
	hasMore: boolean;
}

export interface PlatformWaitForRequest extends PlatformTarget {
	lookId?: string;
	text?: string;
	role?: string;
	value?: string;
	scopeRef?: string;
	scopeExact?: boolean;
	gone: boolean;
	timeoutMs: number;
}

export interface PlatformWaitForResponse {
	found: boolean;
	gone?: boolean;
	timedOut?: boolean;
	/**
	 * A `gone` wait whose last walk could not read the whole scope: absence is unknown. The macOS backend also sets it
	 * for a `gone` reply without the helper's `complete` field, e.g. from an older external helper.
	 */
	incomplete?: boolean;
	nodeCount?: number;
}

export interface ComputerUsePlatformBackend {
	name: PlatformName;
	/**
	 * Release process-local resources when the Pi session is torn down. May resolve to a warning the user must
	 * see, e.g. that a helper exited with keys or buttons possibly still held.
	 */
	shutdown?(): void | Promise<void> | Promise<string | undefined>;
	setActivity?(active: boolean): void | Promise<void>;
	ensureReady(ctx: ExtensionContext, state: PlatformReadyState, signal?: AbortSignal): Promise<PlatformReadyState>;
	listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
	listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRootList>;
	/**
	 * The roots of every process in `pids` from one inventory, for a filtered `find_roots` that matched several apps,
	 * e.g. one X11 window listing on Linux rather than one per app queued behind a stalled X server. A PID-scoped
	 * failure fails the whole call, as one call per process would. Without it, each process is listed alone.
	 */
	listRootsOfPids?(pids: readonly number[], signal?: AbortSignal): Promise<PlatformRoot[]>;
	/** Explain why no roots are visible on this host (e.g. a WSL2 guest), appended to empty `find_roots` text. */
	emptyRootsHint?(): string | undefined;
	getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult>;
	focusWindow(target: PlatformTarget, signal?: AbortSignal): Promise<PlatformFocusWindowResult>;
	observe(
		request: PlatformObserveRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<LookResponse>;
	act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult>;
	/** Execute one-resource actions with one root baseline and one final settle. */
	actBatch?(
		requests: PlatformActRequest[],
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<HelperActResult>;
	readText(
		args: PlatformReadTextRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PlatformReadTextResponse>;
	/**
	 * The live root of a retained native look, found by the native identity the look holds rather than an inventory
	 * handle: `undefined` only when the lookup proved it absent; an incomplete lookup, the helper's or the client's
	 * deadline, rejects with code `timeout`, and a malformed reply rejects too (Linux, #1300).
	 */
	lookRoot?(lookId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformRoot | undefined>;
	waitFor(
		args: PlatformWaitForRequest,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PlatformWaitForResponse>;
	/** Browser classification: macOS by bundle id or app name, Windows by process name, Linux by `appId` alone. */
	isBrowserApp(app: BrowserAppIdentity): boolean;
	isChromeFamilyApp(app: BrowserAppIdentity): boolean;
	openBrowserLocation(
		target: { appName: string; bundleId?: string },
		url: string,
		signal?: AbortSignal,
	): Promise<boolean>;
}
