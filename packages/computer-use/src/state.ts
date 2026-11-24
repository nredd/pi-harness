import { AsyncLocalStorage } from "node:async_hooks";
import type { CdpPageSnapshot } from "./cdp.ts";
import type { ImageMode } from "./contract.ts";
import type { WindowNote } from "./note.ts";
import {
	type LookResponse,
	type Outline,
	restoreOutline,
	type SerializedOutline,
	serializeOutline,
} from "./outline.ts";
import { StateStore, type StoredState } from "./runtime.ts";

interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
}

export interface CurrentTarget {
	appName: string;
	appId?: string;
	legacyIdentity?: true;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
	/** The root's kind when it was resolved: a CG window id never re-identifies a sheet as a window or back. */
	rootKind?: string;
}

export interface CurrentCapture {
	stateId: string;
	width: number;
	height: number;
	scaleFactor: number;
	timestamp: number;
}

export interface OperationState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentStateTarget?: StateTargetSnapshot;
	currentImageMode?: ImageMode;
	currentLook?: LookResponse;
	currentOutline?: Outline;
	currentNote?: WindowNote;
	resourceKey?: string;
	epoch?: number;
	browserSnapshot?: CdpPageSnapshot;
	contextId?: string;
	/** Process-local order of the live look this desktop state holds; a restored state has none and counts as oldest. */
	lookSeq?: number;
	/** The protection revision of the record this operation read: a graft that later saw protection bumps it. */
	protectionRevision?: number;
}

/** What a retained desktop state's text came from: enough to decide whether a later protected look revoked it. */
export interface StateProvenance {
	stateId: string;
	target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">;
	lookSeq: number;
	protectionRevision: number;
}

/** A live look of `target`'s root at `lookSeq` saw a protected node; `keep` is the state that look produced. */
interface Revocation {
	target: StateProvenance["target"];
	lookSeq: number;
	keep: string;
}

/**
 * Whether `a` and `b` may be the same root, for revocation. Fails closed: only a pid mismatch or two comparable,
 * different window identities separate them. A Windows native ref names one window instance, so it alone decides
 * there; elsewhere a positive window id decides first, then the native ref. Titles never separate roots.
 */
export function mayShareRoot(
	a: StateProvenance["target"],
	b: StateProvenance["target"],
	nativeRefOnly: boolean,
): boolean {
	if (a.pid !== b.pid) return false;
	if (!nativeRefOnly && a.windowId > 0 && b.windowId > 0) return a.windowId === b.windowId;
	if (a.nativeWindowRef && b.nativeWindowRef) return a.nativeWindowRef === b.nativeWindowRef;
	return true;
}

/** Revocations with equal keys match exactly the same states, so the one with the later look subsumes the other. */
function revocationKey(target: StateProvenance["target"]): string {
	return JSON.stringify([target.pid, target.windowId > 0 ? target.windowId : 0, target.nativeWindowRef ?? ""]);
}

interface DesktopObservation {
	kind: "desktop";
	target: CurrentTarget;
	capture: CurrentCapture;
	look: Omit<LookResponse, "parsedOutline" | "outline">;
	outline: SerializedOutline;
	note?: WindowNote;
	imageMode?: ImageMode;
	/** In-memory only: `SavedStates.nextLook` order of the live look. Restored states have none. */
	lookSeq?: number;
	/**
	 * The protection revision this record's outline was sanitized at. It travels with the outline, so a record written
	 * before a graft bumped the revision reads as revoked until the grafted record replaces it.
	 */
	protectionRevision?: number;
}

interface BrowserObservation {
	kind: "browser";
	snapshot: CdpPageSnapshot;
	outline: SerializedOutline;
}

export type UiObservation = DesktopObservation | BrowserObservation;

export class SavedStates {
	readonly store = new StateStore<UiObservation>(128);
	readonly operations = new AsyncLocalStorage<OperationState>();
	private nextLookSeq = 0;
	private readonly revocations = new Map<string, Revocation>();
	private readonly protectionRevisions = new Map<string, number>();

	/** `nativeRefOnly`: whether the active platform names a root by its native ref alone (Windows). */
	constructor(private readonly nativeRefOnly: () => boolean = () => false) {}

	/** Order the next live desktop look. Call under the root's scheduler slot, right after the look returns. */
	nextLook(): number {
		return ++this.nextLookSeq;
	}

	/**
	 * A live look at `lookSeq` of `target`'s root saw a protected node (#1279). Every other retained state of that root
	 * whose look is older is revoked: identity across looks is unproven, so its text may name the node now protected.
	 * `keep` (the state the look produced or grafted) stays. Only live looks call this, never cached queries.
	 * Callers record right after `nextLook`, so revocations arrive in look order and a later one replaces the earlier
	 * one with the same key: it revokes a superset, provided `keep` was not revoked already (a graft checks first).
	 */
	revokeOlder(target: StateProvenance["target"], lookSeq: number, keep: string): void {
		this.revocations.set(revocationKey(target), { target: { ...target }, lookSeq, keep });
	}

	/** A graft on `stateId` saw a protected node: text that state produced earlier is revoked; returns the new revision. */
	bumpProtection(stateId: string): number {
		const revision = this.protectionRevision(stateId) + 1;
		this.protectionRevisions.set(stateId, revision);
		return revision;
	}

	protectionRevision(stateId: string): number {
		return this.protectionRevisions.get(stateId) ?? 0;
	}

	/** Provenance of a desktop operation or record; `undefined` for browser and target-less states, which never revoke. */
	provenance(state: OperationState): StateProvenance | undefined {
		if (!state.currentTarget || !state.currentCapture) return undefined;
		return {
			stateId: state.currentCapture.stateId,
			target: {
				pid: state.currentTarget.pid,
				windowId: state.currentTarget.windowId,
				nativeWindowRef: state.currentTarget.nativeWindowRef,
			},
			lookSeq: state.lookSeq ?? 0,
			protectionRevision: state.protectionRevision ?? 0,
		};
	}

	/** Whether a later protected look or graft revoked text taken from `provenance`. */
	isRevoked(provenance: StateProvenance): boolean {
		if (this.protectionRevision(provenance.stateId) !== provenance.protectionRevision) return true;
		for (const revocation of this.revocations.values()) {
			if (
				revocation.keep !== provenance.stateId &&
				provenance.lookSeq < revocation.lookSeq &&
				mayShareRoot(revocation.target, provenance.target, this.nativeRefOnly())
			)
				return true;
		}
		return false;
	}

	current(): OperationState {
		const state = this.operations.getStore();
		if (!state) throw new Error("Computer-use operation state is unavailable.");
		return state;
	}

	get(stateId: string): StoredState<UiObservation> | undefined {
		return this.store.get(stateId);
	}

	set(record: StoredState<UiObservation>): void {
		this.store.set(record);
	}

	clear(): void {
		this.store.clear();
		this.revocations.clear();
		this.protectionRevisions.clear();
	}

	hydrate(record: StoredState<UiObservation> | undefined): OperationState {
		if (!record) return {};
		if (record.value.kind === "browser") {
			const outline = restoreOutline(record.value.outline);
			return {
				currentCapture: {
					stateId: record.stateId,
					width: 0,
					height: 0,
					scaleFactor: 1,
					timestamp: record.value.snapshot.capturedAt,
				},
				currentLook: {
					lookId: record.value.snapshot.snapshotId,
					capturedAt: record.value.snapshot.capturedAt / 1000,
					window: {
						windowId: 0,
						framePoints: { x: 0, y: 0, w: 1, h: 1 },
						scaleFactor: 1,
						isModal: false,
						role: "document",
						subrole: "",
					},
					outline: outline.root,
					timings: {},
					parsedOutline: outline,
				},
				currentOutline: outline,
				resourceKey: record.resourceKey,
				epoch: record.epoch,
				browserSnapshot: record.value.snapshot,
				contextId: record.value.snapshot.contextId,
			};
		}
		const outline = restoreOutline(record.value.outline);
		return {
			currentTarget: { ...record.value.target },
			currentCapture: { ...record.value.capture },
			currentStateTarget: {
				pid: record.value.target.pid,
				windowId: record.value.target.windowId,
				windowRef: record.value.target.windowRef,
			},
			currentImageMode: record.value.imageMode,
			currentLook: { ...record.value.look, outline: outline.root, parsedOutline: outline },
			currentOutline: outline,
			currentNote: record.value.note ? structuredClone(record.value.note) : undefined,
			resourceKey: record.resourceKey,
			epoch: record.epoch,
			lookSeq: record.value.lookSeq,
			protectionRevision: record.value.protectionRevision ?? 0,
		};
	}

	saveDesktop(state: OperationState, resourceKey: string, epoch: number): void {
		if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline) return;
		this.store.set({
			stateId: state.currentCapture.stateId,
			resourceKey,
			epoch,
			value: {
				kind: "desktop",
				target: { ...state.currentTarget },
				capture: { ...state.currentCapture },
				look: {
					lookId: state.currentLook.lookId,
					capturedAt: state.currentLook.capturedAt,
					window: structuredClone(state.currentLook.window),
					image: state.currentLook.image ? { ...state.currentLook.image } : undefined,
					timings: { ...state.currentLook.timings },
					readText: state.currentLook.readText ? { ...state.currentLook.readText } : undefined,
				},
				outline: serializeOutline(state.currentOutline),
				note: state.currentNote ? structuredClone(state.currentNote) : undefined,
				imageMode: state.currentImageMode,
				lookSeq: state.lookSeq,
				protectionRevision: state.protectionRevision,
			},
		});
	}
}
