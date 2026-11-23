import {
	isConfirmedReadable,
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
	/**
	 * Where the label came from. `node` labels are rebuilt from the current outline on every cached query; `root`
	 * (root listings) and `window` (capture pairing) labels carry no outline text. A region without `source` predates
	 * provenance: it is reclassified when it has a `ref` and redacted otherwise, whatever its key says.
	 */
	source?: "node" | "root" | "window" | "redacted";
	/** Top-level outline node the label was read from; only `node` regions carry one. */
	ref?: string;
	/** Key suffix that tells a node's frontier regions apart, e.g. `scroll:@e7`. */
	facet?: string;
}

/** Key shared by every redacted region, so retained history collapses instead of growing. */
const REDACTED_KEY = "redacted";

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
	/** Why the acted action's delivery is unknown, e.g. `action 1 timed out`; absent when it is not. */
	unknownDelivery?: string;
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
		source: "redacted",
		...(region.detail === undefined ? {} : { detail: region.detail }),
	};
}

/** Keys and labels of a node that is not confirmed readable carry only its role and marker, never an identifier. */
function regionKey(node: OutlineNode): string {
	const name = isConfirmedReadable(node) ? node.identifier || regionLabel(node) : regionLabel(node);
	return `${node.role || "AXUnknown"}:${name}`;
}

/**
 * A protected node is noted only by its marker, never its title; an unconfirmed node's title is already the redaction
 * marker. Any other node falls back to its role, which a readable node always has: `isProtectedNode` counts a blank
 * role as unclassified.
 */
function regionLabel(node: OutlineNode): string {
	if (isProtectedNode(node)) return PROTECTED_LABEL;
	return normalizedLabel(outlineNodeLabel(node)) || normalizedLabel(node.role);
}

/** A `node` region for `node`, its key and label built from the node as it is now. */
function nodeRegion(node: OutlineNode, region: Omit<NoteRegion, "key" | "label" | "source" | "ref">): NoteRegion {
	return {
		key: region.facet ? `${regionKey(node)}:${region.facet}` : regionKey(node),
		label: regionLabel(node),
		...region,
		source: "node",
		ref: node.ref,
	};
}

/**
 * Rebuild every region from `outline`'s current nodes. A region's text never comes from the saved note: a `node`
 * region takes the key and label of the node now at its ref, which reads `[protected]` or `[redacted]` when that node
 * is protected or unconfirmed, and a region whose node is gone is redacted. Root and window regions carry no outline
 * text and pass through. A legacy region without provenance fails closed: reclassified by its ref, else redacted.
 * Returns a new note.
 */
export function noteForOutline(note: WindowNote | undefined, outline: Outline): WindowNote | undefined {
	if (!note) return undefined;
	const regions = note.regions.map((region): NoteRegion => {
		if (region.source === "root" || region.source === "window") return region;
		const node = region.source !== "redacted" && region.ref ? nodeByRef(outline, region.ref) : undefined;
		if (!node) return redactedRegion(region);
		const { key: _key, label: _label, source: _source, ref: _ref, ...rest } = region;
		return nodeRegion(node, rest);
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

function frontierRegions(outline: Outline): NoteRegion[] {
	const output: NoteRegion[] = [];
	for (const node of outline.nodes) {
		if (node.scrollExtent && node.scrollExtent.seen < node.scrollExtent.total) {
			const ancestor = topLevelAncestor(node, outline);
			output.push(
				nodeRegion(ancestor, {
					status: "never-looked",
					detail: `${node.scrollExtent.total} rows, ${node.scrollExtent.seen} seen`,
					facet: `scroll:${node.ref}`,
				}),
			);
		}
		if (node.truncated) {
			const ancestor = topLevelAncestor(node, outline);
			output.push(
				nodeRegion(ancestor, { status: "never-looked", detail: "subtree not walked", facet: `truncated:${node.ref}` }),
			);
		}
	}
	return output;
}

export function noteFromLook(prev: WindowNote | undefined, outline: Outline, window: NoteWindowInput): WindowNote {
	const topLevels = topLevelRegions(outline);
	const currentKeys = new Set(topLevels.map((region) => region.key));
	const regions: NoteRegion[] = topLevels.map((region) => nodeRegion(region.node, { status: "seen" }));

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
			source: "window",
		});
	}

	regions.push(...frontierRegions(outline));

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
				refreshOutcome.unknownDelivery === undefined
					? "acted here"
					: `acted here; delivery unknown (${refreshOutcome.unknownDelivery})`;
			if (region) {
				region.status = "changed";
				region.detail = detail;
			} else {
				note.regions.unshift(nodeRegion(ancestor, { status: "changed", detail }));
			}
		}
	}
	for (const delta of refreshOutcome.rootDelta ?? []) {
		note.regions.unshift({
			key: `root:${delta.change}:${delta.ref ?? delta.kind}:${delta.title ?? ""}`,
			label: `${delta.kind}${delta.title ? ` ${delta.title}` : ""}`,
			status: delta.change === "closed" ? "changed" : "never-looked",
			detail: `root ${delta.change}`,
			source: "root",
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
			source: "window",
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
