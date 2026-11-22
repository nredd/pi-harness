import {
	isProtectedNode,
	nodeByRef,
	type Outline,
	type OutlineNode,
	outlineNodeLabel,
	PROTECTED_LABEL,
	REDACTED_LABEL,
} from "./outline.ts";

interface NoteRegion {
	key: string;
	label: string;
	status: "seen" | "changed" | "never-looked";
	detail?: string;
	/** Top-level outline node the label was read from; absent for root and window regions. */
	ref?: string;
}

/** Key shared by every redacted region, so retained history collapses instead of growing. */
const REDACTED_KEY = "redacted";

/** Regions whose labels come from root listings or capture pairing, never from an outline node. */
const NON_OUTLINE_KEY = /^(root|window):/;

export interface WindowNote {
	windowRef: string;
	title: string;
	pairing: "exact" | "high" | "low";
	lastLookId?: string;
	regions: NoteRegion[];
}

interface NoteWindowInput {
	windowRef?: string;
	title: string;
	pairing?: "exact" | "high" | "low";
	pairingScore?: number;
}

interface NoteRefreshOutcome {
	window: NoteWindowInput;
	windowChanged?: boolean;
	newWindowLabel?: string;
	rootDelta?: Array<{ change: string; kind: string; title?: string; ref?: string }>;
	/** 1-based number of the acted action when it timed out, so its delivery is unknown. */
	timedOutAction?: number;
}

function normalizedLabel(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A region whose text can no longer be attributed to a readable node; keeps only status and detail. */
function redactedRegion(region: NoteRegion): NoteRegion {
	return {
		key: REDACTED_KEY,
		label: REDACTED_LABEL,
		status: region.status,
		...(region.detail === undefined ? {} : { detail: region.detail }),
	};
}

function regionKey(node: OutlineNode): string {
	return `${node.role || "AXUnknown"}:${node.identifier || regionLabel(node)}`;
}

/**
 * A protected node is noted only by its marker, never its title. Any other node falls back to its role, which a
 * readable node always has: `isProtectedNode` counts a blank role as unclassified.
 */
function regionLabel(node: OutlineNode): string {
	if (isProtectedNode(node)) return PROTECTED_LABEL;
	return normalizedLabel(outlineNodeLabel(node)) || normalizedLabel(node.role);
}

/**
 * Re-check every region against `outline`'s current classification. A region keeps its label only while its node is
 * present and readable; a protected node's region takes its current marker, and an absent or unattributed node's
 * region is redacted. Root and window regions carry no outline text and pass through. Returns a new note.
 */
export function noteForOutline(note: WindowNote | undefined, outline: Outline): WindowNote | undefined {
	if (!note) return undefined;
	const regions = note.regions.map((region): NoteRegion => {
		if (region.key === REDACTED_KEY || NON_OUTLINE_KEY.test(region.key)) return region;
		const node = region.ref ? nodeByRef(outline, region.ref) : undefined;
		if (!node) return redactedRegion(region);
		if (!isProtectedNode(node)) return region;
		return { ...region, key: regionKey(node), label: regionLabel(node) };
	});
	return { ...note, regions: uniqueRegions(regions) };
}

function topLevelRegions(outline: Outline): Array<{ node: OutlineNode; key: string; label: string }> {
	const nodes = outline.root.children.length ? outline.root.children : [outline.root];
	return nodes.map((node) => ({ node, key: regionKey(node), label: regionLabel(node) }));
}

function topLevelAncestor(node: OutlineNode, outline: Outline): OutlineNode {
	let current = node;
	while (current.parent && current.parent !== outline.root) current = current.parent;
	return current;
}

function uniqueRegions(regions: NoteRegion[]): NoteRegion[] {
	const seen = new Set<string>();
	const output: NoteRegion[] = [];
	for (const region of regions) {
		const dedupeKey = `${region.key}:${region.status}:${region.detail ?? ""}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		output.push(region);
	}
	return output;
}

function frontierRegions(
	outline: Outline,
	topLevels: Array<{ node: OutlineNode; key: string; label: string }>,
): NoteRegion[] {
	const output: NoteRegion[] = [];
	for (const node of outline.nodes) {
		if (node.scrollExtent && node.scrollExtent.seen < node.scrollExtent.total) {
			const ancestor = topLevelAncestor(node, outline);
			const top = topLevels.find((candidate) => candidate.node === ancestor);
			output.push({
				key: `${top?.key ?? regionKey(ancestor)}:scroll:${node.ref}`,
				label: top?.label ?? regionLabel(ancestor),
				status: "never-looked",
				detail: `${node.scrollExtent.total} rows, ${node.scrollExtent.seen} seen`,
				ref: ancestor.ref,
			});
		}
		if (node.truncated) {
			const ancestor = topLevelAncestor(node, outline);
			const top = topLevels.find((candidate) => candidate.node === ancestor);
			output.push({
				key: `${top?.key ?? regionKey(ancestor)}:truncated:${node.ref}`,
				label: top?.label ?? regionLabel(ancestor),
				status: "never-looked",
				detail: "subtree not walked",
				ref: ancestor.ref,
			});
		}
	}
	return output;
}

export function noteFromLook(prev: WindowNote | undefined, outline: Outline, window: NoteWindowInput): WindowNote {
	const topLevels = topLevelRegions(outline);
	const currentKeys = new Set(topLevels.map((region) => region.key));
	const regions: NoteRegion[] = topLevels.map((region) => ({
		key: region.key,
		label: region.label,
		status: "seen",
		ref: region.node.ref,
	}));

	if (prev) {
		for (const old of prev.regions) {
			if (old.status === "never-looked") continue;
			// Unmatched means this look cannot say whether the node is still readable: keep the change, not its text.
			if (!currentKeys.has(old.key))
				regions.push(redactedRegion({ ...old, status: "changed", detail: "not matched in latest look" }));
		}
	}

	if (!window.windowRef || window.pairingScore === Number.NEGATIVE_INFINITY) {
		regions.push({
			key: "window:unpaired",
			label: "window capture",
			status: "never-looked",
			detail: "AX window without capture pairing",
		});
	}

	regions.push(...frontierRegions(outline, topLevels));

	return {
		windowRef: window.windowRef ?? "(unpaired)",
		title: window.title,
		pairing: window.pairing ?? "low",
		lastLookId: outline.lookId,
		regions: uniqueRegions(regions),
	};
}

export function noteAfterAct(
	prev: WindowNote | undefined,
	targetRef: string | undefined,
	outline: Outline,
	refreshOutcome: NoteRefreshOutcome,
): WindowNote {
	const note = noteFromLook(prev, outline, refreshOutcome.window);
	if (targetRef) {
		const target = nodeByRef(outline, targetRef);
		if (target) {
			const ancestor = topLevelAncestor(target, outline);
			const key = regionKey(ancestor);
			const region = note.regions.find((candidate) => candidate.key === key);
			const detail =
				refreshOutcome.timedOutAction === undefined
					? "acted here"
					: `acted here; delivery unknown (action ${refreshOutcome.timedOutAction} timed out)`;
			if (region) {
				region.status = "changed";
				region.detail = detail;
			} else {
				note.regions.unshift({
					key,
					label: regionLabel(ancestor),
					status: "changed",
					detail,
					ref: ancestor.ref,
				});
			}
		}
	}
	for (const delta of refreshOutcome.rootDelta ?? []) {
		note.regions.unshift({
			key: `root:${delta.change}:${delta.ref ?? delta.kind}:${delta.title ?? ""}`,
			label: `${delta.kind}${delta.title ? ` ${delta.title}` : ""}`,
			status: delta.change === "closed" ? "changed" : "never-looked",
			detail: `root ${delta.change}`,
		});
	}
	if (refreshOutcome.windowChanged) {
		for (const region of note.regions) {
			if (region.status === "seen") region.status = "changed";
		}
		note.regions.push({
			key: `window:changed:${note.lastLookId ?? "unknown"}`,
			label: refreshOutcome.newWindowLabel ?? "new sheet/window",
			status: "never-looked",
			detail: "appeared after act",
		});
	}
	return { ...note, regions: uniqueRegions(note.regions) };
}

export function noteRegionKeyForRef(outline: Outline, ref: string): string | undefined {
	const node = nodeByRef(outline, ref);
	return node ? regionKey(topLevelAncestor(node, outline)) : undefined;
}

export function renderNote(note: WindowNote | undefined): string {
	if (!note) return "";
	const looked = note.lastLookId ? "looked just now" : "not looked";
	const lines = [
		`note ${note.windowRef} ${JSON.stringify(note.title.slice(0, 512))} (pairing ${note.pairing}, ${looked})`,
	];
	const visible = note.regions.slice(0, 64);
	for (const region of visible) {
		const detail = region.detail ? `   (${region.detail.slice(0, 256)})` : "";
		lines.push(`  ${region.label.slice(0, 512).padEnd(14, " ")} ${region.status}${detail}`);
	}
	if (note.regions.length > visible.length)
		lines.push(`  … ${note.regions.length - visible.length} more note regions; use search_ui or expand_ui`);
	const encoded = new TextEncoder().encode(lines.join("\n"));
	if (encoded.byteLength <= 8 * 1024) return new TextDecoder().decode(encoded);
	let end = 8 * 1024;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return `${new TextDecoder().decode(encoded.subarray(0, end))}\n… note byte budget reached`;
}
