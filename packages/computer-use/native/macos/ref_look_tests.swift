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

  // A chain 0...13: the depth-13 node lies one level past the waitFor depth limit of 12.
  let chain = (0...13).map { Node("n\($0)") }
  var chainChildren: [String: [Node]] = [:]
  for depth in 0..<13 { chainChildren[chain[depth].name] = [chain[depth + 1]] }
  let deep = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: 12, maxNodes: 2000, checkFrontier: true)
  check(deep.nodes.count == 13 && !deep.complete, "a node below the depth limit leaves the walk incomplete")
  let unchecked = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: 12, maxNodes: 2000, checkFrontier: false)
  check(unchecked.nodes.count == 13, "an unchecked frontier walks the same nodes")
  let whole = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: 13, maxNodes: 2000, checkFrontier: true)
  check(whole.nodes.count == 14 && whole.complete, "a leaf at the depth limit completes the walk")
  let frontierUnread = world(children: chainChildren, unreadable: ["n12"])
    .walk(startingAt: chain[0], maxDepth: 12, maxNodes: 2000, checkFrontier: true)
  check(!frontierUnread.complete, "an unreadable node at the depth limit may have children")
  let budget = world(children: chainChildren).walk(startingAt: chain[0], maxDepth: 20, maxNodes: 5, checkFrontier: true)
  check(budget.nodes.count == 5 && !budget.complete, "the node budget leaves the walk incomplete")
  let wide = world(children: ["root": (0..<5).map { Node("c\($0)") }])
    .walk(startingAt: Node("root"), maxDepth: 20, maxNodes: 3, checkFrontier: true)
  check(!wide.complete, "children cut by the queue budget leave the walk incomplete")
  let unreadable = world(children: chainChildren, unreadable: ["n5"])
    .walk(startingAt: chain[0], maxDepth: 20, maxNodes: 2000, checkFrontier: true)
  check(unreadable.nodes.count == 6 && !unreadable.complete, "a failed child read leaves the walk incomplete")

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
  print("macos absence evidence checks passed")
}
