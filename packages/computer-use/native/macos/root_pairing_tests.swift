import ApplicationServices
import CoreGraphics
import Foundation

/// One CG window-list entry; nil leaves the key out, as `CGWindowListCopyWindowInfo` does.
private func windowEntry(pid: Int32?, layer: Int? = 0, number: UInt32? = nil, bounds: Any? = nil, name: String? = nil, title: String? = nil, onscreen: Bool? = nil) -> [String: Any] {
    var entry: [String: Any] = [:]
    if let pid { entry[kCGWindowOwnerPID as String] = NSNumber(value: pid) }
    if let layer { entry[kCGWindowLayer as String] = NSNumber(value: layer) }
    if let number { entry[kCGWindowNumber as String] = NSNumber(value: number) }
    if let bounds { entry[kCGWindowBounds as String] = bounds }
    if let name { entry[kCGWindowOwnerName as String] = name }
    if let title { entry[kCGWindowName as String] = title }
    if let onscreen { entry[kCGWindowIsOnscreen as String] = NSNumber(value: onscreen) }
    return entry
}

private func boundsDictionary(_ rect: CGRect) -> [String: Any] {
    rect.dictionaryRepresentation as? [String: Any] ?? [:]
}

private func lookNode(_ ref: String, _ rect: CGRect, title: String = "", value: String = "", description: String = "", pictureOnly: Bool = false, children: [LookNode] = []) -> LookNode {
    let node = LookNode(element: nil, ref: ref, role: "AXGroup", subrole: "", identifier: "", title: title, description: description, value: value, actions: [], canPress: false, canFocus: false, canSetValue: false, canScroll: false, canIncrement: false, canDecrement: false, isTextInput: false, rect: rect, pictureOnly: pictureOnly)
    node.children = children
    return node
}

private func rectFields(_ value: Any?) -> [Double]? {
    guard let rect = value as? [String: Any] else { return nil }
    let fields = ["x", "y", "w", "h"].compactMap { (rect[$0] as? NSNumber)?.doubleValue }
    return fields.count == 4 ? fields : nil
}

/// Pid above the macOS range: no process answers AX queries for it and no CG window belongs to it.
private let absentPid = Int32.max
private let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
private let usable = boundsDictionary(CGRect(x: 1, y: 2, width: 300, height: 200))

/// Drive the pure root, CG window-list, AX/CG pairing, look geometry and OCR placement policy in
/// `Bridge` with synthetic window lists, detached look trees and fabricated root snapshots. The only
/// live reads are AX title and frame queries on application handles above the macOS pid range, which
/// no process answers. Input goes to the fail-fast sink.
func runRootPairingAssertions() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    assertRootRanking(bridge)
    assertWindowCandidates(bridge)
    assertWindowOwners(bridge)
    assertPairing(bridge)
    assertLookGeometry(bridge)
    assertOCRPlacement(bridge)
    assertAXSource(bridge)
    assertRootIdentityAndDelta(bridge)
    print("macos root, pairing and OCR placement assertions passed")
}

/// Root ranking, kind and metadata.
private func assertRootRanking(_ bridge: Bridge) {
    expect(bridge.scoreWindow([:]) == 0, "a window without state scores 0")
    expect(bridge.scoreWindow(["isFocused": true, "isMain": true, "isMinimized": false, "isOnscreen": true, "windowId": 9]) == 250, "every ranking signal adds its weight")
    expect(bridge.scoreWindow(["isFocused": false, "isMain": "yes", "isMinimized": true, "isOnscreen": false]) == 0, "false, minimized and non-boolean state add nothing")
    for (role, subrole, kind) in [
        ("AXSheet", "AXDialog", "sheet"), ("AXWindow", "AXSystemPopover", "popover"), ("AXWindow", "AXSystemDialog", "dialog"),
        ("AXDialog", "", "dialog"), ("AXWindow", "AXStandardWindow", "window"),
    ] {
        expect(rootKind(role: role, subrole: subrole) == kind, "rootKind(\(role), \(subrole)) is \(kind)")
    }
    let metadata = bridge.rootMetadata(pairing: WindowPairing(candidate: nil, score: 12.5, confidence: "high"), sheetCount: 2)
    let pairingMetadata = metadata["pairing"] as? [String: Any]
    expect(metadata.count == 2 && metadata["sheetCount"] as? Int == 2 && pairingMetadata?["confidence"] as? String == "high" && pairingMetadata?["score"] as? Double == 12.5, "root metadata carries pairing confidence, score and sheet count")
}

/// Same-pid CG window candidates (layer-0 windows with a number and parseable bounds) and on-screen
/// popup menus from one pid or any pid.
private func assertWindowCandidates(_ bridge: Bridge) {
    let candidates = bridge.cgWindowCandidates(pid: 42, entries: [
        windowEntry(pid: 7, number: 1, bounds: usable),
        windowEntry(pid: nil, number: 2, bounds: usable),
        windowEntry(pid: 42, layer: 3, number: 3, bounds: usable),
        windowEntry(pid: 42, bounds: usable),
        windowEntry(pid: 42, number: 5),
        windowEntry(pid: 42, number: 6, bounds: ["X": NSNumber(value: 1)]),
        windowEntry(pid: 42, number: 7, bounds: "0,0,300,200"),
        windowEntry(pid: 42, layer: nil, number: 501, bounds: usable),
        windowEntry(pid: 42, number: 502, bounds: usable, title: "Doc", onscreen: false),
    ])
    expect(candidates.map(\.windowId) == [501, 502] && candidates.map(\.zOrder) == [7, 8], "candidates keep only usable same-pid windows in z order")
    expect(candidates.first?.title == "" && candidates.first?.isOnscreen == true && candidates.first?.layer == 0 && candidates.first?.bounds == CGRect(x: 1, y: 2, width: 300, height: 200), "missing title, onscreen and layer default to empty, on screen and 0")
    expect(candidates.last?.title == "Doc" && candidates.last?.isOnscreen == false, "candidate title and off-screen state come from the entry")
    let manyWindows = (1...130).map { windowEntry(pid: 42, number: UInt32($0), bounds: usable) }
    expect(bridge.cgWindowCandidates(pid: 42, entries: manyWindows).map(\.windowId) == (1...128).map { UInt32($0) }, "window candidates stop at 128")

    let popupEntries = [
        windowEntry(pid: 7, layer: popupLevel, number: 10, bounds: usable, onscreen: true),
        windowEntry(pid: nil, layer: popupLevel, number: 11, bounds: usable, onscreen: true),
        windowEntry(pid: 42, number: 12, bounds: usable, onscreen: true),
        windowEntry(pid: 42, layer: popupLevel, bounds: usable, onscreen: true),
        windowEntry(pid: 42, layer: popupLevel, number: 14, bounds: ["Width": NSNumber(value: 1)], onscreen: true),
        windowEntry(pid: 42, layer: popupLevel, number: 15, bounds: usable),
        windowEntry(pid: 42, layer: popupLevel, number: 16, bounds: usable, onscreen: false),
        windowEntry(pid: 42, layer: popupLevel, number: 17, bounds: usable, title: "Menu", onscreen: true),
    ]
    let popups = bridge.cgPopupMenuCandidates(pid: 42, entries: popupEntries)
    expect(popups.map(\.windowId) == [17] && popups.first?.zOrder == 7 && popups.first?.layer == popupLevel && popups.first?.title == "Menu" && popups.first?.isOnscreen == true, "pid popup candidates need the pid, popup level, a number, bounds and on-screen state")
    expect(bridge.cgPopupMenuCandidates(pid: nil, entries: popupEntries).map(\.windowId) == [10, 17], "popup candidates without a pid accept every owner")
    let manyPopups = (1...130).map { windowEntry(pid: 42, layer: popupLevel, number: UInt32($0), bounds: usable, onscreen: true) }
    expect(bridge.cgPopupMenuCandidates(pid: nil, entries: manyPopups).count == 128, "popup candidates stop at 128")
}

/// Window owners: one per pid, layer 0, at least 100x80 points. Broad discovery owners also accept
/// on-screen popup menus of any size.
private func assertWindowOwners(_ bridge: Bridge) {
    let owners = bridge.cgWindowOwners(entries: [
        windowEntry(pid: nil, bounds: usable, name: "No pid"),
        windowEntry(pid: 11, layer: 25, bounds: usable, name: "Overlay"),
        windowEntry(pid: 11, bounds: boundsDictionary(CGRect(x: 0, y: 0, width: 99, height: 500)), name: "Narrow"),
        windowEntry(pid: 11, bounds: boundsDictionary(CGRect(x: 0, y: 0, width: 500, height: 79)), name: "Short"),
        windowEntry(pid: 11, name: "No bounds"),
        windowEntry(pid: 11, bounds: usable, name: "Eleven"),
        windowEntry(pid: 11, bounds: usable, name: "Duplicate"),
        windowEntry(pid: absentPid, bounds: usable),
    ])
    expect(owners.map(\.pid) == [11, absentPid] && owners.map(\.name) == ["Eleven", "Unknown App"], "owners dedupe by pid, skip small or non-zero-layer windows and name unknown processes")

    let broad = bridge.cgBroadRootOwners(entries: [
        windowEntry(pid: 20, layer: 3, bounds: usable, name: "Floating"),
        windowEntry(pid: nil, bounds: usable, name: "No pid"),
        windowEntry(pid: 21, layer: popupLevel, name: "Unknown visibility"),
        windowEntry(pid: 21, layer: popupLevel, name: "Hidden menu", onscreen: false),
        windowEntry(pid: 21, layer: popupLevel, name: "Menu", onscreen: true),
        windowEntry(pid: 22, bounds: boundsDictionary(CGRect(x: 0, y: 0, width: 100, height: 79)), name: "Short"),
        windowEntry(pid: 22, name: "No bounds"),
        windowEntry(pid: 22, bounds: usable, name: "Twenty-two"),
        windowEntry(pid: 21, bounds: usable, name: "Duplicate"),
        windowEntry(pid: absentPid, bounds: usable),
        windowEntry(pid: 23, layer: nil, bounds: usable, name: "Default layer"),
    ])
    expect(broad.map(\.pid) == [21, 22, absentPid, 23] && broad.map(\.name) == ["Menu", "Twenty-two", "Unknown App", "Default layer"], "broad owners take on-screen menus and usable windows once per pid")
}

/// AX/CG pairing scores, confidence and one-to-one assignment.
private func assertPairing(_ bridge: Bridge) {
    let frame = CGRect(x: 0, y: 0, width: 200, height: 100)
    let near = CGWindowCandidate(windowId: 1, title: " report ", bounds: CGRect(x: 10, y: 20, width: 210, height: 100), isOnscreen: true, layer: 0, zOrder: 0)
    expect(windowPairScore(frame: frame, title: "Report", candidate: near) == 108, "equal titles add 100, geometry subtracts its distance over 20, on screen adds 10")
    expect(windowPairScore(frame: frame, title: "Report - Draft", candidate: near) == 58, "a contained title adds 50")
    expect(windowPairScore(frame: frame, title: "", candidate: near) == 8, "an empty title adds nothing")
    let offscreen = CGWindowCandidate(windowId: 2, title: "Other", bounds: CGRect(x: 900, y: 900, width: 10, height: 10), isOnscreen: false, layer: 0, zOrder: 1)
    expect(windowPairScore(frame: .zero, title: "Report", candidate: offscreen) == 0, "a degenerate frame skips geometry and off-screen adds nothing")
    let exactCandidate = CGWindowCandidate(windowId: 3, title: "Report", bounds: CGRect(x: 2, y: -2, width: 202, height: 98), isOnscreen: true, layer: 0, zOrder: 2)
    expect(pairingConfidence(frame: CGRect(x: 0, y: 0, width: 1, height: 100), title: "Report", candidate: exactCandidate, score: 500) == "low", "a degenerate frame is low confidence")
    expect(pairingConfidence(frame: frame, title: " report", candidate: exactCandidate, score: 0) == "exact", "equal titles within 2 points are exact")
    let shifted = CGWindowCandidate(windowId: 4, title: "Report", bounds: CGRect(x: 3, y: 0, width: 200, height: 100), isOnscreen: true, layer: 0, zOrder: 3)
    expect(pairingConfidence(frame: frame, title: "Report", candidate: shifted, score: 50) == "high", "geometry beyond 2 points falls back to a score of 50 or more")
    expect(pairingConfidence(frame: frame, title: "Report", candidate: shifted, score: 49.9) == "low", "a score under 50 is low confidence")
    let untitled = CGWindowCandidate(windowId: 5, title: "", bounds: frame, isOnscreen: true, layer: 0, zOrder: 4)
    expect(pairingConfidence(frame: frame, title: "", candidate: untitled, score: 10) == "low", "exact geometry without equal titles is not exact")

    // AX handles no process answers read empty frames and titles, so only on-screen state ranks the
    // candidates.
    let windows = (0..<3).map { AXUIElementCreateApplication(absentPid - Int32($0)) }
    let pairings = bridge.windowPairings(windows: windows, candidates: [offscreen, near])
    let paired = windows.compactMap { pairings[ObjectIdentifier($0)] }
    let matched = paired.filter { $0.candidate != nil }
    expect(paired.count == 3 && Set(matched.compactMap { $0.candidate?.windowId }) == [1, 2] && matched.map(\.score).sorted() == [0, 10], "each candidate pairs with one window, best score first")
    expect(paired.allSatisfy { $0.confidence == "low" } && paired.filter { $0.candidate == nil }.map(\.score) == [-Double.greatestFiniteMagnitude], "the window left over is unpaired and every frameless pairing is low confidence")
    let contested = bridge.windowPairings(windows: [windows[0]], candidates: [offscreen, near])[ObjectIdentifier(windows[0])]
    expect(contested?.candidate?.windowId == 1 && contested?.score == 10, "one window between two candidates takes the higher-scoring one")
    let unpaired = bridge.windowPairings(windows: [windows[0]], candidates: [])[ObjectIdentifier(windows[0])]
    expect(unpaired?.candidate == nil && unpaired?.confidence == "low", "windows without candidates are unpaired")
    assertPairingEvidence()
}

/// A window or sheet an injected world reads.
private final class FakeRoot {
    let name: String
    init(_ name: String) { self.name = name }
}

/// `pairWindows` scores only reads that answered: a failed title or frame read adds no score and no penalty, and the
/// pairing is `unread` (#1287).
private func assertPairingEvidence() {
    let window = FakeRoot("w")
    let frame = CGRect(x: 600, y: 100, width: 800, height: 600)
    let sole = CGWindowCandidate(windowId: 7, title: "Doc", bounds: frame, isOnscreen: true, layer: 0, zOrder: 0)
    func pairing(title: AXStringRead = .value("Doc"), origin: CGPoint = frame.origin, frameRead: Bool = true) -> WindowPairing? {
        let read = WindowPairingRead(title: title, frame: CGRect(origin: origin, size: frame.size), frameRead: frameRead)
        return pairWindows([window], candidates: [sole], read: { _ in read })[ObjectIdentifier(window)]
    }
    let whole = pairing()
    expect(whole?.candidate?.windowId == 7 && whole?.score == 110 && whole?.confidence == "exact" && whole?.unread == false, "a read pairing scores title, geometry and on-screen state")
    // A failed position read once read as the origin: 600 points off, the pairing lost 30 and dropped below 0.
    let unreadFrame = pairing(origin: .zero, frameRead: false)
    expect(unreadFrame?.candidate?.windowId == 7 && unreadFrame?.score == 110 && unreadFrame?.unread == true, "a failed frame read costs no geometry penalty and leaves the pairing unread")
    expect(unreadFrame?.confidence == "low", "a pairing without a read frame is low confidence")
    let unreadTitle = pairing(title: .failed)
    expect(unreadTitle?.candidate?.windowId == 7 && unreadTitle?.score == 10 && unreadTitle?.unread == true, "a failed title read adds no title score and leaves the pairing unread")
    let absentTitle = pairing(title: .absent)
    expect(absentTitle?.score == 10 && absentTitle?.unread == false, "an absent title is read as empty")
    let unpaired = pairWindows([window], candidates: [], read: { _ in WindowPairingRead(title: .failed, frame: .zero, frameRead: true) })[ObjectIdentifier(window)]
    expect(unpaired?.candidate == nil && unpaired?.unread == true, "a window left unpaired keeps its unread evidence")
    let far = pairing(title: .absent, origin: CGPoint(x: 0, y: 100))
    expect(far?.candidate == nil && far?.score == -20 && far?.unread == false, "an untitled read frame 600 points off the only candidate scores below 0 and stays unpaired")

    let parent = FakeRoot("parent")
    let first = FakeRoot("first")
    let second = FakeRoot("second")
    let own = CGWindowCandidate(windowId: 8, title: "Save", bounds: .zero, isOnscreen: true, layer: 0, zOrder: 1)
    let titled: (FakeRoot) -> WindowPairingRead = { WindowPairingRead(title: .value($0.name == "parent" ? "Doc" : "Save"), frame: .zero, frameRead: true) }
    let windowPairings = pairWindows([parent], candidates: [sole, own], read: titled)
    expect(windowPairings[ObjectIdentifier(parent)]?.candidate?.windowId == 7, "the window takes its own CG window")
    let alone = pairSheets([first], candidates: [sole], windowPairings: windowPairings, read: titled)[ObjectIdentifier(first)]
    expect(alone?.candidate == nil && alone?.score == -Double.greatestFiniteMagnitude, "a sheet whose window took the only candidate is unpaired")
    let sheets = pairSheets([first, second], candidates: [sole, own], windowPairings: windowPairings, read: titled)
    expect([first, second].compactMap { sheets[ObjectIdentifier($0)]?.candidate?.windowId } == [8], "two sheets never share one CG window")
}

/// Look geometry: screen frames scale into the image and clamp to it.
private func assertLookGeometry(_ bridge: Bridge) {
    let transform = bridge.rectTransform(windowFrame: CGRect(x: 100, y: 200, width: 200, height: 100), imageWidth: 400, imageHeight: 200)
    expect(transform(CGRect(x: 150, y: 225, width: 50, height: 25)) == CGRect(x: 100, y: 50, width: 100, height: 50), "frames scale by the image to window ratio")
    expect(transform(CGRect(x: 50, y: 150, width: 100, height: 100)) == CGRect(x: 0, y: 0, width: 100, height: 100), "frames clamp at the image origin")
    let unscaled = bridge.rectTransform(windowFrame: CGRect(x: 10, y: 10, width: 0, height: 0), imageWidth: 50, imageHeight: 40)
    expect(unscaled(CGRect(x: 20, y: 15, width: 100, height: 100)) == CGRect(x: 10, y: 5, width: 40, height: 35), "a zero-size window keeps scale 1 and clamps to the image")
    expect(bridge.clampRect(CGRect(x: 500, y: -50, width: 10, height: 10), width: 400, height: 200) == CGRect(x: 400, y: 0, width: 0, height: 0), "a rect outside the image collapses onto its edge")
}

/// OCR placement: duplicates of intersecting AX labels drop, text lands on the deepest non-picture
/// node, and text outside every node becomes a numbered picture-only node.
private func assertOCRPlacement(_ bridge: Bridge) {
    expect(bridge.normalizedLabel("  Save\n\tAS  ") == "save as" && bridge.normalizedLabel(" \n") == "", "labels lowercase and collapse whitespace")
    let save = lookNode("save", CGRect(x: 10, y: 10, width: 100, height: 40), title: "Save")
    let search = lookNode("search", CGRect(x: 200, y: 10, width: 150, height: 40), value: "Query", description: "Search")
    let logo = lookNode("logo", CGRect(x: 10, y: 100, width: 100, height: 50), title: "Logo", pictureOnly: true)
    let root = lookNode("root", CGRect(x: 0, y: 0, width: 400, height: 200), title: "Window", children: [save, search, logo])
    bridge.attachOCR([
        OCRBox(string: "  SAVE ", confidence: 0.9, rect: CGRect(x: 20, y: 15, width: 30, height: 10)),
        OCRBox(string: "search", confidence: 0.9, rect: CGRect(x: 210, y: 15, width: 20, height: 10)),
        OCRBox(string: " ", confidence: 0.9, rect: CGRect(x: 60, y: 20, width: 20, height: 10)),
        OCRBox(string: "Logo", confidence: 0.8, rect: CGRect(x: 20, y: 110, width: 30, height: 10)),
        OCRBox(string: "Cancel", confidence: 0.7, rect: CGRect(x: 60, y: 20, width: 20, height: 10)),
        OCRBox(string: "Footer", confidence: 0.6, rect: CGRect(x: 500, y: 300, width: 40, height: 10)),
        OCRBox(string: "Save", confidence: 0.5, rect: CGRect(x: 300, y: 150, width: 20, height: 10)),
    ], to: root)
    expect(save.text.count == 1 && save.text.first?["string"] as? String == "Cancel" && save.text.first?["confidence"] as? Double == 0.7 && rectFields(save.text.first?["rect"]) == [60, 20, 20, 10], "new text lands on the node containing its center")
    expect(search.text.isEmpty && logo.text.isEmpty, "duplicate labels drop and picture-only nodes never take text")
    expect(root.text.compactMap { $0["string"] as? String } == ["Logo", "Save"], "text over a picture-only node or away from a same-label node lands on the parent")
    let footer = root.children.last
    expect(root.children.count == 4 && footer?.ref == "pic_1" && footer?.pictureOnly == true && footer?.role == "AXImage" && footer?.title == "Footer" && footer?.rect == CGRect(x: 500, y: 300, width: 40, height: 10), "text outside the root becomes a picture-only root child")
    let inner = lookNode("inner", CGRect(x: 10, y: 10, width: 50, height: 50))
    let pictureRoot = lookNode("menu", CGRect(x: 0, y: 0, width: 100, height: 100), pictureOnly: true, children: [inner])
    bridge.attachOCR([
        OCRBox(string: "Inner", confidence: 1, rect: CGRect(x: 20, y: 20, width: 10, height: 10)),
        OCRBox(string: "Edge", confidence: 1, rect: CGRect(x: 75, y: 75, width: 10, height: 10)),
    ], to: pictureRoot)
    expect(inner.children.map(\.ref) == ["pic_1"] && inner.children.first?.title == "Inner" && pictureRoot.children.map(\.ref) == ["inner", "pic_2"], "picture-only text nests under the deepest container and numbers in order")
}

/// AX source classification.
private func assertAXSource(_ bridge: Bridge) {
    for (role, insideWebArea, isBrowser, containsWebArea, source) in [
        ("AXGroup", true, false, false, "web_content_ax"), ("AXWebArea", false, true, false, "web_content_ax"),
        ("AXButton", false, true, false, "browser_chrome_ax"), ("AXButton", false, false, true, "browser_chrome_ax"),
        ("AXButton", false, false, false, "desktop_ax"),
    ] {
        expect(bridge.axSource(role: role, insideWebArea: insideWebArea, isBrowser: isBrowser, containsWebArea: containsWebArea) == source, "axSource(\(role), \(insideWebArea), \(isBrowser), \(containsWebArea)) is \(source)")
    }
}

/// Root identities and post-action deltas.
private func assertRootIdentityAndDelta(_ bridge: Bridge) {
    expect(bridge.rootIdentity(["windowId": 7, "title": "Ignored"]) == "window:7", "a CG window id identifies the root")
    expect(bridge.rootIdentity([:]) == "meta:window:::0,0,0,0", "metadata identity defaults every field")
    let sheet: [String: Any] = ["windowId": 0, "kind": "sheet", "role": "AXSheet", "title": "Save", "framePoints": ["x": 10.9, "y": -3.2, "w": NSNumber(value: 300), "h": 200]]
    expect(bridge.rootIdentity(sheet) == "meta:sheet:AXSheet:Save:10,-3,300,200", "an unpaired root is identified by kind, role, title and truncated frame")
    let unrepresentable: [String: Any] = ["framePoints": ["x": Double.nan, "y": Double.infinity, "w": -Double.infinity, "h": 1e300]]
    expect(bridge.rootIdentity(unrepresentable) == "meta:window:::0,0,0,0", "NaN, infinite and out-of-range coordinates fall back to 0 instead of trapping")
    let edges: [String: Any] = ["framePoints": ["x": -0.9, "y": 0.9, "w": -0x1p63, "h": 0x1p63]]
    expect(bridge.rootIdentity(edges) == "meta:window:::0,0,\(Int.min),0", "fractions truncate toward zero and only coordinates an Int holds survive")
    let minimal = bridge.rootDeltaItem(change: "closed", root: [:], pid: 5)
    expect(minimal.count == 4 && minimal["change"] as? String == "closed" && minimal["kind"] as? String == "window" && minimal["title"] as? String == "" && minimal["pid"] as? Int == 5, "delta items default kind, title and pid")
    let full = bridge.rootDeltaItem(change: "appeared", root: ["kind": "sheet", "title": "T", "pid": 9, "isModal": true, "metadata": ["sheetCount": 1], "rootRef": "ax:1", "windowRef": "w:1"], pid: 5)
    expect(full.count == 7 && full["pid"] as? Int == 9 && full["isModal"] as? Bool == true && (full["metadata"] as? [String: Any])?["sheetCount"] as? Int == 1 && full["ref"] as? String == "ax:1", "delta items carry modality, metadata and the root ref first")
    expect(bridge.rootDeltaItem(change: "focused", root: ["windowRef": "w:2"], pid: 5)["ref"] as? String == "w:2", "delta items fall back to the window ref")
    func complete(_ roots: [String: [String: Any]]) -> RootInventorySnapshot { RootInventorySnapshot(roots: roots, complete: true) }
    let closedOnly = bridge.rootSnapshotDelta(before: complete(["window:7": ["title": "Gone"], "meta:sheet:AXSheet:Save:10,-3,300,200": sheet]), after: complete([:]), pid: 5)
    expect(closedOnly.count == 2 && closedOnly.allSatisfy { $0["change"] as? String == "closed" && $0["pid"] as? Int == 5 } && Set(closedOnly.compactMap { $0["title"] as? String }) == ["Gone", "Save"], "every root missing after the action closes")
    let before: [String: [String: Any]] = [
        "window:7": ["title": "Gone"], "window:8": ["title": "Kept", "isFocused": false], "window:9": ["title": "Still focused", "isFocused": true],
    ]
    let after: [String: [String: Any]] = [
        "window:8": ["title": "Kept", "isFocused": true], "window:9": ["title": "Still focused", "isFocused": true],
        "window:10": ["title": "New", "kind": "sheet"], "window:11": ["title": "New focused", "isFocused": true],
    ]
    let changes = bridge.rootSnapshotDelta(before: complete(before), after: complete(after), pid: 5).map { "\($0["change"] as? String ?? "?"):\($0["title"] as? String ?? "?")" }
    expect(changes.sorted() == ["appeared:New", "appeared:New focused", "closed:Gone", "focused:Kept", "focused:New focused"], "deltas report appeared, closed and newly focused roots, not roots that stayed focused")
    expect(changes.firstIndex(of: "closed:Gone").map { index in changes[..<index].allSatisfy { $0.hasPrefix("appeared:") } && changes[(index + 1)...].allSatisfy { $0.hasPrefix("focused:") } } == true, "appeared roots come first, then closed, then focused")
    expect(bridge.rootSnapshotDelta(before: complete(after), after: complete(after), pid: 5).isEmpty, "an unchanged snapshot has no delta")
    assertUnidentifiedRoots(bridge)
}

/// An unpaired root whose identity fields failed to read, or whose identity another root shares, is never compared
/// across listings: it neither closes, appears nor gains focus, and it keeps a missing root from proving closure (#1287).
private func assertUnidentifiedRoots(_ bridge: Bridge) {
    func root(_ ref: String, title: String, windowId: Int? = nil, focused: Bool = false) -> [String: Any] {
        var root: [String: Any] = ["rootRef": ref, "kind": "window", "role": "AXWindow", "title": title, "isFocused": focused, "framePoints": ["x": 10, "y": 20, "w": 300, "h": 200]]
        if let windowId { root["windowId"] = windowId }
        return root
    }
    func snapshot(_ roots: [[String: Any]], complete: Bool = true, unidentified: Set<String> = []) -> RootInventorySnapshot {
        RootInventorySnapshot(roots: roots, complete: complete, unidentifiedRefs: unidentified, identity: bridge.rootIdentity)
    }
    func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> [String] {
        bridge.rootSnapshotDelta(before: before, after: after, pid: 5).map { "\($0["change"] as? String ?? "?"):\($0["title"] as? String ?? "?")" }.sorted()
    }
    let readable = [root("r1", title: "Doc"), root("r2", title: "Paired", windowId: 7)]
    let whole = snapshot(readable)
    expect(whole.complete && Set(whole.roots.keys) == ["meta:window:AXWindow:Doc:10,20,300,200", "window:7"], "read roots keep their identity in a complete snapshot")
    expect(snapshot(readable, complete: false).complete == false, "an incomplete listing stays incomplete")

    // The same live unpaired window, its title unread on one side: the failed read changes its metadata key.
    let unreadTitle = [root("r1", title: "", focused: true), root("r2", title: "Paired", windowId: 7)]
    let unidentified = snapshot(unreadTitle, unidentified: ["r1"])
    expect(!unidentified.complete && Set(unidentified.roots.keys) == ["window:7"], "an unidentified root is left out and the snapshot is incomplete")
    expect(changes(whole, unidentified).isEmpty, "a root unidentified after the action is neither closed nor appeared, nor focused")
    expect(changes(unidentified, whole).isEmpty, "a root unidentified before the action is neither closed nor appeared")
    let paired = snapshot([root("r2", title: "", windowId: 7)], unidentified: ["r9"])
    expect(paired.complete && paired.roots["window:7"] != nil, "an unidentified ref names only the roots it lists")

    // Two live roots with one identity, e.g. both reading as untitled at the origin: neither can be told apart.
    let twins = [root("r3", title: ""), root("r4", title: ""), root("r5", title: ""), root("r2", title: "Paired", windowId: 7)]
    let ambiguous = snapshot(twins)
    expect(!ambiguous.complete && Set(ambiguous.roots.keys) == ["window:7"], "roots sharing an identity are all left out and the snapshot is incomplete")
    expect(changes(whole, ambiguous).isEmpty && changes(ambiguous, whole).isEmpty, "ambiguous roots prove no closure or appearance")
    let closedBesideUnknown = snapshot([root("r1", title: "")], unidentified: ["r1"])
    expect(changes(whole, closedBesideUnknown).isEmpty, "a paired root missing next to an unidentified one is not proven closed")
    assertRootIdentityEligibility()
    assertClassifiedIdentity(bridge)

}

/// Which reads decide a root's identity (`RootIdentityField`, `rootIdentityComparable`): a sheet's own title stands on
/// its own read, and only a title it took from its window inherits that window's failed read (#1287).
private func assertRootIdentityEligibility() {
    let unreadWindowTitle = RootIdentityField(.failed)
    expect(unreadWindowTitle == RootIdentityField(value: "", read: false), "a failed read keeps the fallback's value, unread")
    expect(RootIdentityField(.failed, fallback: RootIdentityField(value: "Doc")) == RootIdentityField(value: "Doc", read: false), "a failed read falls back to the fallback's value")
    let ownTitle = RootIdentityField(.value("Save"), fallback: unreadWindowTitle)
    let borrowedTitle = RootIdentityField(.absent, fallback: unreadWindowTitle)
    expect(ownTitle == RootIdentityField(value: "Save") && borrowedTitle == unreadWindowTitle, "an absent read takes the fallback whole, a read value ignores it")
    let unpaired = WindowPairing(candidate: nil, score: -1, confidence: "low")
    let sheetRole = RootIdentityField(.absent, fallback: RootIdentityField(value: "AXSheet"))
    expect(rootIdentityComparable(pairing: unpaired, fields: [ownTitle, sheetRole, RootIdentityField(.absent)], frameRead: true), "a sheet with its own title is comparable though its window's title read failed")
    expect(!rootIdentityComparable(pairing: unpaired, fields: [borrowedTitle, sheetRole], frameRead: true), "a sheet that took its window's unread title is not")
    expect(!rootIdentityComparable(pairing: unpaired, fields: [ownTitle], frameRead: false), "an unpaired root with an unread frame is not")
    let candidate = CGWindowCandidate(windowId: 7, title: "", bounds: .zero, isOnscreen: true, layer: 0, zOrder: 0)
    expect(rootIdentityComparable(pairing: WindowPairing(candidate: candidate, score: 10, confidence: "low"), fields: [borrowedTitle], frameRead: false), "a paired root is keyed by its CG window id whatever its metadata reads")
    var unreadPairing = WindowPairing(candidate: candidate, score: 10, confidence: "low")
    unreadPairing.unread = true
    expect(!rootIdentityComparable(pairing: unreadPairing, fields: [ownTitle], frameRead: true), "a pairing that read partial evidence is not comparable, paired or not")
    var unreadUnpaired = unpaired
    unreadUnpaired.unread = true
    expect(!rootIdentityComparable(pairing: unreadUnpaired, fields: [ownTitle], frameRead: true), "nor is a window it left unpaired")
    var contested = WindowPairing(candidate: candidate, score: 10, confidence: "low")
    contested.contested = true
    expect(!rootIdentityComparable(pairing: contested, fields: [ownTitle], frameRead: true), "a contested pairing is not comparable")
    var contestedUnpaired = unpaired
    contestedUnpaired.contested = true
    expect(!rootIdentityComparable(pairing: contestedUnpaired, fields: [ownTitle], frameRead: true), "nor is a root a contested pairing left unpaired")
}

/// Scripted AX reads for one listing, read in production order through `RootInventoryWorld.classify` and `rootEntries`
/// into the snapshot `rootMetadataSnapshot` builds. `fail["doc.position"] = [true]` fails only the first position read
/// of `doc` (its pairing read); later reads of it answer.
private final class FakeListing {
    let windows: [FakeRoot]
    var sheets: [String: [FakeRoot]] = [:]
    var frames: [String: CGRect] = [:]
    var titles: [String: AXStringRead] = [:]
    /// Windows read `AXWindow`; a sheet's role is absent and falls back to `AXSheet`.
    var roles: [String: AXStringRead] = ["doc": .value("AXWindow")]
    var fail: [String: [Bool]] = [:]
    /// State replies by `"<root>.<attribute>"`, e.g. `"doc.focused"`, decoded as production does (`rootStateBoolean`);
    /// a missing one failed.
    var states: [String: AnyObject] = [:]
    var candidates: [CGWindowCandidate] = []
    static let frame = CGRect(x: 600, y: 100, width: 800, height: 600)
    init(_ windows: [FakeRoot]) { self.windows = windows }

    private func fails(_ root: FakeRoot, _ attribute: String) -> Bool {
        let key = "\(root.name).\(attribute)"
        guard var queue = fail[key], !queue.isEmpty else { return false }
        let next = queue.removeFirst()
        fail[key] = queue
        return next
    }
    private func position(_ root: FakeRoot) -> CGPoint? { fails(root, "position") ? nil : frames[root.name, default: FakeListing.frame].origin }
    private func size(_ root: FakeRoot) -> AXSizeRead { fails(root, "size") ? .failed : .size(frames[root.name, default: FakeListing.frame].size) }
    private func string(_ root: FakeRoot, _ attribute: RootIdentityAttribute) -> AXStringRead {
        switch attribute {
        case .title: return fails(root, "title") ? .failed : titles[root.name] ?? .absent
        case .role: return fails(root, "role") ? .failed : roles[root.name] ?? .absent
        case .subrole: return fails(root, "subrole") ? .failed : .absent
        }
    }
    /// One position and one size read, as `Bridge.frameRead` reads them.
    private func frameRead(_ root: FakeRoot) -> (frame: CGRect, read: Bool) {
        let origin = position(root)
        let sized = size(root)
        var value = CGSize.zero
        if case .size(let size) = sized { value = size }
        return (CGRect(origin: origin ?? .zero, size: value), origin != nil && sized != .failed)
    }
    var world: RootInventoryWorld<FakeRoot> {
        RootInventoryWorld(
            windows: WindowInventoryWorld(
                windows: { self.windows }, fallbackWindows: { [] }, position: { self.position($0) }, size: { self.size($0) },
                sheets: { (self.sheets[$0.name] ?? [], true) }),
            string: { self.string($0, $1) },
            frame: { self.frameRead($0) },
            // As `Bridge.pairingRead`: one frame read and one title read.
            pairingRead: { root in
                let (frame, read) = self.frameRead(root)
                return WindowPairingRead(title: self.string(root, .title), frame: frame, frameRead: read)
            },
            state: { rootStateBoolean(self.states["\($0.name).\($1)"]) })
    }
    func classify(_ bridge: Bridge) -> (snapshot: RootInventorySnapshot, windows: [ClassifiedWindow<FakeRoot>], entries: [[String: Any]]) {
        let inventory = world.classify(candidates: candidates)
        let entries = rootEntries(inventory.windows, ref: { $0.name }) { _, sheet in ["title": "extra", "isFocused": sheet == nil] }
        let snapshot = RootInventorySnapshot(roots: entries.roots, complete: inventory.complete, unidentifiedRefs: entries.unidentified, identity: bridge.rootIdentity)
        return (snapshot, inventory.windows, entries.roots)
    }
}

/// `rootDelta` between two snapshots as sorted `"<change>:<ref>"` strings.
private func refChanges(_ bridge: Bridge, _ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> [String] {
    bridge.rootSnapshotDelta(before: before, after: after, pid: 5).map { "\($0["change"] as? String ?? "?"):\($0["ref"] as? String ?? "?")" }.sorted()
}

/// A failed pairing or identity read, injected below production classification, keeps the root out of `rootDelta`
/// (#1287): a later successful read of the same field never vouches for the failed one.
private func assertClassifiedIdentity(_ bridge: Bridge) {
    func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> [String] { refChanges(bridge, before, after) }
    let doc = FakeRoot("doc")
    func paired(_ fail: [String: [Bool]] = [:]) -> FakeListing {
        let listing = FakeListing([doc])
        listing.candidates = [CGWindowCandidate(windowId: 7, title: "", bounds: FakeListing.frame, isOnscreen: true, layer: 0, zOrder: 0)]
        listing.fail = fail
        return listing
    }
    // An untitled window paired with its sole on-screen CG window. Only the pairing pass's position read fails
    // afterward; the inventory's own position read answers.
    let before = paired().classify(bridge)
    expect(before.snapshot.complete && Set(before.snapshot.roots.keys) == ["window:7"], "a read pairing keys the root by its CG window id")
    let after = paired(["doc.position": [true]]).classify(bridge)
    let root = after.windows.first?.root
    expect(after.windows.first?.window.axFrameRead == true, "the inventory's own frame reads answered")
    expect(root?.pairing.candidate?.windowId == 7 && root?.pairing.unread == true, "a failed pairing position read keeps the sole candidate and marks the pairing unread")
    expect(root?.comparable == false && !after.snapshot.complete && after.snapshot.roots.isEmpty, "the root is left out and the snapshot is incomplete")
    expect(changes(before.snapshot, after.snapshot).isEmpty && changes(after.snapshot, before.snapshot).isEmpty, "a failed pairing read never reports the live window closed and reappeared")

    func unpaired(_ fail: [String: [Bool]] = [:], sheets: [FakeRoot] = [], sheetTitles: [String: AXStringRead] = [:]) -> FakeListing {
        let listing = FakeListing([doc])
        listing.titles = sheetTitles.merging(["doc": .value("Doc")]) { first, _ in first }
        listing.sheets = ["doc": sheets]
        listing.fail = fail
        return listing
    }
    let read = unpaired().classify(bridge)
    expect(read.snapshot.complete && Set(read.snapshot.roots.keys) == ["meta:window:AXWindow:Doc:600,100,800,600"], "an unpaired read root keys by its metadata")
    // The pairing pass reads the title first; the identity read after it fails.
    let unreadTitle = unpaired(["doc.title": [false, true]]).classify(bridge)
    expect(unreadTitle.windows.first?.root.pairing.unread == false && unreadTitle.windows.first?.root.title == RootIdentityField(value: "", read: false), "only the identity title read failed")
    expect(!unreadTitle.snapshot.complete && unreadTitle.snapshot.roots.isEmpty, "an unpaired root with an unread title is left out and the snapshot is incomplete")
    expect(changes(read.snapshot, unreadTitle.snapshot).isEmpty && changes(unreadTitle.snapshot, read.snapshot).isEmpty, "a failed title read neither closes nor reopens the root")
    let unreadPosition = unpaired(["doc.position": [false, true]]).classify(bridge)
    expect(unreadPosition.windows.first?.window.axFrameRead == false && unreadPosition.snapshot.roots.isEmpty && !unreadPosition.snapshot.complete, "a failed inventory position read leaves the unpaired root out")
    expect(changes(read.snapshot, unreadPosition.snapshot).isEmpty, "a failed position read neither closes nor reopens the root")

    // A failed window title read touches only the sheet that took that title.
    let own = FakeRoot("own")
    let bare = FakeRoot("bare")
    let sheeted = unpaired(["doc.title": [false, true]], sheets: [own, bare], sheetTitles: ["own": .value("Save")]).classify(bridge)
    let sheets = sheeted.windows.first?.sheets ?? []
    expect(sheets.map(\.title) == [RootIdentityField(value: "Save"), RootIdentityField(value: "", read: false)], "a sheet without a title takes its window's, read or not")
    expect(sheets.map(\.comparable) == [true, false] && sheets.map(\.kind) == ["sheet", "sheet"], "only the sheet that took the unread title is unidentified")
    expect(Set(sheeted.snapshot.roots.keys) == ["meta:sheet:AXSheet:Save:600,100,800,600"] && !sheeted.snapshot.complete, "the sheet with its own title stays in the snapshot")

    let entries = sheeted.entries
    expect(entries.map { $0["rootRef"] as? String } == ["doc", "own", "bare"] && entries.map { $0["windowRef"] as? String } == ["doc", "own", "bare"], "each window is followed by its sheets")
    expect(entries.map { $0["title"] as? String } == ["", "Save", ""], "identity fields override the extras")
    expect(entries.allSatisfy { $0["isFocused"] == nil } && entries.first?["isMain"] == nil, "an unread state flag is left out, whatever the extras say")
    expect(entries.allSatisfy { $0["windowId"] == nil } && before.entries.first?["windowId"] as? Int == 7, "only a paired root carries its CG window id")

    // A sheet without a CG window of its own: its window's is the only candidate, and the sheet scores for it too.
    let sheet = FakeRoot("sheet")
    let borrowed = paired()
    borrowed.sheets = ["doc": [sheet]]
    borrowed.titles = ["sheet": .value("Save")]
    let open = borrowed.classify(bridge)
    expect(open.entries.map { $0["windowId"] as? Int } == [7, nil], "a sheet never borrows its window's CG window id")
    expect(open.snapshot.roots.isEmpty && !open.snapshot.complete, "a window and a sheet that both claim one CG window are both unidentified")
    let sheetFrame = CGRect(x: 700, y: 150, width: 400, height: 300)
    let inset = paired()
    inset.sheets = ["doc": [sheet]]
    inset.titles = ["sheet": .value("Save")]
    inset.frames = ["sheet": sheetFrame]
    let insetSheet = inset.classify(bridge)
    expect(insetSheet.entries.map { $0["windowId"] as? Int } == [7, nil], "an inset sheet does not claim its window's CG window")
    expect(Set(insetSheet.snapshot.roots.keys) == ["window:7", "meta:sheet:AXSheet:Save:700,150,400,300"] && insetSheet.snapshot.complete, "the sheet keeps its own metadata identity beside its window")
    let separate = paired()
    separate.sheets = ["doc": [sheet]]
    separate.frames = ["sheet": sheetFrame]
    separate.candidates.append(CGWindowCandidate(windowId: 8, title: "", bounds: sheetFrame, isOnscreen: true, layer: 0, zOrder: 1))
    let separated = separate.classify(bridge)
    expect(separated.entries.map { $0["windowId"] as? Int } == [7, 8], "a sheet with a CG window of its own pairs with it")
    expect(Set(separated.snapshot.roots.keys) == ["window:7", "window:8"] && separated.snapshot.complete, "exclusive claims key both roots by their CG window ids")
    assertContestedPairings(bridge)
    assertStateReads(bridge)
}

/// One conservative rule (`contestedClaims`): a CG candidate claimed by more than one root, or by a root whose pairing
/// read failed, keys none of its claimants, so neither the listing order nor an unread competitor moves an identity (#1287).
private func assertContestedPairings(_ bridge: Bridge) {
    func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> [String] { refChanges(bridge, before, after) }
    let frame = FakeListing.frame
    let titledDoc = CGWindowCandidate(windowId: 9, title: "Doc", bounds: frame, isOnscreen: false, layer: 0, zOrder: 0)
    let farFrame = CGRect(x: 0, y: 0, width: 800, height: 600)
    func read(_ title: AXStringRead, _ frame: CGRect, frameRead: Bool = true) -> WindowPairingRead {
        WindowPairingRead(title: title, frame: frame, frameRead: frameRead)
    }
    expect(contestedClaims([read(.value("Doc"), frame)], candidates: [titledDoc]) == [false], "a sole claimant of a sole candidate is exclusive")
    expect(contestedClaims([read(.value("Doc"), frame), read(.value("Other"), farFrame)], candidates: [titledDoc]) == [false, false], "a read root scoring below 0 claims nothing")
    expect(contestedClaims([read(.value("Doc"), frame), read(.failed, farFrame)], candidates: [titledDoc]) == [true, true], "an unread title claims a candidate it might match, so both claimants are contested")
    expect(contestedClaims([read(.value("Doc"), frame), read(.value("Doc"), farFrame)], candidates: [titledDoc]) == [true, true], "two read roots scoring 0 or more for one candidate are both contested")
    let second = CGWindowCandidate(windowId: 10, title: "Doc", bounds: farFrame, isOnscreen: false, layer: 0, zOrder: 1)
    expect(contestedClaims([read(.value("Doc"), frame)], candidates: [titledDoc, second]) == [true], "a root claiming two candidates is contested")
    expect(contestedClaims([read(.failed, frame)], candidates: []) == [false], "without candidates nothing is claimed")

    // Two windows, one on-screen untitled CG window: `a` scores 9 for it, `b` far below 0. A failed pairing position
    // read lifts `b` to 10, so `b` takes it and `a` loses its CG id.
    let a = FakeRoot("a")
    let b = FakeRoot("b")
    func competitors(_ fail: [String: [Bool]] = [:]) -> FakeListing {
        let listing = FakeListing([a, b])
        listing.frames = ["a": CGRect(x: 620, y: 100, width: 800, height: 600), "b": farFrame]
        listing.titles = ["a": .value("A"), "b": .value("B")]
        listing.candidates = [CGWindowCandidate(windowId: 9, title: "", bounds: frame, isOnscreen: true, layer: 0, zOrder: 0)]
        listing.fail = fail
        return listing
    }
    let whole = competitors().classify(bridge)
    expect(whole.snapshot.complete && Set(whole.snapshot.roots.keys) == ["window:9", "meta:window::B:0,0,800,600"], "the read listing keys `a` by its CG window id")
    let unread = competitors(["b.position": [true]]).classify(bridge)
    expect(unread.entries.map { $0["windowId"] as? Int } == [nil, 9], "the unread competitor takes the candidate")
    expect(unread.snapshot.roots.isEmpty && !unread.snapshot.complete, "both claimants of the candidate are unidentified")
    expect(changes(whole.snapshot, unread.snapshot).isEmpty && changes(unread.snapshot, whole.snapshot).isEmpty, "an unread competitor reports no change in either direction")

    // Two sheets with distinct titles and equal geometry score alike for one leftover untitled CG window: the
    // listing order alone would decide which one takes it.
    let doc = FakeRoot("doc")
    let save = FakeRoot("save")
    let export = FakeRoot("export")
    let sheetFrame = CGRect(x: 700, y: 150, width: 400, height: 300)
    func sheets(_ order: [FakeRoot]) -> FakeListing {
        let listing = FakeListing([doc])
        listing.sheets = ["doc": order]
        listing.frames = ["save": sheetFrame, "export": sheetFrame]
        listing.titles = ["save": .value("Save"), "export": .value("Export")]
        listing.candidates = [
            CGWindowCandidate(windowId: 7, title: "", bounds: frame, isOnscreen: true, layer: 0, zOrder: 0),
            CGWindowCandidate(windowId: 8, title: "", bounds: sheetFrame, isOnscreen: true, layer: 0, zOrder: 1),
        ]
        return listing
    }
    let forward = sheets([save, export]).classify(bridge)
    let reverse = sheets([export, save]).classify(bridge)
    expect(forward.entries.map { $0["windowId"] as? Int } == [7, 8, nil] && reverse.entries.map { $0["windowId"] as? Int } == [7, 8, nil], "the first sheet listed takes the candidate")
    expect(Set(forward.snapshot.roots.keys) == ["window:7"] && Set(reverse.snapshot.roots.keys) == ["window:7"], "only the window keeps its identity")
    expect(!forward.snapshot.complete && !reverse.snapshot.complete, "the contested sheets leave both snapshots incomplete")
    expect(changes(forward.snapshot, reverse.snapshot).isEmpty && changes(reverse.snapshot, forward.snapshot).isEmpty, "reordering the sheets reports no change")
}

/// `AXFocused`, `AXMain` and `AXMinimized` are reported only as read (`RootState`): a failed or non-boolean reply is
/// left out, never `false`, so `rootDelta` never reports a focus change from it, and a sheet never reports its window's
/// focus (#1303).
private func assertStateReads(_ bridge: Bridge) {
    func changes(_ before: RootInventorySnapshot, _ after: RootInventorySnapshot) -> [String] { refChanges(bridge, before, after) }
    let yes: AnyObject = kCFBooleanTrue
    let no: AnyObject = kCFBooleanFalse
    expect(rootStateBoolean(yes) == true && rootStateBoolean(no) == false, "a CFBoolean reply is read")
    expect(rootStateBoolean(true as NSNumber) == true && rootStateBoolean(NSNumber(value: false)) == false, "a bridged Bool is a CFBoolean")
    expect([0, 1, 2].allSatisfy { rootStateBoolean(NSNumber(value: $0)) == nil }, "a numeric reply, even 0 or 1, is not a boolean")
    expect(rootStateBoolean(nil) == nil && rootStateBoolean("true" as NSString) == nil, "a missing or non-boolean reply is unknown")

    func snapshot(_ roots: [String: [String: Any]]) -> RootInventorySnapshot { RootInventorySnapshot(roots: roots, complete: true) }
    let unread: [String: Any] = ["rootRef": "w"]
    let unfocused: [String: Any] = ["rootRef": "w", "isFocused": false]
    let focused: [String: Any] = ["rootRef": "w", "isFocused": true]
    expect(changes(snapshot(["k": unfocused]), snapshot(["k": focused])) == ["focused:w"], "a root read unfocused, then focused, gained focus")
    expect(changes(snapshot(["k": unread]), snapshot(["k": focused])).isEmpty, "a root whose focus read failed before the action never gained focus")
    expect(changes(snapshot(["k": focused]), snapshot(["k": unread])).isEmpty && changes(snapshot(["k": unfocused]), snapshot(["k": unread])).isEmpty, "nor does one whose read failed after it")

    // A window paired with its own CG window, so its identity is read on both sides; only its state replies vary.
    let doc = FakeRoot("doc")
    let sheet = FakeRoot("sheet")
    func listing(_ states: [String: AnyObject], onscreen: Bool? = true) -> FakeListing {
        let listing = FakeListing([doc])
        listing.sheets = ["doc": [sheet]]
        listing.titles = ["sheet": .value("Save")]
        listing.frames = ["sheet": CGRect(x: 700, y: 150, width: 400, height: 300)]
        if let onscreen { listing.candidates = [CGWindowCandidate(windowId: 7, title: "", bounds: FakeListing.frame, isOnscreen: onscreen, layer: 0, zOrder: 0)] }
        listing.states = states
        return listing
    }
    let failed = listing(["doc.main": yes]).classify(bridge)
    expect(failed.windows.first?.root.state == RootState(focused: nil, main: true, minimized: nil), "each state flag keeps its own read")
    let window = failed.entries.first ?? [:]
    expect(window["isFocused"] == nil && window["isMinimized"] == nil && window["isMain"] as? Bool == true, "an unread flag is left out of the entry, a read one is kept")
    expect(failed.snapshot.complete && Set(failed.snapshot.roots.keys) == ["window:7", "meta:sheet:AXSheet:Save:700,150,400,300"], "a failed state read leaves the identity comparable")
    let read = listing(["doc.focused": no]).classify(bridge)
    let gained = listing(["doc.focused": yes]).classify(bridge)
    expect(changes(read.snapshot, gained.snapshot) == ["focused:doc"], "a window read unfocused, then focused, gained focus")
    expect(changes(failed.snapshot, gained.snapshot).isEmpty, "a failed focus read before the action reports no focus change")
    expect(changes(gained.snapshot, failed.snapshot).isEmpty, "nor after it")
    let numeric = listing(["doc.focused": NSNumber(value: 0), "doc.minimized": NSNumber(value: 2)]).classify(bridge)
    expect(numeric.entries.first.map { $0["isFocused"] == nil && $0["isMinimized"] == nil } == true, "a numeric reply is left out")
    expect(changes(numeric.snapshot, gained.snapshot).isEmpty, "a numeric 0 before a boolean true reports no focus change")

    // The sheet reads its own `AXFocused`, never its window's.
    let sheets = gained.entries.dropFirst()
    expect(sheets.count == 1 && sheets.allSatisfy { $0["isFocused"] == nil }, "a sheet whose own focus read failed does not take its window's")
    expect(sheets.allSatisfy { $0["isMain"] as? Bool == false && $0["isMinimized"] as? Bool == false }, "a sheet is never main or minimized")
    let ownFocus = listing(["doc.focused": yes, "sheet.focused": no]).classify(bridge)
    expect(ownFocus.entries.map { $0["isFocused"] as? Bool } == [true, false], "a sheet reports its own focus read")
    let sheetGained = listing(["doc.focused": yes, "sheet.focused": yes]).classify(bridge)
    expect(changes(ownFocus.snapshot, sheetGained.snapshot) == ["focused:sheet"], "a sheet read unfocused, then focused, gained focus")

    // `isOnscreen`: the paired CG window's, else the read `isMinimized` negated, else unknown; a sheet without a CG
    // window of its own takes its window's.
    expect(gained.entries.map { $0["isOnscreen"] as? Bool } == [true, true], "a paired window and its sheet are on screen as their CG window is")
    expect(listing([:], onscreen: false).classify(bridge).entries.map { $0["isOnscreen"] as? Bool } == [false, false], "an off-screen CG window is off screen")
    expect(listing(["doc.minimized": yes], onscreen: nil).classify(bridge).entries.map { $0["isOnscreen"] as? Bool } == [false, false], "an unpaired minimized window is off screen")
    expect(listing(["doc.minimized": no], onscreen: nil).classify(bridge).entries.map { $0["isOnscreen"] as? Bool } == [true, true], "an unpaired window read not minimized is on screen")
    let unknown = listing([:], onscreen: nil).classify(bridge).entries
    expect(unknown.count == 2 && unknown.allSatisfy { $0["isOnscreen"] == nil }, "an unpaired window whose minimized read failed has no `isOnscreen`")
}
