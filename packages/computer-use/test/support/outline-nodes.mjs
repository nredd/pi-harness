// Hand-built outline nodes for pure-module tests (no helper process).

/** A minimal `OutlineNode`; children get their `parent` link. */
export const outlineNode = (ref, over = {}) => {
	const out = { ref, role: "AXGroup", subrole: "", identifier: "", title: "", description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, focused: false, offscreen: false, pictureOnly: false, truncated: false, text: [], children: [], ...over };
	for (const child of out.children) child.parent = out;
	return out;
};

/** An `Outline` whose `nodes` are the breadth-first walk of `root` plus any `extra` detached nodes. */
export const outlineOf = (root, { lookId = "look1", extra = [] } = {}) => {
	const nodes = [];
	const queue = [root];
	while (queue.length > 0) {
		const next = queue.shift();
		nodes.push(next);
		queue.push(...next.children);
	}
	nodes.push(...extra);
	return {
		lookId,
		root,
		nodes,
		refToWireRef: new Map(nodes.filter((n) => n.wireRef).map((n) => [n.ref, n.wireRef])),
		wireRefToRef: new Map(nodes.filter((n) => n.wireRef).map((n) => [n.wireRef, n.ref])),
	};
};
