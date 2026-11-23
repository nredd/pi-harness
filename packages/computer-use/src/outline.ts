export interface OutlineRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OutlineText {
	string: string;
	confidence: number;
	rect?: OutlineRect;
	/**
	 * `value` when the helper derived the box from the node's own AX value instead of pixels (the Linux helper, see
	 * `ParseLookOptions.ownValueText`). Anything else, including a missing tag, is OCR.
	 */
	source?: "value";
}

export interface OutlineScrollExtent {
	seen: number;
	total: number;
}

export interface OutlineNode {
	ref: string;
	wireRef?: string;
	role: string;
	subrole: string;
	identifier: string;
	title: string;
	description: string;
	value: string;
	actions: string[];
	canPress: boolean;
	canFocus: boolean;
	canSetValue: boolean;
	canScroll: boolean;
	canIncrement: boolean;
	canDecrement: boolean;
	isTextInput: boolean;
	rect?: OutlineRect;
	focused: boolean;
	offscreen: boolean;
	pictureOnly: boolean;
	truncated: boolean;
	/**
	 * Set only on a `truncated` node whose helper read its own fields and left only its descendants unread (the macOS
	 * walk's failed children read or budget cut). A bare `truncated` (Linux unread fields, Windows, older helpers)
	 * may also mean the node's own fields are unread.
	 */
	childrenUnread?: true;
	scrollExtent?: OutlineScrollExtent;
	text: OutlineText[];
	/**
	 * Set when a later look could not confirm this node is still readable (a scoped graft that saw protection, or a
	 * newer look of the same root). Its text is already redacted; keep only its ref, role and geometry.
	 */
	unconfirmed?: true;
	children: OutlineNode[];
	parent?: OutlineNode;
}

export interface Outline {
	lookId: string;
	root: OutlineNode;
	nodes: OutlineNode[];
	refToWireRef: Map<string, string>;
	wireRefToRef: Map<string, string>;
	/**
	 * Highest `@e<n>` ref number a graft has issued. It never decreases, so a ref a graft dropped is never reissued
	 * to another element under the same `stateId`; absent, the highest ref in `nodes` counts (#1349).
	 */
	refHighWater?: number;
}

export interface LookImage {
	jpegBase64: string;
	mimeType?: "image/jpeg" | "image/png";
	width: number;
	height: number;
}

export interface LookWindow {
	windowId: number;
	rootRef?: string;
	kind?: string;
	framePoints: OutlineRect;
	scaleFactor: number;
	isModal: boolean;
	metadata?: Record<string, unknown>;
	role: string;
	subrole: string;
}

export interface LookResponse {
	lookId: string;
	capturedAt: number;
	window: LookWindow;
	image?: LookImage;
	outline: OutlineNode;
	timings: Record<string, number>;
	readText?: { requested?: "auto" | "always" | "never"; executed: boolean };
	parsedOutline?: Outline;
}

export interface OutlineSearchMatch {
	ref: string;
	role: string;
	label: string;
	actions: string[];
	path: string;
	matchReason?: "exact" | "prefix" | "substring" | "fuzzy" | "filter";
	score?: number;
	node: OutlineNode;
}

export type SerializedOutlineSearchMatch = Omit<OutlineSearchMatch, "node"> & { node?: never };

export interface FoldResult {
	text: string;
	renderedRefs: string[];
	nodeCount: number;
	fullUnfoldLineCount: number;
	truncated: boolean;
}

export type OutlineChange =
	| { type: "added"; ref: string; parent?: string; node: SerializedOutlineNode }
	| { type: "updated"; ref: string; path: string[]; fields: Partial<Omit<SerializedOutlineNode, "children">> }
	| { type: "removed"; ref: string; parent?: string };

export interface OutlineDiff {
	changes: OutlineChange[];
	changedNodeCount: number;
	fullNodeCount: number;
	useFullView: boolean;
	reason?: "root_replaced" | "change_budget_exceeded" | "identity_confidence_low";
}

export type SerializedOutlineNode = Omit<OutlineNode, "parent" | "children"> & { children: SerializedOutlineNode[] };

/**
 * Stored outline format. Version 1 is the first writer that never invents a rect origin and filters OCR over
 * unreadable nodes (#1263). An outline without it predates that writer: its rects may carry a made-up `x: 0`/`y: 0`.
 */
export const OUTLINE_FORMAT_VERSION = 1;

export interface SerializedOutline {
	lookId: string;
	root: SerializedOutlineNode;
	/** `OUTLINE_FORMAT_VERSION` of the writer; missing on outlines stored before it. */
	formatVersion?: number;
	/** See `Outline.refHighWater`; missing on outlines stored before it or never grafted. */
	refHighWater?: number;
}

export interface ControlsResult {
	text: string;
	renderedRefs: string[];
	controlCount: number;
	nodeCount: number;
	omittedUnlabeled: number;
	truncated: boolean;
}

export const INCIDENTAL_ACTIONS = new Set(["AXShowMenu", "AXScrollToVisible"]);

const DEFAULT_BUDGET = { maxDepth: 2, maxNodes: 150 };

/** Name the Linux helper substitutes for a protected or unclassified node (`PROTECTED_LABEL` in `atspi.rs`). */
export const PROTECTED_LABEL = "[protected]";

/** Placeholder for text retained from an earlier look whose node is no longer confirmed readable. */
export const REDACTED_LABEL = "[redacted]";

/** macOS secure fields, the Linux helper's protected role names and the Windows missing-role default. */
const PROTECTED_ROLES = new Set(["axsecuretextfield", "password text", "unknown", ""]);

/**
 * Whether `node`'s current classification forbids echoing text it carried earlier. Fails closed: a node with no
 * role, or one the helper could not classify, counts as protected.
 */
export function isProtectedNode(node: Pick<OutlineNode, "role" | "subrole" | "title" | "description">): boolean {
	// `restoreOutline` normalizes untrusted JSON, so both fields are always strings here.
	return (
		PROTECTED_ROLES.has(node.role.trim().toLowerCase()) ||
		node.subrole.trim().toLowerCase() === "axsecuretextfield" ||
		node.title === PROTECTED_LABEL ||
		node.description === PROTECTED_LABEL
	);
}

/**
 * Allowlist a protected node's metadata: keep its classification (role, subrole), ref, geometry and capabilities,
 * and replace every text field with the marker. AX titles, descriptions and identifiers can still hold the text an
 * older or faulty helper sent, so nothing untrusted reaches indexing, search, diffs or serialization. Mutates `node`.
 */
function sanitizeProtected(node: OutlineNode): OutlineNode {
	if (isProtectedNode(node)) {
		node.title = PROTECTED_LABEL;
		node.description = "";
		node.identifier = "";
		node.value = "";
		node.text = [];
	}
	return node;
}

/**
 * Replace every text field of `node` that an earlier, unconfirmed look supplied, identifier included (it can be the
 * old displayed label), and mark it unconfirmed. Refs, role and geometry stay so the node is still addressable.
 * Mutates `node`.
 */
function redactRetained(node: OutlineNode): void {
	node.title = REDACTED_LABEL;
	node.description = "";
	node.identifier = "";
	node.value = "";
	node.text = [];
	node.unconfirmed = true;
}

/** Whether a cached query may echo `node`'s text: it is readable and no scoped graft redacted it. */
export function isConfirmedReadable(node: OutlineNode): boolean {
	return !node.unconfirmed && !isProtectedNode(node);
}

/**
 * Whether OCR may not be placed over `node`: it is protected or unconfirmed, or unread (`truncated`), so an unseen
 * descendant such as a secure field can sit anywhere in its rect.
 */
function coversUnreadablePixels(node: OutlineNode): boolean {
	return !isConfirmedReadable(node) || node.truncated;
}

/**
 * Whether `rect` is a known region with positive area. Parse and restore keep only rects whose four fields are finite
 * numbers, so anything else is already `undefined` here.
 */
function hasArea(rect: OutlineRect | undefined): rect is OutlineRect {
	return rect !== undefined && rect.w > 0 && rect.h > 0;
}

function overlaps(a: OutlineRect, b: OutlineRect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function encloses(outer: OutlineRect, inner: OutlineRect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

function isAncestor(candidate: OutlineNode, node: OutlineNode): boolean {
	for (let current = node.parent; current; current = current.parent) if (current === candidate) return true;
	return false;
}

function collectNodes(root: OutlineNode): OutlineNode[] {
	const nodes = [root];
	// The array iterator re-reads `length`, so pushed children are visited too.
	for (const node of nodes) nodes.push(...node.children);
	return nodes;
}

/** Replace a picture-only node's title (OCR text) with the marker; it then counts as protected. Mutates `node`. */
function redactPicture(node: OutlineNode): void {
	node.title = PROTECTED_LABEL;
	sanitizeProtected(node);
}

/**
 * Drop text that may show the pixels of a protected, unconfirmed or unread node (#1263): a `text` box on another
 * node, or a picture-only node (whose title is OCR text), that overlaps such a node's rect. Fails closed: when any such
 * node has no known area, every box and picture-only title goes, and while one exists a box with no known area goes
 * too. The one exception is trusted provenance: a box the Linux helper derived from its readable node's own AX value
 * (`source: "value"` and the same string), enclosed by that node's rect, under the protected ancestor. A redacted
 * picture-only node is itself protected, so its region joins the worklist; a versioned restore therefore gives the same result.
 * `legacy` (an outline stored before `OUTLINE_FORMAT_VERSION`, whose rects may have invented origins) treats every
 * region as unknown, so any unreadable node drops all of it. Mutates the tree.
 */
function dropTextOverProtected(root: OutlineNode, legacy = false): void {
	const nodes = collectNodes(root);
	const regions: Array<{ node: OutlineNode; rect: OutlineRect }> = [];
	let unknownRegion = false;
	const addRegion = (node: OutlineNode): void => {
		if (hasArea(node.rect)) regions.push({ node, rect: node.rect });
		else unknownRegion = true;
	};
	for (const node of nodes) if (coversUnreadablePixels(node)) addRegion(node);
	if (!regions.length && !unknownRegion) return;
	if (legacy) unknownRegion = true;

	const mustDropBox = (owner: OutlineNode, text: OutlineText): boolean => {
		const box = text.rect;
		return (
			unknownRegion ||
			!hasArea(box) ||
			regions.some(({ node, rect }) => overlaps(rect, box) && !isOwnValueText(owner, text, box, node))
		);
	};

	// Picture-only closure as a worklist: a redacted picture-only node is a new region, which may expose another. A
	// truncated picture-only node is its own region and overlaps it, so its title goes too; a redacted one is no longer
	// readable, so it is never checked against the region it added.
	const pictures = nodes.filter((node) => node.pictureOnly && isConfirmedReadable(node));
	for (let index = 0; index < regions.length && !unknownRegion; index += 1) {
		const region = regions[index];
		for (const picture of pictures) {
			if (isConfirmedReadable(picture) && (!hasArea(picture.rect) || overlaps(region.rect, picture.rect))) {
				redactPicture(picture);
				addRegion(picture);
			}
		}
	}
	// Redacting twice is harmless, so pictures the closure already redacted need no check.
	if (unknownRegion) for (const picture of pictures) redactPicture(picture);
	for (const node of nodes)
		if (isConfirmedReadable(node)) node.text = node.text.filter((text) => !mustDropBox(node, text));
}

/**
 * Whether `text` is `owner`'s own AX value placed inside `owner`'s rect under the unreadable `region` ancestor. Only
 * the Linux helper tags boxes `source: "value"`, and the string must still equal the node's value.
 */
function isOwnValueText(owner: OutlineNode, text: OutlineText, box: OutlineRect, region: OutlineNode): boolean {
	return (
		text.source === "value" &&
		text.string === owner.value &&
		hasArea(owner.rect) &&
		isAncestor(region, owner) &&
		encloses(owner.rect, box)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function toBoolean(value: unknown): boolean {
	return value === true;
}

function parseRect(raw: unknown): OutlineRect {
	const rect = isRecord(raw) ? raw : {};
	return {
		x: toNumber(rect.x),
		y: toNumber(rect.y),
		w: Math.max(0, toNumber(rect.w)),
		h: Math.max(0, toNumber(rect.h)),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read an outline or text rect, or `undefined` when any of its four fields is missing or not a finite number.
 * Never invent an origin: a placed-looking region at a made-up position would let OCR text over a protected node
 * escape the overlap check (#1263). A negative size reads as zero, which has no area.
 */
function readRect(raw: unknown): OutlineRect | undefined {
	if (!isRecord(raw) || ![raw.x, raw.y, raw.w, raw.h].every(isFiniteNumber)) return undefined;
	const { x, y, w, h } = raw as Record<keyof OutlineRect, number>;
	return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Read one text box. `ownValueOf` is the node's own AX value when its helper derives boxes from it (Linux); only a
 * box with exactly that string is tagged `source: "value"`, every other box is OCR.
 */
function readText(item: unknown, ownValueOf?: string): OutlineText | undefined {
	if (!isRecord(item)) return undefined;
	const string = toString(item.string);
	if (!string) return undefined;
	const text: OutlineText = { string, confidence: Math.max(0, Math.min(1, toNumber(item.confidence))) };
	const rect = readRect(item.rect);
	if (rect) text.rect = rect;
	if (ownValueOf === string) text.source = "value";
	return text;
}

function parseText(raw: unknown, ownValueOf?: string): OutlineText[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((item) => readText(item, ownValueOf)).filter((item): item is OutlineText => Boolean(item));
}

/** How a backend's look payload is read. */
export interface ParseLookOptions {
	/**
	 * Read a node without a boolean `truncated` marker as unread. Set only for a backend whose helper
	 * always emits the marker and can return partial trees (Linux AT-SPI2), so an omitted marker is
	 * unknown completeness, not proof the node was fully read.
	 */
	unmarkedNodesUnread?: boolean;
	/**
	 * The helper's `text` boxes repeat the node's own AX value rather than OCR (Linux AT-SPI2). A box whose string
	 * equals the node's value is tagged `source: "value"` and may sit inside a protected ancestor's rect.
	 */
	ownValueText?: boolean;
}

function parseNode(raw: unknown, options: ParseLookOptions, parent?: OutlineNode): OutlineNode {
	const record = isRecord(raw) ? raw : {};
	const wireRef = toString(record.ref) || undefined;
	const node: OutlineNode = {
		ref: "",
		wireRef,
		role: toString(record.role),
		subrole: toString(record.subrole),
		identifier: toString(record.identifier),
		title: toString(record.title),
		description: toString(record.description),
		value: toString(record.value),
		actions: Array.isArray(record.actions)
			? record.actions.filter((value): value is string => typeof value === "string")
			: [],
		canPress: toBoolean(record.canPress),
		canFocus: toBoolean(record.canFocus),
		canSetValue: toBoolean(record.canSetValue),
		canScroll: toBoolean(record.canScroll),
		canIncrement: toBoolean(record.canIncrement),
		canDecrement: toBoolean(record.canDecrement),
		isTextInput: toBoolean(record.isTextInput),
		rect: readRect(record.rect),
		focused: toBoolean(record.focused),
		offscreen: toBoolean(record.offscreen),
		pictureOnly: toBoolean(record.pictureOnly),
		truncated:
			options.unmarkedNodesUnread && typeof record.truncated !== "boolean" ? true : toBoolean(record.truncated),
		scrollExtent: isRecord(record.scrollExtent)
			? {
					seen: Math.max(0, Math.trunc(toNumber(record.scrollExtent.seen))),
					total: Math.max(0, Math.trunc(toNumber(record.scrollExtent.total))),
				}
			: undefined,
		text: parseText(record.text, options.ownValueText ? toString(record.value) : undefined),
		children: [],
		parent,
	};
	if (!node.rect) delete node.rect;
	if (record.truncated === true && record.childrenUnread === true) node.childrenUnread = true;
	node.children = (Array.isArray(record.children) ? record.children : []).map((child) =>
		parseNode(child, options, node),
	);
	return sanitizeProtected(node);
}

export function parseLookResponse(raw: unknown, options: ParseLookOptions = {}): LookResponse {
	const record = isRecord(raw) ? raw : {};
	const image = isRecord(record.image) ? record.image : undefined;
	const window = isRecord(record.window) ? record.window : {};
	const metadata = isRecord(window.metadata) ? window.metadata : undefined;
	const root = parseNode(record.outline, options);
	dropTextOverProtected(root);
	const outline = buildOutline(toString(record.lookId), root);
	const readText = isRecord(record.readText) ? record.readText : undefined;
	const requestedReadText =
		readText?.requested === "auto" || readText?.requested === "always" || readText?.requested === "never"
			? readText.requested
			: undefined;
	const look: LookResponse = {
		lookId: toString(record.lookId),
		capturedAt: toNumber(record.capturedAt, Date.now() / 1000),
		window: {
			windowId: Math.trunc(toNumber(window.windowId)),
			rootRef: toString(window.rootRef) || undefined,
			kind: toString(window.kind) || undefined,
			framePoints: parseRect(window.framePoints),
			scaleFactor: Math.max(1, toNumber(window.scaleFactor, 1)),
			isModal: toBoolean(window.isModal),
			metadata,
			role: toString(window.role),
			subrole: toString(window.subrole),
		},
		image: image
			? {
					jpegBase64: toString(image.jpegBase64),
					mimeType: image.mimeType === "image/png" ? "image/png" : "image/jpeg",
					width: Math.max(1, Math.trunc(toNumber(image.width, 1))),
					height: Math.max(1, Math.trunc(toNumber(image.height, 1))),
				}
			: undefined,
		outline: outline.root,
		timings: isRecord(record.timings)
			? Object.fromEntries(Object.entries(record.timings).map(([key, value]) => [key, toNumber(value)]))
			: {},
		readText: readText ? { requested: requestedReadText, executed: toBoolean(readText.executed) } : undefined,
		parsedOutline: outline,
	};
	if (!look.lookId) throw new Error("Helper returned a look without lookId.");
	return look;
}

function buildOutline(lookId: string, root: OutlineNode): Outline {
	const nodes: OutlineNode[] = [];
	const refToWireRef = new Map<string, string>();
	const wireRefToRef = new Map<string, string>();
	const queue = [root];
	let index = 0;
	while (index < queue.length) {
		const node = queue[index++];
		node.ref = `@e${nodes.length + 1}`;
		nodes.push(node);
		if (node.wireRef) {
			refToWireRef.set(node.ref, node.wireRef);
			wireRefToRef.set(node.wireRef, node.ref);
		}
		queue.push(...node.children);
	}
	return { lookId, root, nodes, refToWireRef, wireRefToRef };
}

export function nodeByRef(outline: Outline, ref: string): OutlineNode | undefined {
	return outline.nodes.find((node) => node.ref === ref || node.wireRef === ref);
}

export function outlineNodeLabel(node: OutlineNode): string {
	return (
		node.title ||
		node.description ||
		node.value ||
		node.identifier ||
		node.text
			.map((item) => item.string)
			.join(" ")
			.trim()
	);
}

function displayName(node: OutlineNode): string {
	const label = outlineNodeLabel(node);
	return `${node.role || "AXUnknown"}${node.subrole ? `/${node.subrole}` : ""}${label ? ` ${JSON.stringify(label)}` : ""}`;
}

export function outlineNodePath(node: OutlineNode): string {
	const parts: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		parts.unshift(displayName(current));
		current = current.parent;
	}
	return parts.join(" ▸ ");
}

function countDescendants(node: OutlineNode): { total: number; roles: Map<string, number>; pictureOnly: number } {
	const roles = new Map<string, number>();
	let total = 0;
	let pictureOnly = 0;
	const visit = (current: OutlineNode) => {
		for (const child of current.children) {
			total += 1;
			if (child.pictureOnly) pictureOnly += 1;
			const role = child.pictureOnly ? "picture-only" : roleName(child.role);
			roles.set(role, (roles.get(role) ?? 0) + 1);
			visit(child);
		}
	};
	visit(node);
	return { total, roles, pictureOnly };
}

function roleName(role: string): string {
	const stripped = role.replace(/^AX/, "").toLowerCase();
	return stripped || "node";
}

function plural(count: number, singular: string): string {
	if (singular === "picture-only") return "picture-only";
	return `${singular}${count === 1 ? "" : "s"}`;
}

function foldedSummary(node: OutlineNode): string {
	const counts = countDescendants(node);
	const roleCounts = [...counts.roles.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([role, count]) => `${count} ${plural(count, role)}`);
	const countText = `${counts.total}: ${roleCounts.join(", ")}`;
	const scroll = node.scrollExtent ? ` [scrollable ${node.scrollExtent.seen}/${node.scrollExtent.total}]` : "";
	return ` ▸ (${countText})${scroll}`;
}

function annotationText(node: OutlineNode): string {
	const annotations = [
		node.offscreen ? "offscreen" : undefined,
		node.pictureOnly ? "pictureOnly" : undefined,
		node.truncated ? "truncated" : undefined,
		node.scrollExtent ? `scrollable ${node.scrollExtent.seen}/${node.scrollExtent.total}` : undefined,
	].filter((item): item is string => Boolean(item));
	return annotations.length ? ` [${annotations.join(", ")}]` : "";
}

function lineForNode(node: OutlineNode, depth: number, folded: boolean): string {
	const actions = node.actions.length ? ` {${node.actions.join(",")}}` : "";
	return `${"  ".repeat(depth)}${node.ref} ${displayName(node)}${actions}${annotationText(node)}${folded ? foldedSummary(node) : ""}`;
}

function pathRefs(node: OutlineNode): string[] {
	const refs: string[] = [];
	let current: OutlineNode | undefined = node;
	while (current) {
		refs.unshift(current.ref);
		current = current.parent;
	}
	return refs;
}

function defaultUnfoldAnchors(outline: Outline): OutlineNode[] {
	return outline.nodes.filter(
		(node) =>
			node.truncated ||
			node.focused ||
			node.parent?.role === "AXSheet" ||
			node.role === "AXSheet" ||
			node.role === "AXDialog",
	);
}

function defaultUnfoldRefs(outline: Outline): Set<string> {
	const refs = new Set<string>([outline.root.ref]);
	for (const node of defaultUnfoldAnchors(outline)) {
		for (const ref of pathRefs(node)) refs.add(ref);
		if (node.focused) for (const child of node.children) refs.add(child.ref);
	}
	return refs;
}

export function foldToBudget(
	outline: Outline,
	budget: Partial<typeof DEFAULT_BUDGET> = {},
	unfoldPaths: string[] = [],
): FoldResult {
	const maxDepth = Math.max(0, Math.trunc(budget.maxDepth ?? DEFAULT_BUDGET.maxDepth));
	const maxNodes = Math.max(1, Math.trunc(budget.maxNodes ?? DEFAULT_BUDGET.maxNodes));
	const unfolded = defaultUnfoldRefs(outline);
	for (const ref of unfoldPaths) {
		const node = nodeByRef(outline, ref);
		if (!node) continue;
		for (const pathRef of pathRefs(node)) unfolded.add(pathRef);
		for (const child of node.children) unfolded.add(child.ref);
	}

	const lines: string[] = [];
	const renderedRefs: string[] = [];
	let truncated = false;
	const render = (node: OutlineNode, depth: number) => {
		if (lines.length >= maxNodes) {
			truncated = true;
			return;
		}
		const shouldUnfold = depth < maxDepth || unfolded.has(node.ref);
		const folded = node.children.length > 0 && !shouldUnfold;
		lines.push(lineForNode(node, depth, folded));
		renderedRefs.push(node.ref);
		if (folded) return;
		for (const child of node.children) render(child, depth + 1);
	};
	render(outline.root, 0);
	if (truncated) {
		const remaining = Math.max(0, outline.nodes.length - renderedRefs.length);
		lines.push(`… render budget reached: ${remaining} more nodes not shown; use search_ui or expand_ui(@eN)`);
	}
	return {
		text: lines.join("\n"),
		renderedRefs,
		nodeCount: outline.nodes.length,
		fullUnfoldLineCount: outline.nodes.length,
		truncated,
	};
}

export function isInteractiveControl(node: OutlineNode): boolean {
	if (node.pictureOnly) return false;
	return (
		node.canPress ||
		node.canSetValue ||
		node.isTextInput ||
		node.canIncrement ||
		node.canDecrement ||
		node.actions.some((action) => !INCIDENTAL_ACTIONS.has(action))
	);
}

export function controlLine(node: OutlineNode): string {
	const label = outlineNodeLabel(node);
	const value =
		node.value && node.value !== label
			? ` = ${JSON.stringify(node.value.length > 40 ? `${node.value.slice(0, 40)}…` : node.value)}`
			: "";
	const states = [node.focused ? "focused" : undefined, node.offscreen ? "offscreen" : undefined].filter(Boolean);
	return `${node.ref} ${roleName(node.role)} ${JSON.stringify(label)}${value}${states.length ? ` [${states.join(", ")}]` : ""}`;
}

function closestListedLabel(node: OutlineNode, listed: Set<OutlineNode>): string | undefined {
	for (let current = node.parent; current; current = current.parent) {
		if (listed.has(current)) return outlineNodeLabel(current);
	}
	return undefined;
}

export function renderInteractiveControls(outline: Outline, maxControls = DEFAULT_BUDGET.maxNodes): ControlsResult {
	const anchors = new Set(defaultUnfoldAnchors(outline));
	const insideAnchor = (node: OutlineNode): boolean =>
		anchors.has(node) || (node.parent !== undefined && insideAnchor(node.parent));
	const listed = new Set<OutlineNode>();
	let omittedUnlabeled = 0;
	const visit = (node: OutlineNode) => {
		const label = outlineNodeLabel(node);
		const control = isInteractiveControl(node);
		if (control && !label && !node.isTextInput && !node.focused) omittedUnlabeled += 1;
		else if (node.focused || (control && label !== closestListedLabel(node, listed))) listed.add(node);
		for (const child of node.children) visit(child);
	};
	visit(outline.root);
	const rank = new Map([...listed].map((node) => [node, node.focused ? 0 : insideAnchor(node) ? 1 : 2]));
	const controls = [...listed].sort((a, b) => rank.get(a)! - rank.get(b)!);
	const shown = controls.slice(0, maxControls);
	const lines = shown.map(controlLine);
	const truncated = shown.length < controls.length;
	if (truncated)
		lines.push(
			`… render budget reached: ${controls.length - shown.length} more controls not shown; use search_ui or expand_ui(@eN)`,
		);
	return {
		text: lines.join("\n"),
		renderedRefs: shown.map((node) => node.ref),
		controlCount: controls.length,
		nodeCount: outline.nodes.length,
		omittedUnlabeled,
		truncated,
	};
}

function actionMatches(node: OutlineNode, action: string): boolean {
	const query = action.toLowerCase();
	if (query === "press" && node.canPress) return true;
	if (query === "focus" && node.canFocus) return true;
	if ((query === "setvalue" || query === "set_text" || query === "settext") && node.canSetValue) return true;
	if (query === "scroll" && node.canScroll) return true;
	if (query === "increment" && node.canIncrement) return true;
	if (query === "decrement" && node.canDecrement) return true;
	return node.actions.some((candidate) => candidate.toLowerCase().includes(query));
}

function normalizedSearchRole(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^ax/, "")
		.replace(/[ _-]+/g, "");
}

function damerauLevenshtein(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const matrix = Array.from({ length: rows }, (_, i) =>
		Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
		}
	}
	return matrix[a.length][b.length];
}

export function rankedTextMatch(
	values: string[],
	text: string,
): { reason: "exact" | "prefix" | "substring" | "fuzzy"; score: number } | undefined {
	const query = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 256);
	if (!query) return undefined;
	const candidates = values
		.map((value) => value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 512))
		.filter(Boolean);
	if (candidates.some((value) => value === query)) return { reason: "exact", score: 1 };
	if (
		candidates.some((value) => value.startsWith(query) || value.split(/\W+/).some((token) => token.startsWith(query)))
	)
		return { reason: "prefix", score: 0.95 };
	if (candidates.some((value) => value.includes(query))) return { reason: "substring", score: 0.9 };
	let score = 0;
	for (const value of candidates) {
		for (const candidate of [value, ...value.split(/\W+/)]) {
			if (!candidate || candidate.length > 256) continue;
			score = Math.max(score, 1 - damerauLevenshtein(query, candidate) / Math.max(query.length, candidate.length));
		}
	}
	return score >= 0.72 ? { reason: "fuzzy", score } : undefined;
}

export function searchOutlineRanked(
	outline: Outline,
	text?: string,
	role?: string,
	capability?: string,
	limit = 12,
): { matches: OutlineSearchMatch[]; totalMatches: number } {
	const query = text?.trim();
	const roleQuery = role ? normalizedSearchRole(role) : undefined;
	const actionQuery = capability?.trim();
	const strong: Array<OutlineSearchMatch & { order: number }> = [];
	const fuzzy: Array<OutlineSearchMatch & { order: number }> = [];
	for (const [order, node] of outline.nodes.entries()) {
		if (roleQuery && normalizedSearchRole(node.role) !== roleQuery) continue;
		if (actionQuery && !actionMatches(node, actionQuery)) continue;
		const label = outlineNodeLabel(node);
		const match = query
			? rankedTextMatch(
					[label, node.identifier, node.title, node.description, node.value, ...node.text.map((item) => item.string)],
					query,
				)
			: undefined;
		if (query && !match) continue;
		const result = {
			ref: node.ref,
			role: node.role,
			label,
			actions: node.actions,
			path: outlineNodePath(node),
			matchReason: match?.reason ?? ("filter" as const),
			score: match?.score ?? 1,
			node,
			order,
		};
		(match?.reason === "fuzzy" ? fuzzy : strong).push(result);
	}
	const rank = { exact: 0, prefix: 1, substring: 2, filter: 3, fuzzy: 4 } as const;
	const sorted = [
		...strong.sort((a, b) => rank[a.matchReason!] - rank[b.matchReason!] || b.score! - a.score! || a.order - b.order),
	];
	const useFuzzy = sorted.length < limit;
	if (useFuzzy) sorted.push(...fuzzy.sort((a, b) => b.score! - a.score! || a.order - b.order));
	return {
		matches: sorted.slice(0, limit).map(({ order: _order, ...match }) => match),
		totalMatches: strong.length + (useFuzzy ? fuzzy.length : 0),
	};
}

export function searchOutline(
	outline: Outline,
	text?: string,
	role?: string,
	action?: string,
	limit = 50,
): OutlineSearchMatch[] {
	const query = text?.trim().toLowerCase();
	const roleQuery = role?.trim();
	const actionQuery = action?.trim();
	const matches: OutlineSearchMatch[] = [];
	for (const node of outline.nodes) {
		const label = outlineNodeLabel(node);
		// outlineNodeLabel short-circuits (title || description || value), so
		// list the fields individually too or a titled node's value/description
		// can never match.
		const haystack = [
			label,
			node.role,
			node.subrole,
			node.identifier,
			node.title,
			node.description,
			node.value,
			...node.text.map((item) => item.string),
		]
			.join(" ")
			.toLowerCase();
		if (query && !haystack.includes(query)) continue;
		if (roleQuery && node.role !== roleQuery) continue;
		if (actionQuery && !actionMatches(node, actionQuery)) continue;
		matches.push({ ref: node.ref, role: node.role, label, actions: node.actions, path: outlineNodePath(node), node });
		if (matches.length >= limit) break;
	}
	return matches;
}

export function serializeOutlineSearchMatch(match: OutlineSearchMatch): SerializedOutlineSearchMatch {
	const { node: _node, ...serialized } = match;
	return serialized;
}

export function countOutlineNodes(root: OutlineNode): number {
	let count = 1;
	for (const child of root.children) count += countOutlineNodes(child);
	return count;
}

export function serializeOutline(outline: Outline): SerializedOutline {
	const serialized: SerializedOutline = {
		lookId: outline.lookId,
		root: serializeOutlineNode(outline.root),
		formatVersion: OUTLINE_FORMAT_VERSION,
	};
	if (outline.refHighWater !== undefined) serialized.refHighWater = outline.refHighWater;
	return serialized;
}

export function serializeOutlineNode(node: OutlineNode): SerializedOutlineNode {
	const { parent: _parent, children, ...rest } = node;
	return { ...rest, children: children.map(serializeOutlineNode) };
}

export function serializeOutlineNodeShallow(node: OutlineNode): SerializedOutlineNode {
	const { parent: _parent, children: _children, ...rest } = node;
	return { ...rest, children: [] };
}

export function restoreOutline(serialized: SerializedOutline): Outline {
	const nodes: OutlineNode[] = [];
	const refToWireRef = new Map<string, string>();
	const wireRefToRef = new Map<string, string>();
	const restoreNode = (raw: SerializedOutlineNode, parent?: OutlineNode): OutlineNode => {
		const node = sanitizeProtected(normalizeRestored(raw, parent));
		nodes.push(node);
		if (node.wireRef) {
			refToWireRef.set(node.ref, node.wireRef);
			wireRefToRef.set(node.wireRef, node.ref);
		}
		node.children = raw.children.map((child) => restoreNode(child, node));
		return node;
	};
	const root = restoreNode(serialized.root);
	dropTextOverProtected(root, serialized.formatVersion !== OUTLINE_FORMAT_VERSION);
	const outline: Outline = { lookId: serialized.lookId, root, nodes, refToWireRef, wireRefToRef };
	// Stored JSON is untrusted: only a nonnegative integer counts, otherwise the highest restored ref does.
	const { refHighWater } = serialized as { refHighWater?: unknown };
	if (typeof refHighWater === "number" && Number.isSafeInteger(refHighWater) && refHighWater >= 0)
		outline.refHighWater = refHighWater;
	return outline;
}

/**
 * A stored node is untrusted JSON: older writers or a damaged file may omit fields. Normalize every field a fold,
 * search or diff reads, so a missing role restores as blank (unclassified, hence protected) instead of crashing.
 */
function normalizeRestored(raw: SerializedOutlineNode, parent?: OutlineNode): OutlineNode {
	const record = raw as Partial<SerializedOutlineNode>;
	const node: OutlineNode = {
		...raw,
		ref: toString(record.ref),
		role: toString(record.role),
		subrole: toString(record.subrole),
		identifier: toString(record.identifier),
		title: toString(record.title),
		description: toString(record.description),
		value: toString(record.value),
		actions: Array.isArray(record.actions)
			? record.actions.filter((value): value is string => typeof value === "string")
			: [],
		rect: readRect(record.rect),
		text: Array.isArray(record.text) ? record.text.map(restoreText).filter((item) => item !== undefined) : [],
		children: [],
		parent,
	};
	if (!node.rect) delete node.rect;
	if (record.childrenUnread !== true || record.truncated !== true) delete node.childrenUnread;
	if (record.unconfirmed === true) redactRetained(node);
	else delete node.unconfirmed;
	return node;
}

/** Normalize a stored text box: only a finite rect and the literal `source: "value"` tag survive. */
function restoreText(raw: unknown): OutlineText | undefined {
	const text = readText(raw);
	if (text && (raw as { source?: unknown }).source === "value") text.source = "value";
	return text;
}

function outlineRefNumber(ref: string): number {
	const match = /^@e(\d+)$/.exec(ref);
	return match ? Number(match[1]) : 0;
}

function clearScopedRects(node: OutlineNode): void {
	// Scoped look geometry is in the scoped image's pixel space, not the full look.
	// Until helper-side act carries stable look geometry, grafted nodes are AX-only
	// for ref actions; coordinate fallback must re-observe the full window.
	node.rect = undefined;
	for (const text of node.text) text.rect = undefined;
	for (const child of node.children) clearScopedRects(child);
}

function rebuildIndexes(outline: Outline): void {
	outline.nodes = [];
	outline.refToWireRef = new Map();
	outline.wireRefToRef = new Map();
	const queue = [outline.root];
	let index = 0;
	while (index < queue.length) {
		const node = queue[index++];
		outline.nodes.push(node);
		if (node.wireRef) {
			outline.refToWireRef.set(node.ref, node.wireRef);
			outline.wireRefToRef.set(node.wireRef, node.ref);
		}
		queue.push(...node.children);
	}
}

function copyNodeFields(target: OutlineNode, source: OutlineNode, preserveWireRef: boolean): void {
	if (!preserveWireRef) target.wireRef = source.wireRef;
	target.role = source.role;
	target.subrole = source.subrole;
	target.identifier = source.identifier;
	target.title = source.title;
	target.description = source.description;
	target.value = source.value;
	target.actions = [...source.actions];
	target.canPress = source.canPress;
	target.canFocus = source.canFocus;
	target.canSetValue = source.canSetValue;
	target.canScroll = source.canScroll;
	target.canIncrement = source.canIncrement;
	target.canDecrement = source.canDecrement;
	target.isTextInput = source.isTextInput;
	target.rect = source.rect;
	target.focused = source.focused;
	target.offscreen = source.offscreen;
	target.pictureOnly = source.pictureOnly;
	// A scoped look that still could not read the subtree leaves the node unread.
	target.truncated = source.truncated;
	if (source.childrenUnread) target.childrenUnread = true;
	else delete target.childrenUnread;
	target.scrollExtent = source.scrollExtent ? { ...source.scrollExtent } : undefined;
	target.text = source.text.map((text) => ({ ...text, rect: text.rect ? { ...text.rect } : undefined }));
	// The source is a fresh look, so its classification is current.
	delete target.unconfirmed;
}

function preserveUnreused(node: OutlineNode, parent: OutlineNode, used: Set<OutlineNode>): OutlineNode | undefined {
	if (used.has(node)) return undefined;
	node.parent = parent;
	node.children = node.children
		.map((child) => preserveUnreused(child, node, used))
		.filter((child): child is OutlineNode => Boolean(child));
	return node;
}

/** Cached children of `parent` the scoped look did not reuse, or none unless `keepUnseen`. */
function preservedChildren(
	oldChildren: OutlineNode[],
	parent: OutlineNode,
	used: Set<OutlineNode>,
	keepUnseen: boolean,
): OutlineNode[] {
	if (!keepUnseen) return [];
	return oldChildren
		.map((child) => preserveUnreused(child, parent, used))
		.filter((child): child is OutlineNode => Boolean(child));
}

function cloneForGraft(
	source: OutlineNode,
	parent: OutlineNode,
	nextRef: () => string,
	reusableByWireRef: Map<string, OutlineNode>,
	used: Set<OutlineNode>,
	keepUnseen: boolean,
): OutlineNode {
	const existing = source.wireRef ? reusableByWireRef.get(source.wireRef) : undefined;
	const oldChildren = existing?.children ?? [];
	const node: OutlineNode = existing ?? {
		...source,
		ref: nextRef(),
		children: [],
		parent,
		text: [],
		actions: [],
		scrollExtent: undefined,
	};
	copyNodeFields(node, source, Boolean(existing));
	used.add(node);
	node.parent = parent;
	const graftedChildren = source.children.map((child) =>
		cloneForGraft(child, node, nextRef, reusableByWireRef, used, keepUnseen),
	);
	node.children = [...graftedChildren, ...preservedChildren(oldChildren, node, used, keepUnseen)];
	return node;
}

function redactUnconfirmed(node: OutlineNode, confirmed: Set<OutlineNode>): void {
	if (!confirmed.has(node)) redactRetained(node);
	for (const child of node.children) redactUnconfirmed(child, confirmed);
}

/** Options for `graftScopedOutline`. */
export interface GraftOptions {
	/**
	 * The scoped reply is the whole live subtree of the target, so a cached descendant it omits is gone, not unread,
	 * and is dropped with its text and ref. Linux sets it: a child moved under a protected container elsewhere is
	 * simply absent from a complete reply (#1349). macOS and Windows omit it and keep unseen cached nodes while the
	 * reply has no unread node.
	 */
	authoritative?: boolean;
}

export function graftScopedOutline(
	outline: Outline,
	targetRef: string,
	scoped: Outline,
	options: GraftOptions = {},
): OutlineNode {
	const target = nodeByRef(outline, targetRef);
	if (!target) throw new Error(`Cannot graft scoped outline: target ${targetRef} is not in the current outline.`);
	const targetRect = target.rect ? { ...target.rect } : undefined;
	const reusableByWireRef = new Map<string, OutlineNode>();
	const collect = (node: OutlineNode) => {
		if (node.wireRef) reusableByWireRef.set(node.wireRef, node);
		for (const child of node.children) collect(child);
	};
	collect(target);
	// Number after every ref ever issued, not only the live ones: a ref an earlier graft dropped stays retired (#1349).
	let nextNumber =
		Math.max(...outline.nodes.map((node) => outlineRefNumber(node.ref)), outline.refHighWater ?? 0, 0) + 1;
	const nextRef = () => `@e${nextNumber++}`;
	const oldChildren = target.children;
	const used = new Set<OutlineNode>([target]);
	copyNodeFields(target, scoped.root, true);
	target.ref = targetRef;
	// The cached full-look rect stays as action geometry only while the fresh target is readable. A protected one's
	// fresh bounds are authoritative for privacy, but they are in scoped space and cannot be mapped, so it is unplaced
	// (fail closed, #1263). Its own boxes are in scoped space too: never compare them with full-look rects.
	target.rect = isConfirmedReadable(target) ? targetRect : undefined;
	for (const text of target.text) text.rect = undefined;
	// A node the scoped look left unread (`truncated`) may have been refused, e.g. a Linux child whose live `Parent`
	// edge is unconfirmed, and the reply cannot say which cached node that was. So a cached node absent from the look
	// survives only when the look read everything; otherwise its cached text and refs go. An authoritative reply
	// never keeps one (#1349).
	const keepUnseen = !options.authoritative && !scoped.nodes.some((node) => node.truncated);
	const graftedChildren = scoped.root.children.map((child) =>
		cloneForGraft(child, target, nextRef, reusableByWireRef, used, keepUnseen),
	);
	target.children = [...graftedChildren, ...preservedChildren(oldChildren, target, used, keepUnseen)];
	for (const child of target.children) clearScopedRects(child);
	// A preserved node is absent from the scoped look, so its classification is unknown. Once that look shows
	// any protected node, a preserved one may be the same element under a new wire ref: drop its old text.
	if (scoped.nodes.some(isProtectedNode)) redactUnconfirmed(target, used);
	// Grafted geometry is cleared, so once the outline holds a protected node its OCR boxes cannot be placed.
	dropTextOverProtected(outline.root);
	rebuildIndexes(outline);
	outline.refHighWater = nextNumber - 1;
	return target;
}
