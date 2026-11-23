// `childrenUnread` says a `truncated` node's own fields were read and only its descendants were not (#1310). It only
// ever narrows `truncated`: parse, restore and graft never let it stand without an explicit `truncated: true`.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	graftScopedOutline,
	nodeByRef,
	type Outline,
	type OutlineNode,
	parseLookResponse,
	restoreOutline,
	serializeOutline,
} from "../src/outline.ts";
import { lookPayload, wireNode } from "../test/support/fake-desktop.mjs";

/** Parse a look whose window holds one group with `extra` wire fields. */
function parsedGroup(extra: object): Outline {
	const outline = parseLookResponse(
		lookPayload({ children: [wireNode("g", "AXGroup", "Group", extra)] }),
	).parsedOutline;
	assert.ok(outline);
	return outline;
}

function groupNode(outline: Outline): OutlineNode {
	const node = nodeByRef(outline, "@e2");
	assert.ok(node);
	return node;
}

test.for([
	{ name: "with truncated", extra: { truncated: true, childrenUnread: true }, expected: true },
	{ name: "without truncated", extra: { truncated: false, childrenUnread: true }, expected: undefined },
	{ name: "with a non-boolean marker", extra: { truncated: true, childrenUnread: "yes" }, expected: undefined },
])("parse keeps childrenUnread only $name", ({ extra, expected }) => {
	assert.equal(groupNode(parsedGroup(extra)).childrenUnread, expected);
});

test("restore drops a stored childrenUnread that no truncated marker backs", () => {
	const serialized = serializeOutline(parsedGroup({ truncated: true, childrenUnread: true }));
	assert.equal(groupNode(restoreOutline(serialized)).childrenUnread, true, "a paired marker survives the store");
	const group = serialized.root.children[0];
	group.truncated = false;
	assert.equal(groupNode(restoreOutline(serialized)).childrenUnread, undefined, "an unpaired marker is dropped");
	Object.assign(group, { truncated: true, childrenUnread: 1 });
	assert.equal(groupNode(restoreOutline(serialized)).childrenUnread, undefined, "a non-boolean marker is dropped");
});

test("a scoped graft replaces the target's childrenUnread with the fresh look's", () => {
	const outline = parsedGroup({ truncated: true, childrenUnread: true });
	const bare = parseLookResponse({ lookId: "s1", outline: wireNode("g", "AXGroup", "Group", { truncated: true }) });
	assert.ok(bare.parsedOutline);
	graftScopedOutline(outline, "@e2", bare.parsedOutline);
	assert.deepEqual([groupNode(outline).truncated, groupNode(outline).childrenUnread], [true, undefined]);
	const marked = parseLookResponse({
		lookId: "s2",
		outline: wireNode("g", "AXGroup", "Group", { truncated: true, childrenUnread: true }),
	});
	assert.ok(marked.parsedOutline);
	graftScopedOutline(outline, "@e2", marked.parsedOutline);
	assert.equal(groupNode(outline).childrenUnread, true);
});
