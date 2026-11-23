import ApplicationServices
import CoreGraphics
import Foundation

/// Pid above the macOS range: no process answers AX queries for it, so every attribute, action and
/// settable read on its application handle fails (`cannotComplete` when trusted, `apiDisabled` when not).
private let detachedPid = Int32.max

/// Drive `Bridge`'s AX element accessors, AX value decoding and element payload assembly on application
/// handles for a pid no process owns. The reads are real AX calls that fail at once, so these checks pin
/// the failure handling: a failed read never reads as an authoritative absence, an empty value or a
/// usable frame. No input is posted; the bridge holds the fail-fast sink.
func runAXElementAssertions() {
    let refStore = AXRefStore()
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink, refStore: refStore)
    assertFailedReads(bridge)
    assertElementRelations(bridge)
    assertAXValueDecoding(bridge)
    assertElementPayload(bridge, refStore: refStore)
    print("macos AX element accessor assertions passed (AXIsProcessTrusted: \(AXIsProcessTrusted()))")
}

/// Every reader of a detached element: evidence reads report `failed`, plain reads report nothing.
private func assertFailedReads(_ bridge: Bridge) {
    let element = AXUIElementCreateApplication(detachedPid)
    expect(bridge.stringRead(element, attribute: kAXRoleAttribute as CFString) == .failed, "a failed string read is failed, not absent")
    expect(bridge.sizeRead(element) == .failed, "a failed size read is failed, not absent")
    expect(bridge.axElementArrayEvidence(element, attribute: kAXChildrenAttribute as CFString) == nil, "a failed child read has no evidence")
    expect(bridge.axElementArray(element, attribute: kAXChildrenAttribute as CFString).isEmpty, "a failed plain child read is empty")
    expect(bridge.axElementArrayIfPresent(element, attribute: kAXChildrenAttribute as CFString) == nil, "a failed optional child read is nil")
    let sheets = bridge.sheetInventory(of: element)
    expect(sheets.sheets.isEmpty && !sheets.complete, "a sheet inventory from failed reads is empty and incomplete")
    expect(bridge.sheetElements(of: element).isEmpty, "a detached window lists no sheets")
    expect(bridge.boolAttribute(element, attribute: kAXFocusedAttribute as CFString) == nil, "a failed bool read is nil")
    expect(bridge.pointAttribute(element, attribute: kAXPositionAttribute as CFString) == nil, "a failed point read is nil")
    expect(bridge.sizeAttribute(element, attribute: kAXSizeAttribute as CFString) == nil, "a failed size attribute is nil")
    expect(bridge.frameForElement(element) == nil, "a detached element has no frame")
    expect(bridge.parentElement(element) == nil, "a detached element has no parent")
    expect(bridge.actionNames(element).isEmpty, "a detached element lists no actions")
    expect(!bridge.supportsAction(element, action: kAXPressAction as CFString), "a detached element supports no press")
    expect(!bridge.supportsAnyScrollAction(element), "a detached element supports no scroll action")
    expect(bridge.focusedWindowSummary(pid: detachedPid) == "none", "a pid without a focused window summarizes as none")
    expect(bridge.scrollPositionSignature(element) == "||", "unread scroll bars and value sign as empty fields")
    for (role, subrole, secure) in [
        ("AXSecureTextField", "", true), ("AXTextField", "AXSecureTextField", true), ("AXTextField", "", false), ("", "", false),
    ] {
        expect(bridge.isSecureTextElement(role: role, subrole: subrole) == secure, "isSecureTextElement(\(role), \(subrole)) is \(secure)")
        expect(bridge.displayValue(element, role: role, subrole: subrole).isEmpty, "displayValue(\(role), \(subrole)) of an unreadable value is empty")
    }
    let walked = bridge.collectDescendants(startingAt: element, maxDepth: 3)
    expect(walked.count == 1 && CFEqual(walked[0], element), "a walk whose child read fails keeps only its root")
}

/// Element identity and ancestry: equivalent handles match, an unreadable parent chain ends the walk.
private func assertElementRelations(_ bridge: Bridge) {
    let element = AXUIElementCreateApplication(detachedPid)
    let equivalent = AXUIElementCreateApplication(detachedPid)
    let other = AXUIElementCreateApplication(detachedPid - 1)
    expect(bridge.sameElement(element, equivalent), "fresh handles for one application are the same element")
    expect(!bridge.sameElement(element, other), "handles for two applications differ")
    expect(bridge.isElement(element, descendantOf: equivalent), "an element is a descendant of its equivalent handle")
    expect(!bridge.isElement(element, descendantOf: other), "an unreadable parent chain proves no ancestry")
    expect(!bridge.hasAncestorRole(element, role: "AXApplication"), "an unreadable role chain matches no ancestor role")
    expect(bridge.pidForElement(element) == detachedPid, "an application handle reports its own pid without a query")
}

/// `AXUIElement` and `CGSize` decoding from raw CF values.
private func assertAXValueDecoding(_ bridge: Bridge) {
    let element = AXUIElementCreateApplication(detachedPid)
    expect(bridge.asAXElement(element).map { CFEqual($0, element) } == true, "an AX element decodes as itself")
    expect(bridge.asAXElement("AXWindow" as NSString) == nil, "a string is not an AX element")
    var size = CGSize(width: 320, height: 240)
    var point = CGPoint(x: 5, y: 6)
    expect(bridge.decodeAXSize(AXValueCreate(.cgSize, &size)) == size, "a CGSize AX value decodes")
    expect(bridge.decodeAXSize(AXValueCreate(.cgPoint, &point)) == nil, "a CGPoint AX value is not a size")
    expect(bridge.decodeAXSize("320x240" as CFString) == nil, "a non-AX value is not a size")
    expect(bridge.decodeAXSize(nil) == nil, "a missing value is not a size")
}

/// `elementPayload` assembles its keys from failed reads without inventing a frame, actions or affordances.
private func assertElementPayload(_ bridge: Bridge, refStore: AXRefStore) {
    let element = AXUIElementCreateApplication(detachedPid)
    let payload = bridge.elementPayload(element: element, key: "found", score: 2.5, source: "desktop_ax", axVisible: false)
    expect(payload["found"] as? Bool == true, "the payload carries its key flag")
    for field in ["role", "subrole", "title", "description", "identifier", "value"] {
        expect(payload[field] as? String == "", "an unreadable \(field) is empty")
    }
    expect((payload["actions"] as? [String])?.isEmpty == true, "an unreadable element lists no actions")
    for flag in ["isTextInput", "canSetValue", "canFocus", "canPress", "canScroll", "canIncrement", "canDecrement", "axVisible"] {
        expect(payload[flag] as? Bool == false, "\(flag) is false")
    }
    expect(payload["x"] as? CGFloat == 0 && payload["y"] as? CGFloat == 0, "a frameless element centers at the origin")
    expect(payload["frame"] == nil && payload["parentFrame"] == nil, "a frameless element reports no frame or parent frame")
    expect(payload["score"] as? Double == 2.5 && payload["source"] as? String == "desktop_ax", "score and source pass through")
    let ref = payload["elementRef"] as? String
    expect(ref.flatMap(refStore.element(for:)).map { CFEqual($0, element) } == true, "the payload ref resolves to the element")
    let bare = bridge.elementPayload(element: element, key: "focused")
    expect(bare["focused"] as? Bool == true && bare["axVisible"] as? Bool == true, "a bare payload is visible by default")
    expect(bare["score"] == nil && bare["source"] == nil, "a bare payload has no score or source")
    expect(bare["elementRef"] as? String != ref, "each payload stores a fresh ref")
}
