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

/// Drive the pure root, CG window-list, AX/CG pairing, look geometry and OCR placement policy in
/// `Bridge` with synthetic window lists and detached look trees. The only live reads are AX queries
/// on application handles above the macOS pid range, which no process answers, and the read-only CG
/// window list that `rootDelta` enumerates for that absent pid. Input goes to the fail-fast sink.
func runRootPairingAssertions() {
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink)
    let absentPid = Int32.max
    let popupLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
    let usable = boundsDictionary(CGRect(x: 1, y: 2, width: 300, height: 200))

    // Root ranking, kind and metadata.
    expect(bridge.scoreWindow([:]) == 0, "a window without state scores 0")
    expect(bridge.scoreWindow(["isFocused": true, "isMain": true, "isMinimized": false, "isOnscreen": true, "windowId": 9]) == 250, "every ranking signal adds its weight")
    expect(bridge.scoreWindow(["isFocused": false, "isMain": "yes", "isMinimized": true, "isOnscreen": false]) == 0, "false, minimized and non-boolean state add nothing")
    for (role, subrole, kind) in [
        ("AXSheet", "AXDialog", "sheet"), ("AXWindow", "AXSystemPopover", "popover"), ("AXWindow", "AXSystemDialog", "dialog"),
        ("AXDialog", "", "dialog"), ("AXWindow", "AXStandardWindow", "window"),
    ] {
        expect(bridge.rootKind(role: role, subrole: subrole) == kind, "rootKind(\(role), \(subrole)) is \(kind)")
    }
    let metadata = bridge.rootMetadata(pairing: WindowPairing(candidate: nil, score: 12.5, confidence: "high"), sheetCount: 2)
    let pairingMetadata = metadata["pairing"] as? [String: Any]
    expect(metadata.count == 2 && metadata["sheetCount"] as? Int == 2 && pairingMetadata?["confidence"] as? String == "high" && pairingMetadata?["score"] as? Double == 12.5, "root metadata carries pairing confidence, score and sheet count")

    // Same-pid CG window candidates: only layer-0 windows with a number and parseable bounds.
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

    // Popup menus: popup level and on screen, from one pid or any pid.
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

    // Window owners: one per pid, layer 0, at least 100x80 points.
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

    // Broad discovery owners also accept on-screen popup menus of any size.
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

    // AX/CG pairing scores and confidence.
    let frame = CGRect(x: 0, y: 0, width: 200, height: 100)
    let near = CGWindowCandidate(windowId: 1, title: " report ", bounds: CGRect(x: 10, y: 20, width: 210, height: 100), isOnscreen: true, layer: 0, zOrder: 0)
    expect(bridge.windowPairScore(frame: frame, title: "Report", candidate: near) == 108, "equal titles add 100, geometry subtracts its distance over 20, on screen adds 10")
    expect(bridge.windowPairScore(frame: frame, title: "Report - Draft", candidate: near) == 58, "a contained title adds 50")
    expect(bridge.windowPairScore(frame: frame, title: "", candidate: near) == 8, "an empty title adds nothing")
    let offscreen = CGWindowCandidate(windowId: 2, title: "Other", bounds: CGRect(x: 900, y: 900, width: 10, height: 10), isOnscreen: false, layer: 0, zOrder: 1)
    expect(bridge.windowPairScore(frame: .zero, title: "Report", candidate: offscreen) == 0, "a degenerate frame skips geometry and off-screen adds nothing")
    let exactCandidate = CGWindowCandidate(windowId: 3, title: "Report", bounds: CGRect(x: 2, y: -2, width: 202, height: 98), isOnscreen: true, layer: 0, zOrder: 2)
    expect(bridge.pairingConfidence(frame: CGRect(x: 0, y: 0, width: 1, height: 100), title: "Report", candidate: exactCandidate, score: 500) == "low", "a degenerate frame is low confidence")
    expect(bridge.pairingConfidence(frame: frame, title: " report", candidate: exactCandidate, score: 0) == "exact", "equal titles within 2 points are exact")
    let shifted = CGWindowCandidate(windowId: 4, title: "Report", bounds: CGRect(x: 3, y: 0, width: 200, height: 100), isOnscreen: true, layer: 0, zOrder: 3)
    expect(bridge.pairingConfidence(frame: frame, title: "Report", candidate: shifted, score: 50) == "high", "geometry beyond 2 points falls back to a score of 50 or more")
    expect(bridge.pairingConfidence(frame: frame, title: "Report", candidate: shifted, score: 49.9) == "low", "a score under 50 is low confidence")
    let untitled = CGWindowCandidate(windowId: 5, title: "", bounds: frame, isOnscreen: true, layer: 0, zOrder: 4)
    expect(bridge.pairingConfidence(frame: frame, title: "", candidate: untitled, score: 10) == "low", "exact geometry without equal titles is not exact")

    // One-to-one pairing over AX handles no process answers: frames and titles read empty, so only
    // on-screen state ranks the candidates.
    let windows = (0..<3).map { AXUIElementCreateApplication(absentPid - Int32($0)) }
    let pairings = bridge.windowPairings(windows: windows, candidates: [offscreen, near])
    let paired = windows.compactMap { pairings[ObjectIdentifier($0)] }
    let matched = paired.filter { $0.candidate != nil }
    expect(paired.count == 3 && Set(matched.compactMap { $0.candidate?.windowId }) == [1, 2] && matched.map(\.score).sorted() == [0, 10], "each candidate pairs with one window, best score first")
    expect(paired.allSatisfy { $0.confidence == "low" } && paired.filter { $0.candidate == nil }.map(\.score) == [-Double.greatestFiniteMagnitude], "the window left over is unpaired and every frameless pairing is low confidence")
    let unpaired = bridge.windowPairings(windows: [windows[0]], candidates: [])[ObjectIdentifier(windows[0])]
    expect(unpaired?.candidate == nil && unpaired?.confidence == "low", "windows without candidates are unpaired")
    expect(bridge.bestCandidate(for: windows[0], candidates: [offscreen, near])?.windowId == 1, "the best candidate is the highest score")
    expect(bridge.bestCandidate(for: windows[0], candidates: []) == nil, "no candidates means no best candidate")

    // Look geometry: screen frames scale into the image and clamp to it.
    let transform = bridge.rectTransform(windowFrame: CGRect(x: 100, y: 200, width: 200, height: 100), imageWidth: 400, imageHeight: 200)
    expect(transform(CGRect(x: 150, y: 225, width: 50, height: 25)) == CGRect(x: 100, y: 50, width: 100, height: 50), "frames scale by the image to window ratio")
    expect(transform(CGRect(x: 50, y: 150, width: 100, height: 100)) == CGRect(x: 0, y: 0, width: 100, height: 100), "frames clamp at the image origin")
    let unscaled = bridge.rectTransform(windowFrame: CGRect(x: 10, y: 10, width: 0, height: 0), imageWidth: 50, imageHeight: 40)
    expect(unscaled(CGRect(x: 20, y: 15, width: 100, height: 100)) == CGRect(x: 10, y: 5, width: 40, height: 35), "a zero-size window keeps scale 1 and clamps to the image")
    expect(bridge.clampRect(CGRect(x: 500, y: -50, width: 10, height: 10), width: 400, height: 200) == CGRect(x: 400, y: 0, width: 0, height: 0), "a rect outside the image collapses onto its edge")

    // OCR placement: duplicates of intersecting AX labels drop, text lands on the deepest
    // non-picture node, and text outside every node becomes a numbered picture-only node.
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

    // AX source classification.
    for (role, insideWebArea, isBrowser, containsWebArea, source) in [
        ("AXGroup", true, false, false, "web_content_ax"), ("AXWebArea", false, true, false, "web_content_ax"),
        ("AXButton", false, true, false, "browser_chrome_ax"), ("AXButton", false, false, true, "browser_chrome_ax"),
        ("AXButton", false, false, false, "desktop_ax"),
    ] {
        expect(bridge.axSource(role: role, insideWebArea: insideWebArea, isBrowser: isBrowser, containsWebArea: containsWebArea) == source, "axSource(\(role), \(insideWebArea), \(isBrowser), \(containsWebArea)) is \(source)")
    }

    // Root identities and post-action deltas.
    expect(bridge.rootIdentity(["windowId": 7, "title": "Ignored"]) == "window:7", "a CG window id identifies the root")
    expect(bridge.rootIdentity([:]) == "meta:window:::0,0,0,0", "metadata identity defaults every field")
    let sheet: [String: Any] = ["windowId": 0, "kind": "sheet", "role": "AXSheet", "title": "Save", "framePoints": ["x": 10.9, "y": -3.2, "w": NSNumber(value: 300), "h": 200]]
    expect(bridge.rootIdentity(sheet) == "meta:sheet:AXSheet:Save:10,-3,300,200", "an unpaired root is identified by kind, role, title and truncated frame")
    let minimal = bridge.rootDeltaItem(change: "closed", root: [:], pid: 5)
    expect(minimal.count == 4 && minimal["change"] as? String == "closed" && minimal["kind"] as? String == "window" && minimal["title"] as? String == "" && minimal["pid"] as? Int == 5, "delta items default kind, title and pid")
    let full = bridge.rootDeltaItem(change: "appeared", root: ["kind": "sheet", "title": "T", "pid": 9, "isModal": true, "metadata": ["sheetCount": 1], "rootRef": "ax:1", "windowRef": "w:1"], pid: 5)
    expect(full.count == 7 && full["pid"] as? Int == 9 && full["isModal"] as? Bool == true && (full["metadata"] as? [String: Any])?["sheetCount"] as? Int == 1 && full["ref"] as? String == "ax:1", "delta items carry modality, metadata and the root ref first")
    expect(bridge.rootDeltaItem(change: "focused", root: ["windowRef": "w:2"], pid: 5)["ref"] as? String == "w:2", "delta items fall back to the window ref")
    let delta = bridge.rootDelta(before: ["window:7": ["title": "Gone"], "meta:sheet:AXSheet:Save:10,-3,300,200": sheet], beforeFrontmostPid: nil, pid: absentPid)
    expect(delta.count == 2 && delta.allSatisfy { $0["change"] as? String == "closed" && $0["pid"] as? Int == Int(absentPid) } && Set(delta.compactMap { $0["title"] as? String }) == ["Gone", "Save"], "roots of an absent pid all close")

    print("macos root, pairing and OCR placement assertions passed")
}
