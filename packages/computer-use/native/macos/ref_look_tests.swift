import ApplicationServices
import Foundation

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
}
