import ApplicationServices
import Foundation

private func runAXTraversalAssertions() {
  final class Node {
    let name: String
    init(_ name: String) { self.name = name }
  }
  func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      print("FAIL: \(message)")
      exit(1)
    }
  }

  let root = Node("window")
  let web = Node("web")
  let toolbar = Node("toolbar")
  let link = Node("link")
  let hidden = Node("hidden")
  let label = Node("label")
  let button = Node("button")
  // The back edge `link -> Node("web")` is a DIFFERENT object equal to `web` by `sameElement`,
  // like the fresh handle AX returns on every call; object-identity dedupe would revisit `web`.
  let children = [
    root.name: [web, toolbar], web.name: [link, hidden], toolbar.name: [button],
    link.name: [Node(web.name)], hidden.name: [label],
  ]
  // Visibility queries may return a different handle for the same AX element.
  let visible = [web.name: [Node(link.name)], hidden.name: [label]]
  let world = AXTraversalWorld<Node>(
    role: { $0.name == web.name ? "AXWebArea" : "AXGroup" },
    childLists: { (children[$0.name] ?? [], visible[$0.name]) },
    sameElement: { $0.name == $1.name }, hash: { $0.name.hashValue })

  let all = world.collect(startingAt: root, maxDepth: 8, maxNodes: 20)
  check(
    all.map(\.element.name) == ["window", "web", "toolbar", "link", "hidden", "button", "label"],
    "AX traversal is breadth-first in sibling order and visits equivalent cyclic handles only once")
  check(all.map(\.depth) == [0, 1, 1, 2, 2, 2, 3], "AX traversal reports depth from the root")

  check(
    all.filter(\.insideWebArea).map(\.element.name) == ["web", "link", "hidden", "label"],
    "AX traversal marks the web area and its descendants, not sibling branches")
  check(
    all.filter(\.axVisible).map(\.element.name) == ["window", "web", "toolbar", "link", "button"],
    "AX visibility uses handle equivalence, defaults to visible when unknown, and cannot override a hidden ancestor")

  let shallow = world.collect(startingAt: root, maxDepth: 1, maxNodes: 20)
  check(
    shallow.map(\.element.name) == ["window", "web", "toolbar"],
    "AX traversal includes nodes at the depth limit but not their children")
  let capped = world.collect(startingAt: root, maxDepth: 8, maxNodes: 4)
  check(
    capped.map(\.element.name) == ["window", "web", "toolbar", "link"],
    "AX traversal counts the root against the node budget and returns the breadth-first prefix")
  let minimum = world.collect(startingAt: root, maxDepth: 8, maxNodes: 0)
  check(minimum.map(\.element.name) == ["window"], "AX traversal retains the root at zero budget")
  // Equality, not the hash, decides: distinct elements sharing a hash are both visited.
  let collidingWorld = AXTraversalWorld<Node>(
    role: { _ in "AXGroup" },
    childLists: { (children[$0.name] ?? [], nil) },
    sameElement: { $0.name == $1.name }, hash: { _ in 0 })
  check(
    collidingWorld.collect(startingAt: root, maxDepth: 8, maxNodes: 20).map(\.element.name)
      == ["window", "web", "toolbar", "link", "hidden", "button", "label"],
    "AX traversal compares colliding hashes by equivalence and still dedupes the cycle")
  print("macos AX descendant traversal checks passed")
}

/// Assert ref ownership and wire payloads against production types, without AX attribute queries.
func runRefLookAssertions() {
  func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      print("FAIL: \(message)")
      exit(1)
    }
  }
  func sameElement(_ actual: AXUIElement?, _ expected: AXUIElement) -> Bool {
    actual.map { CFEqual($0, expected) } ?? false
  }
  func snapshotMatches(_ actual: AXRefStore.Snapshot?, _ expected: AXRefStore.Snapshot) -> Bool {
    guard let actual else { return false }
    return actual.role == expected.role && actual.identifier == expected.identifier
      && actual.label == expected.label && actual.rect == expected.rect
  }

  // Constructing application handles and comparing CF identity does not contact the AX server.
  let element = AXUIElementCreateApplication(getpid())
  let equivalent = AXUIElementCreateApplication(getpid())
  // Own the other PID rather than naming an unrelated app. cat waits only for this pipe's EOF.
  // Reap it BEFORE any assertion can exit(1); refs below are inert handles even after child exit.
  let fixture = Process()
  let input = Pipe()
  fixture.executableURL = URL(fileURLWithPath: "/bin/cat")
  fixture.standardInput = input
  fixture.standardOutput = FileHandle.nullDevice
  fixture.standardError = FileHandle.nullDevice
  do {
    try fixture.run()
  } catch {
    print("FAIL: cannot start isolated PID fixture: \(error)")
    exit(1)
  }
  let distinct = AXUIElementCreateApplication(fixture.processIdentifier)
  input.fileHandleForWriting.closeFile()
  fixture.waitUntilExit()
  check(
    fixture.terminationStatus == 0 && !fixture.isRunning, "isolated PID fixture exits and is reaped"
  )
  check(
    axEquivalenceHash(element) == axEquivalenceHash(equivalent),
    "equivalent AX handles share an equivalence hash")
  check(
    bucketKey(UInt.max) == -1 && bucketKey(UInt(Int.max) + 1) == Int.min && bucketKey(0) == 0,
    "bucket keys map hashes with the top bit set without trapping")
  check(!CFEqual(element, distinct), "different owned fixture PID produces an unequal AX handle")
  let store = AXRefStore(unownedCapacity: 2)
  let window = store.storeWindow(element)
  check(store.storeWindow(equivalent) == window, "equal window handles reuse the exact ref")
  let distinctWindow = store.storeWindow(distinct)
  check(distinctWindow != window, "unequal window handle receives a distinct ref")
  check(
    store.storeWindow(distinct) == distinctWindow, "distinct window handle is deduped on repeat")
  check(
    sameElement(store.window(for: distinctWindow), distinct),
    "distinct ref resolves to the exact fixture handle")
  check(sameElement(store.window(for: window), element), "window lookup returns the stored handle")
  check(store.window(for: "missing") == nil, "missing window lookup is nil")
  let snapshot = AXRefStore.Snapshot(
    role: "AXButton", identifier: "synthetic", label: "Save",
    rect: CGRect(x: -7, y: 11, width: 30, height: 19))
  let source = store.storeElement(element, snapshot: snapshot, owner: "source")
  let destination = store.storeElement(equivalent, snapshot: snapshot, owner: "destination")
  let unrelated = store.storeElement(element, owner: "unrelated")
  check(source != destination && source != window, "element refs are fresh even for equal handles")
  check(
    store.window(for: source) == nil && store.element(for: window) == nil,
    "window and element namespaces do not cross-resolve")
  check(
    store.element(for: "missing") == nil && store.snapshot(for: "missing") == nil,
    "unknown element and snapshot are nil")
  check(store.snapshot(for: unrelated) == nil, "omitted snapshot stays nil")
  store.transferElements(from: "source", to: "source")
  check(
    store.elementCount == 3 && snapshotMatches(store.snapshot(for: source), snapshot),
    "same-owner transfer retains refs and snapshot")
  store.transferElements(from: "absent", to: "destination")
  check(
    store.elementCount == 3 && sameElement(store.element(for: destination), element),
    "missing-source transfer preserves destination")
  store.transferElements(from: "source", to: "destination")
  store.dropElements(owner: "source")
  check(
    sameElement(store.element(for: source), element)
      && snapshotMatches(store.snapshot(for: source), snapshot),
    "transferred ref and snapshot survive old owner eviction")
  check(
    sameElement(store.element(for: destination), element),
    "transfer appends rather than replacing destination refs")
  store.dropElements(owner: "destination")
  check(
    store.element(for: source) == nil && store.snapshot(for: source) == nil,
    "successor eviction removes transferred ref and snapshot")
  check(
    store.element(for: destination) == nil && store.snapshot(for: destination) == nil,
    "successor eviction removes original destination refs")
  check(
    store.elementCount == 1 && sameElement(store.element(for: unrelated), element),
    "successor eviction leaves other owners alone")
  store.dropElements(owner: "destination")
  store.dropElements(owner: "absent")
  check(store.elementCount == 1, "repeated and unknown owner eviction are no-ops")
  // Boundary before/at/after overflow, with retained owned refs and snapshots checked individually.
  let first = store.storeElement(element, snapshot: snapshot)
  check(store.elementCount == 2, "FIFO below capacity retains unowned refs")
  let second = store.storeElement(element, snapshot: snapshot)
  check(
    store.elementCount == 3 && snapshotMatches(store.snapshot(for: first), snapshot),
    "FIFO at capacity retains oldest snapshot")
  let third = store.storeElement(element, snapshot: snapshot)
  check(
    store.element(for: first) == nil && store.snapshot(for: first) == nil,
    "FIFO overflow removes oldest ref and snapshot")
  check(
    store.elementCount == 3 && sameElement(store.element(for: second), element)
      && snapshotMatches(store.snapshot(for: second), snapshot),
    "FIFO overflow retains second ref and snapshot")
  check(
    sameElement(store.element(for: third), element)
      && snapshotMatches(store.snapshot(for: third), snapshot),
    "FIFO overflow retains newest ref and snapshot")
  store.dropElements(owner: "unrelated")
  check(
    store.elementCount == 2 && sameElement(store.window(for: window), element),
    "owner eviction cannot remove windows or unowned refs")
  let zero = AXRefStore(unownedCapacity: 0)
  let immediatelyEvicted = zero.storeElement(element, snapshot: snapshot)
  check(
    zero.elementCount == 0 && zero.element(for: immediatelyEvicted) == nil
      && zero.snapshot(for: immediatelyEvicted) == nil,
    "zero-capacity FIFO evicts ref and snapshot immediately")
  let other = AXRefStore()
  check(
    other.window(for: window) == nil && other.element(for: second) == nil,
    "foreign store cannot resolve refs")
  check(
    other.storeWindow(element) != window && other.storeElement(element) != second,
    "store epochs separate otherwise identical handles")

  let leaf = LookNode(
    element: nil, ref: "leaf", role: "AXStaticText", subrole: "", identifier: "label",
    title: "Child", description: "", value: "hello", actions: [], canPress: false, canFocus: true,
    canSetValue: false, canScroll: true, canIncrement: false, canDecrement: true,
    isTextInput: false, rect: CGRect(x: -2.5, y: 8.25, width: 10.5, height: 0))
  let expectedLeaf: [String: Any] = [
    "ref": "leaf", "role": "AXStaticText", "subrole": "", "identifier": "label", "title": "Child",
    "description": "", "value": "hello", "actions": [String](),
    "canPress": false, "canFocus": true, "canSetValue": false, "canScroll": true,
    "canIncrement": false, "canDecrement": true, "isTextInput": false,
    "rect": ["x": -2.5, "y": 8.25, "w": 10.5, "h": 0.0], "children": [[String: Any]](),
  ]
  check(
    leaf.element == nil && !leaf.focused && !leaf.offscreen && !leaf.pictureOnly && !leaf.truncated
      && leaf.scrollExtent == nil && leaf.text.isEmpty && leaf.children.isEmpty,
    "LookNode defaults start empty without AX element")
  check(
    NSDictionary(dictionary: leaf.payload()).isEqual(to: expectedLeaf),
    "leaf payload has exact base fields and omits false or empty optionals")
  let sibling = LookNode(
    element: nil, ref: "sibling", role: "AXGroup", subrole: "panel", identifier: "group",
    title: "Second", description: "Details", value: "", actions: ["AXPress"], canPress: true,
    canFocus: false, canSetValue: true, canScroll: false, canIncrement: true, canDecrement: false,
    isTextInput: true, rect: CGRect(x: 0, y: -1, width: 4, height: 5), focused: true,
    offscreen: true, pictureOnly: true)
  sibling.truncated = true
  sibling.scrollExtent = ["width": 300, "height": 600]
  sibling.text = [["text": "Synthetic text", "confidence": 0.75]]
  sibling.children = [leaf]
  let expectedSibling: [String: Any] = [
    "ref": "sibling", "role": "AXGroup", "subrole": "panel", "identifier": "group",
    "title": "Second", "description": "Details", "value": "", "actions": ["AXPress"],
    "canPress": true, "canFocus": false, "canSetValue": true, "canScroll": false,
    "canIncrement": true, "canDecrement": false, "isTextInput": true,
    "rect": ["x": 0.0, "y": -1.0, "w": 4.0, "h": 5.0], "children": [expectedLeaf],
    "focused": true, "offscreen": true, "pictureOnly": true, "truncated": true,
    "scrollExtent": ["width": 300, "height": 600],
    "text": [["text": "Synthetic text", "confidence": 0.75]],
  ]
  check(
    NSDictionary(dictionary: sibling.payload()).isEqual(to: expectedSibling),
    "nested payload serializes every optional field and capability exactly")
  // Reuse the leaf as a root only after asserting its empty children; the graph stays acyclic.
  sibling.children = []
  leaf.children = [
    sibling,
    LookNode(
      element: nil, ref: "last", role: "AXGroup", subrole: "", identifier: "", title: "",
      description: "", value: "", actions: [], canPress: false, canFocus: false, canSetValue: false,
      canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: .zero),
  ]
  let payload = leaf.payload()
  let children = payload["children"] as? [[String: Any]]
  check(
    children?.map { $0["ref"] as? String } == ["sibling", "last"],
    "recursive payload preserves child order")
  check(
    (children?.first?["children"] as? [[String: Any]])?.isEmpty == true,
    "recursive payload reflects cleared children, not cached output")
  check(
    JSONSerialization.isValidJSONObject(payload),
    "payload is valid JSON with synthetic nested text and rectangles")
  sibling.offscreen = false
  sibling.pictureOnly = false
  sibling.truncated = false
  sibling.scrollExtent = nil
  sibling.text = []
  let reset = sibling.payload()
  check(
    reset["focused"] as? Bool == true
      && ["offscreen", "pictureOnly", "truncated", "scrollExtent", "text"].allSatisfy {
        reset[$0] == nil
      }, "cleared optional fields disappear on the next payload")
  sibling.scrollExtent = [:]
  check(
    (sibling.payload()["scrollExtent"] as? [String: Int]) == [:],
    "present empty scroll extent is not treated as absent")
  print("macos ref ownership and look serialization checks passed")
  runAXTraversalAssertions()
  runAbsenceEvidenceAssertions()
  runLookOutlineAssertions()
}

/// The production look walk (`LookOutlineWorld.build`) over injected AX reads: a failed children read, the node
/// budget and the deadline mark the node `truncated`; only an authoritative empty list is a leaf (#1287).
private func runLookOutlineAssertions() {
  final class Node {
    let name: String
    init(_ name: String) { self.name = name }
  }
  func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      print("FAIL: \(message)")
      exit(1)
    }
  }
  func node(_ name: String) -> LookNode {
    LookNode(
      element: nil, ref: name, role: "AXGroup", subrole: "", identifier: "", title: name, description: "", value: "",
      actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false,
      canDecrement: false, isTextInput: false, rect: .zero)
  }
  /// The clock reads 0 when the walk sets its deadline and one second more at each later reading, so the walk
  /// expires at its `expiresAfter + 1`-th budget check.
  func build(_ root: Node, children: [String: [Node]], unreadable: Set<String> = [], nodeLimit: Int = 2000, expiresAfter: Int = 1_000_000) -> LookNode {
    var readings = 0.0
    let world = LookOutlineWorld<Node>(
      children: { unreadable.contains($0.name) ? nil : children[$0.name] ?? [] },
      rootNode: { node($0.name) },
      childNodes: { _ in { node($0.name) } },
      now: {
        defer { readings += 1 }
        return readings
      })
    return world.build(root: root, nodeLimit: nodeLimit, timeLimit: Double(expiresAfter) + 0.5, requestDeadline: .infinity)
  }
  /// Root construction costs `rootCost` seconds and each child node `childCost` seconds on the walk's clock, which
  /// reads 0 when the request starts. Returns the outline, the clock when the walk returned and the children reads.
  func timed(
    _ root: Node, children: [String: [Node]], rootCost: Double, childCost: Double, requestDeadline: TimeInterval = .infinity
  ) -> (outline: LookNode, finishedAt: Double, reads: [String]) {
    var clock = 0.0
    var reads: [String] = []
    let world = LookOutlineWorld<Node>(
      children: {
        reads.append($0.name)
        return children[$0.name] ?? []
      },
      rootNode: {
        clock += rootCost
        return node($0.name)
      },
      childNodes: { _ in
        { child in
          clock += childCost
          return node(child.name)
        }
      },
      now: { clock })
    let outline = world.build(root: root, nodeLimit: 2000, timeLimit: 20, requestDeadline: requestDeadline)
    return (outline, clock, reads)
  }
  func find(_ name: String, in tree: LookNode) -> LookNode? {
    tree.ref == name ? tree : tree.children.lazy.compactMap { find(name, in: $0) }.first
  }
  let root = Node("root")
  let unread = Node("unread")
  let leaf = Node("leaf")
  let parent = Node("parent")
  let grandchild = Node("grandchild")
  let tree: [String: [Node]] = ["root": [unread, leaf, parent, leaf], "parent": [grandchild]]

  let outline = build(root, children: tree, unreadable: ["unread"])
  check(outline.children.map(\.ref) == ["unread", "leaf", "parent"], "every child is walked once, a repeated handle is skipped")
  check(find("unread", in: outline).map { $0.truncated && $0.children.isEmpty } == true, "a failed children read marks the node truncated, never a leaf")
  check(find("unread", in: outline)?.payload()["truncated"] as? Bool == true, "the unread node's payload carries the marker")
  check(
    !outline.truncated && find("leaf", in: outline)?.truncated == false && find("grandchild", in: outline)?.truncated == false,
    "a readable empty child list is a complete leaf")
  check(find("parent", in: outline)?.children.map(\.ref) == ["grandchild"], "the walk continues below a sibling of the unread node")
  let unreadRoot = build(root, children: tree, unreadable: ["root"])
  check(unreadRoot.truncated && unreadRoot.children.isEmpty, "a failed root children read leaves the whole look truncated")

  let budget = build(root, children: tree, nodeLimit: 3)
  check(budget.truncated && budget.children.map(\.ref) == ["unread", "leaf"], "the node budget cuts the children and marks the parent")
  check(find("parent", in: build(root, children: tree, nodeLimit: 4))?.truncated == true, "a parent reached at the budget is truncated")
  check(build(root, children: tree, expiresAfter: 0).truncated, "an expired deadline marks the node it stops at")
  let late = build(root, children: tree, expiresAfter: 2)
  check(late.truncated && late.children.map(\.ref) == ["unread"], "a deadline during the children marks the parent")
  let slowRoot = timed(root, children: ["root": [parent], "parent": [grandchild]], rootCost: 19, childCost: 2).outline
  check(
    !slowRoot.truncated && find("parent", in: slowRoot)?.truncated == false && find("grandchild", in: slowRoot) != nil,
    "the root node's reads never spend the walk's 20 s budget")
  let slowChildren = timed(root, children: ["root": [parent], "parent": [grandchild]], rootCost: 0, childCost: 21).outline
  check(find("parent", in: slowChildren)?.truncated == true, "child construction still spends it")

  // A 19 s root, then a chain of 2 s children: the walk's own 20 s would run to 39 s, past the client's 33 s abort.
  let chain = (0..<12).map { Node("c\($0)") }
  var chainChildren: [String: [Node]] = ["root": [chain[0]]]
  for (index, link) in chain.dropLast().enumerated() { chainChildren[link.name] = [chain[index + 1]] }
  let capped = timed(root, children: chainChildren, rootCost: 19, childCost: 2, requestDeadline: lookWalkDeadline)
  check(capped.finishedAt <= lookWalkDeadline + 2, "a slow root cannot start a walk past the request deadline")
  check(
    find("c2", in: capped.outline)?.truncated == true && find("c3", in: capped.outline) == nil,
    "the walk stops at the request deadline and returns a truncated outline")
  check(capped.reads == ["root", "c0", "c1"], "no queued node's children are read past the request deadline")
  let overrun = timed(root, children: chainChildren, rootCost: 26, childCost: 2, requestDeadline: lookWalkDeadline)
  check(
    overrun.outline.truncated && overrun.outline.children.isEmpty && overrun.finishedAt == 26 && overrun.reads.isEmpty,
    "a root that overran the request deadline reads no children")
  print("macos look outline evidence checks passed")
}

/// A failed read, a bounded walk or a partial root listing never proves absence (#1242, #1243).
private func runAbsenceEvidenceAssertions() {
  final class Node {
    let name: String
    init(_ name: String) { self.name = name }
  }
  func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      print("FAIL: \(message)")
      exit(1)
    }
  }
  func world(children: [String: [Node]], unreadable: Set<String> = []) -> AXTraversalWorld<Node> {
    AXTraversalWorld<Node>(
      role: { _ in "AXGroup" },
      childLists: { unreadable.contains($0.name) ? nil : (children[$0.name] ?? [], nil) },
      sameElement: { $0.name == $1.name }, hash: { $0.name.hashValue })
  }

  check(axReadEvidence(.success) == .present, "a successful read is present")
  check(
    [AXError.noValue, .attributeUnsupported, .invalidUIElement].allSatisfy { axReadEvidence($0) == .absent },
    "no value, an unsupported attribute and a destroyed element are authoritative absence")
  check(
    [AXError.cannotComplete, .apiDisabled, .failure, .notImplemented].allSatisfy { axReadEvidence($0) == .failed },
    "a timeout or any other failure proves nothing")

  // A chain one level past the waitFor depth limit: its last node lies below the cut.
  let limit = waitForMaxDepth
  let chain = (0...(limit + 1)).map { Node("n\($0)") }
  var chainChildren: [String: [Node]] = [:]
  for depth in 0...limit { chainChildren[chain[depth].name] = [chain[depth + 1]] }
  let deep = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: limit, maxNodes: waitForMaxNodes, checkFrontier: true)
  check(deep.nodes.count == limit + 1 && !deep.complete, "a node below the depth limit leaves the walk incomplete")
  let unchecked = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: limit, maxNodes: waitForMaxNodes, checkFrontier: false)
  check(unchecked.nodes.count == limit + 1, "an unchecked frontier walks the same nodes")
  let whole = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: limit + 1, maxNodes: waitForMaxNodes, checkFrontier: true)
  check(whole.nodes.count == limit + 2 && whole.complete, "a leaf at the depth limit completes the walk")
  let frontierUnread = world(children: chainChildren, unreadable: [chain[limit].name])
    .walk(startingAt: chain[0], maxDepth: limit, maxNodes: waitForMaxNodes, checkFrontier: true)
  check(!frontierUnread.complete, "an unreadable node at the depth limit may have children")
  let budget = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: 20, maxNodes: 5, checkFrontier: true)
  check(budget.nodes.count == 5 && !budget.complete, "the node budget leaves the walk incomplete")
  let wide = world(children: ["root": (0..<5).map { Node("c\($0)") }])
    .walk(startingAt: Node("root"), maxDepth: 20, maxNodes: 3, checkFrontier: true)
  check(!wide.complete, "children cut by the queue budget leave the walk incomplete")
  let unreadable = world(children: chainChildren, unreadable: ["n5"])
    .walk(startingAt: chain[0], maxDepth: 20, maxNodes: waitForMaxNodes, checkFrontier: true)
  check(unreadable.nodes.count == 6 && !unreadable.complete, "a failed child read leaves the walk incomplete")

  // The production `waitFor` pass (#1243): a match beyond its depth or node budget leaves absence undecided.
  func verdict(_ pass: AXWaitPass<Node>) -> String {
    switch pass.verdict {
    case .found: return "found"
    case .absent: return "absent"
    case .undecided: return "undecided"
    }
  }
  let chainWorld = world(children: chainChildren)
  func named(_ name: String) -> (Node) -> Bool? { { $0.name == name } }
  check(
    verdict(chainWorld.waitPass(startingAt: chain[0], scopeExact: false, matches: named(chain[limit + 1].name))) == "undecided",
    "a match one level below the depth cut is undecided, never gone")
  check(
    verdict(chainWorld.waitPass(startingAt: chain[0], scopeExact: false, matches: named(chain[limit].name))) == "found",
    "a match at the depth limit is found")
  var shallowChildren = chainChildren
  shallowChildren[chain[limit].name] = nil
  let shallow = world(children: shallowChildren)
  check(
    verdict(shallow.waitPass(startingAt: chain[0], scopeExact: false) { _ in false }) == "absent",
    "a whole, fully read scope without a match proves absence")
  check(
    verdict(shallow.waitPass(startingAt: chain[0], scopeExact: false) { $0.name == "n3" ? nil : false }) == "undecided",
    "an unread predicate field leaves absence undecided")
  check(
    verdict(shallow.waitPass(startingAt: chain[0], scopeExact: false) { $0.name == "n2" ? nil : $0.name == "n3" }) == "found",
    "a later match wins over an undecided node")
  check(
    verdict(chainWorld.waitPass(startingAt: chain[0], scopeExact: true, matches: named("n1"))) == "absent",
    "an exact scope tests only its own element")
  check(
    verdict(chainWorld.waitPass(startingAt: chain[0], scopeExact: true, matches: named("n0"))) == "found",
    "an exact scope matches itself")
  // The root and `waitForMaxNodes` children: the queue budget cuts the last child.
  let crowd = (0..<waitForMaxNodes).map { Node("k\($0)") }
  let crowdWorld = world(children: ["crowd": crowd])
  let lastChild = "k\(waitForMaxNodes - 1)"
  check(
    verdict(crowdWorld.waitPass(startingAt: Node("crowd"), scopeExact: false, matches: named(lastChild))) == "undecided",
    "a match past the node budget is undecided, never gone")
  check(
    verdict(crowdWorld.waitPass(startingAt: Node("crowd"), scopeExact: false, matches: named("k\(waitForMaxNodes - 2)"))) == "found",
    "a match inside the node budget is found")

  func fields(_ values: [AXWaitField: AXStringRead]) -> (AXWaitField) -> AXStringRead {
    { values[$0] ?? .absent }
  }
  let button: [AXWaitField: AXStringRead] = [.role: .value("AXButton"), .title: .value("Save"), .value: .value(" On ")]
  check(axWaitConditionMatch(role: "AXButton", text: "save", value: "on", read: fields(button)) == true, "every predicate read and matched")
  check(axWaitConditionMatch(role: "AXLink", text: nil, value: nil, read: fields(button)) == false, "a read role mismatch")
  check(axWaitConditionMatch(role: "AXButton", text: "open", value: nil, read: fields(button)) == false, "read text mismatch")
  check(axWaitConditionMatch(role: nil, text: nil, value: "off", read: fields(button)) == false, "read value mismatch")
  check(axWaitConditionMatch(role: "AXButton", text: nil, value: nil, read: fields([:])) == false, "an absent role cannot match")
  check(axWaitConditionMatch(role: nil, text: nil, value: "on", read: fields([:])) == false, "an absent value cannot match")
  check(axWaitConditionMatch(role: "AXButton", text: nil, value: nil, read: fields([.role: .failed])) == nil, "a failed role read is undecided")
  check(
    axWaitConditionMatch(role: nil, text: "save", value: nil, read: fields([.title: .failed, .description: .value("Other")])) == nil,
    "an unread text field leaves the text undecided")
  check(
    axWaitConditionMatch(role: nil, text: "save", value: nil, read: fields([.title: .failed, .description: .value("Save")])) == true,
    "text read elsewhere still matches")
  check(axWaitConditionMatch(role: nil, text: nil, value: "on", read: fields([.value: .failed])) == nil, "a failed value read is undecided")
  check(
    axWaitConditionMatch(role: "AXLink", text: "save", value: nil, read: fields([.role: .value("AXButton"), .title: .failed])) == false,
    "a read mismatch decides despite another failed read")

  check(windowListComplete(0) && windowListComplete(windowListCap), "a read window list within the cap is complete")
  check(!windowListComplete(nil) && !windowListComplete(windowListCap + 1), "a failed or over-cap window list is incomplete")

  let main: [String: Any] = ["title": "Main", "isFocused": false]
  let sheet: [String: Any] = ["title": "Sheet", "isFocused": true]
  let fresh: [String: Any] = ["title": "Fresh", "isFocused": true]
  func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> Set<String> {
    Set(rootInventoryChanges(before: before, after: after).map { "\($0.change):\($0.root["title"] as? String ?? "")" })
  }
  let both = RootInventorySnapshot(roots: ["w": main, "s": sheet], complete: true)
  check(
    changes(both, RootInventorySnapshot(roots: ["w": main], complete: true)) == ["closed:Sheet"],
    "a root missing from a complete listing closed")
  check(
    changes(both, RootInventorySnapshot(roots: ["w": main], complete: false)).isEmpty,
    "a root missing from an incomplete listing is unknown, not closed")
  check(
    changes(RootInventorySnapshot(roots: ["w": main], complete: true), RootInventorySnapshot(roots: ["w": main, "f": fresh], complete: false))
      == ["appeared:Fresh", "focused:Fresh"],
    "a root seen in an incomplete listing still appeared after a complete one")
  check(
    changes(RootInventorySnapshot(roots: ["w": main], complete: false), RootInventorySnapshot(roots: ["w": main, "f": fresh], complete: true)).isEmpty,
    "a root missing from an incomplete earlier listing neither appeared nor gained focus")
  check(
    changes(
      RootInventorySnapshot(roots: ["w": main], complete: false),
      RootInventorySnapshot(roots: ["w": ["title": "Main", "isFocused": true]], complete: true)) == ["focused:Main"],
    "a root seen in both listings gained focus")
  check(changes(both, both).isEmpty, "unchanged listings report nothing")
  runWindowInventoryAssertions()
  print("macos absence evidence checks passed")
}

/// Production inventory assembly (`WindowInventoryWorld.listing` and `select`) over injected AX reads (#1242).
private func runWindowInventoryAssertions() {
  func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
      print("FAIL: \(message)")
      exit(1)
    }
  }
  func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> Set<String> {
    Set(rootInventoryChanges(before: before, after: after).map { "\($0.change):\($0.root["title"] as? String ?? "")" })
  }
  final class Window {
    let name: String
    init(_ name: String) { self.name = name }
  }
  /// Scripted AX replies: each `size` read consumes the window's next reply, then repeats the last one.
  final class Script {
    var windows: [Window]?
    var fallback: [Window] = []
    var sizes: [String: [AXSizeRead]] = [:]
    var unreadPositions: Set<String> = []
    var sheets: [String: (sheets: [Window], complete: Bool)] = [:]
    var sizeReads = 0
    init(windows: [Window]?) { self.windows = windows }
    var world: WindowInventoryWorld<Window> {
      WindowInventoryWorld<Window>(
        windows: { self.windows }, fallbackWindows: { self.fallback },
        position: { self.unreadPositions.contains($0.name) ? nil : .zero },
        size: { window in
          self.sizeReads += 1
          var queue = self.sizes[window.name] ?? [.size(CGSize(width: 800, height: 600))]
          let reply = queue.removeFirst()
          self.sizes[window.name] = queue.isEmpty ? [reply] : queue
          return reply
        },
        sheets: { self.sheets[$0.name] ?? ([], true) })
    }
    func select(paired: [String: CGRect] = [:]) -> WindowInventorySelection<Window> {
      world.select(world.listing()) { paired[$0.name] }
    }
  }
  func snapshot(_ selection: WindowInventorySelection<Window>) -> RootInventorySnapshot {
    var roots: [String: [String: Any]] = [:]
    for kept in selection.windows {
      roots[kept.element.name] = ["title": kept.element.name, "isFocused": false]
      for sheet in kept.sheets { roots[sheet.name] = ["title": sheet.name, "isFocused": false] }
    }
    return RootInventorySnapshot(roots: roots, complete: selection.complete)
  }
  func names(_ selection: WindowInventorySelection<Window>) -> [String] { selection.windows.map { $0.element.name } }
  let main = Window("main")
  let unfocused = Window("unfocused")
  let sheet = Window("sheet")
  // The complete earlier listing: the focused main window, an unfocused window and its sheet.
  let before = RootInventorySnapshot(
    roots: Dictionary(uniqueKeysWithValues: ["main", "unfocused", "sheet"].map { ($0, ["title": $0, "isFocused": false] as [String: Any]) }),
    complete: true)

  let whole = Script(windows: [main, unfocused])
  whole.sheets["unfocused"] = ([sheet], true)
  let wholeSelection = whole.select()
  check(names(wholeSelection) == ["main", "unfocused"] && wholeSelection.complete, "every read succeeded: a complete inventory")
  check(wholeSelection.windows[1].sheets.map(\.name) == ["sheet"], "a listed window carries its sheet")
  check(changes(before, snapshot(wholeSelection)).isEmpty, "a complete unchanged inventory reports nothing")
  let closed = Script(windows: [main])
  check(changes(before, snapshot(closed.select())) == ["closed:unfocused", "closed:sheet"], "a complete inventory proves closure")

  // An `AXWindows` timeout falls back to the main/focused window: the unfocused window and its sheet are unknown.
  let timedOut = Script(windows: nil)
  timedOut.fallback = [main]
  let timedOutSelection = timedOut.select()
  check(names(timedOutSelection) == ["main"] && !timedOutSelection.complete, "a failed AXWindows read leaves the inventory incomplete")
  check(changes(before, snapshot(timedOutSelection)).isEmpty, "a timed-out window list closes neither the unfocused window nor its sheet")

  // A failed sheet read on a live unfocused window: the window stays listed, its sheet is unknown.
  let sheetTimeout = Script(windows: [main, unfocused])
  sheetTimeout.sheets["unfocused"] = ([], false)
  let sheetSelection = sheetTimeout.select()
  check(names(sheetSelection) == ["main", "unfocused"] && !sheetSelection.complete, "a failed sheet read leaves the inventory incomplete")
  check(changes(before, snapshot(sheetSelection)).isEmpty, "a sheet missing after a failed sheet read is not closed")

  // The skip filter and its evidence come from one reply; a retry replaces both.
  let retried = Script(windows: [main, unfocused])
  retried.sizes["unfocused"] = [.failed, .size(CGSize(width: 800, height: 600))]
  let retriedSelection = retried.select()
  check(names(retriedSelection) == ["main", "unfocused"], "a size read that succeeds on retry keeps the window")
  check(retriedSelection.complete && retriedSelection.windows[1].axFrame.size == CGSize(width: 800, height: 600), "the retry's size frames the window")
  check(retried.sizeReads == 3, "only a failed size read is retried, once")
  let unreadable = Script(windows: [main, unfocused])
  unreadable.sizes["unfocused"] = [.failed]
  let unreadableSelection = unreadable.select()
  check(names(unreadableSelection) == ["main"] && !unreadableSelection.complete, "an unpaired window whose size stays unreadable is unknown")
  check(changes(before, snapshot(unreadableSelection)).isEmpty, "an unreadable window is not closed")
  let pairedUnreadable = Script(windows: [main, unfocused])
  pairedUnreadable.sizes["unfocused"] = [.failed]
  let pairedSelection = pairedUnreadable.select(paired: ["unfocused": CGRect(x: 5, y: 5, width: 400, height: 300)])
  check(
    names(pairedSelection) == ["main", "unfocused"] && pairedSelection.complete
      && pairedSelection.windows[1].effectiveFrame == CGRect(x: 5, y: 5, width: 400, height: 300),
    "a paired window falls back to its CG bounds")
  check(pairedUnreadable.sizeReads == 2, "usable paired bounds admit a window without retrying its failed size read")
  let small = Script(windows: [main, unfocused])
  small.sizes["unfocused"] = [.size(CGSize(width: 50, height: 40))]
  let smallSelection = small.select()
  check(names(smallSelection) == ["main"] && smallSelection.complete, "a window read as too small is skipped without doubt")
  let pairedSmall = Script(windows: [main, unfocused])
  pairedSmall.sizes["unfocused"] = [.failed]
  check(pairedSmall.select(paired: ["unfocused": CGRect(x: 0, y: 0, width: 50, height: 40)]).complete, "a too-small paired window is skipped on its CG bounds")
  check(pairedSmall.sizeReads == 3, "paired bounds that do not admit the window leave its failed size read retried")
  let pairedRetried = Script(windows: [main, unfocused])
  pairedRetried.sizes["unfocused"] = [.failed, .size(CGSize(width: 800, height: 600))]
  let pairedRetriedSelection = pairedRetried.select(paired: ["unfocused": CGRect(x: 0, y: 0, width: 50, height: 40)])
  check(
    names(pairedRetriedSelection) == ["main", "unfocused"] && pairedRetriedSelection.complete
      && pairedRetriedSelection.windows[1].effectiveFrame.size == CGSize(width: 800, height: 600),
    "the retry's readable size admits a window its paired bounds would skip")
  check(
    wholeSelection.windows.allSatisfy(\.axFrameRead) && retriedSelection.windows.allSatisfy(\.axFrameRead),
    "a frame read on the first try or the retry is read")
  check(pairedSelection.windows.map(\.axFrameRead) == [true, false], "a failed size read kept on paired bounds leaves the AX frame unread")
  let unreadPosition = Script(windows: [main, unfocused])
  unreadPosition.unreadPositions = ["unfocused"]
  let unreadPositionSelection = unreadPosition.select()
  check(
    names(unreadPositionSelection) == ["main", "unfocused"] && unreadPositionSelection.windows.map(\.axFrameRead) == [true, false]
      && unreadPositionSelection.windows[1].axFrame.origin == .zero,
    "a failed position read keeps the window at the origin with its AX frame unread")
  let sizeless = Script(windows: [main, unfocused])
  sizeless.sizes["unfocused"] = [.absent]
  check(sizeless.select().complete, "a window without a size attribute is skipped without doubt")

  // Over the cap the listed windows still resolve, but a window past the cap is unknown, never closed.
  let many = (0...windowListCap).map { Window("w\($0)") }
  let overCap = Script(windows: many)
  let overCapSelection = overCap.select()
  check(overCapSelection.windows.count == windowListCap && !overCapSelection.complete, "an over-cap list is capped and incomplete")
  check(names(overCapSelection).contains("w5"), "an existing target still resolves from an over-cap list")
  let beforeMany = RootInventorySnapshot(
    roots: Dictionary(uniqueKeysWithValues: many.map { ($0.name, ["title": $0.name, "isFocused": false] as [String: Any]) }),
    complete: true)
  check(changes(beforeMany, snapshot(overCapSelection)).isEmpty, "a window past the cap is unknown, not closed")
}
