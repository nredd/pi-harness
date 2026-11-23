import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

/// Drive `Bridge.handleRequest`'s `look` past ownership to a stored look: AX root resolution, scope refs,
/// image and semantic geometry, the outline walk, the look record and base-look ref transfer. The root is
/// an application handle for a pid above the macOS pid range, stored as a native window ref, so every AX
/// read fails at once and no process receives the `AXEnhancedUserInterface` setters. The window owner and
/// the capture are injected; the capture returns an in-memory bitmap. Pairing reads the live CG window
/// list (read-only), where no window has that pid. `readText: always` (Vision OCR) is never requested.
func runLookAssertions() throws {
    let absentPid = Int32.max - 4
    let frame = CGRect(x: 100, y: 50, width: 200, height: 100)
    guard let bitmap = lookBitmap(width: 400, height: 200) else {
        expect(false, "a 400x200 RGBA bitmap context builds")
        return
    }
    let refStore = AXRefStore()
    let bridge = Bridge(activityGlow: nil, readSession: { nil }, inputSink: forbiddenInputSink, refStore: refStore)
    let root = AXUIElementCreateApplication(absentPid)
    let rootRef = refStore.storeWindow(root)
    var trace: [String] = []
    func look(_ request: [String: Any]) throws -> [String: Any] {
        var full = request
        full["cmd"] = "look"
        let reply = try bridge.handleRequest(full, clientID: nil, lookWindowOwner: { id in
            trace.append("owner:\(id)")
            return absentPid
        }, lookCapture: { id in
            trace.append("capture:\(id)")
            return CapturedWindowImage(image: bitmap, windowId: id, frame: frame)
        })
        guard let object = reply as? [String: Any] else {
            expect(false, "look: expected an object reply, got \(reply)")
            return [:]
        }
        return object
    }
    func refused(_ code: String, _ message: String, _ request: [String: Any]) {
        do {
            let reply = try look(request)
            expect(false, "look: expected \(code), got a reply with lookId \(reply["lookId"] ?? "none")")
        } catch let error as BridgeFailure {
            expect(error.code == code && error.message == message, "look: expected \(code) '\(message)', got \(error.code) '\(error.message)'")
        } catch {
            expect(false, "look: unexpected \(error)")
        }
    }

    // The AX root must be the stored ref of the resolved owner; nothing falls back to another window.
    let otherRef = refStore.storeWindow(AXUIElementCreateApplication(absentPid - 1))
    for windowRef in [nil, "w-stale", otherRef] as [String?] {
        trace = []
        var request: [String: Any] = ["windowId": 42, "includeImage": true, "readText": "never"]
        request["windowRef"] = windowRef
        refused("root_not_found", "Root is not available through Accessibility", request)
        expect(trace == ["owner:42", "capture:42"], "an unresolvable AX root \(windowRef ?? "nil") fails after capture, got \(trace)")
    }
    expect(refStore.elementCount == 0, "a look that fails before its outline mints no element refs")

    // A scope ref must name the root or one of its descendants.
    let unrelatedRef = refStore.storeElement(AXUIElementCreateApplication(absentPid - 1))
    for scopeRef in ["e-stale", unrelatedRef] {
        refused("element_ref_invalid", "Scope ref is stale or outside the target root", ["windowId": 42, "windowRef": rootRef, "scopeRef": scopeRef, "includeImage": false, "readText": "never"])
    }

    // An image look downscales the capture, maps rects into it and records its geometry.
    trace = []
    let image = try look(["pid": Int(absentPid), "windowId": 42, "windowRef": rootRef, "maxDimension": 100, "readText": "auto"])
    expect(trace == ["owner:42", "capture:42"], "an image look resolves ownership, then captures once, got \(trace)")
    expect(image["lookId"] as? String == "look_1", "the first stored look is look_1")
    let imageWindow = image["window"] as? [String: Any] ?? [:]
    expect(imageWindow["windowId"] as? Int == 42 && imageWindow["rootRef"] as? String == rootRef, "the look names the requested window id and root ref")
    expect(imageWindow["kind"] as? String == "window" && imageWindow["role"] as? String == "" && imageWindow["subrole"] as? String == "", "unread role and subrole leave a plain window root")
    expect(imageWindow["isModal"] as? Bool == false, "a root with unread modality and no sheets is not modal")
    expect(lookRect(imageWindow["framePoints"]) == frame, "framePoints are the capture frame")
    expect(imageWindow["scaleFactor"] as? Double == 0.5, "the scale factor is output pixels per capture point (100 / 200)")
    let metadata = imageWindow["metadata"] as? [String: Any]
    let pairing = metadata?["pairing"] as? [String: Any]
    expect(pairing?["confidence"] as? String == "low" && pairing?["score"] as? Double == -Double.greatestFiniteMagnitude && metadata?["sheetCount"] as? Int == 0, "an unpaired root reports low confidence, the minimum score and no sheets")
    let jpeg = (image["image"] as? [String: Any]).flatMap { payload -> (Data, Int?, Int?)? in
        guard let base64 = payload["jpegBase64"] as? String, let data = Data(base64Encoded: base64) else { return nil }
        return (data, payload["width"] as? Int, payload["height"] as? Int)
    }
    let decoded = jpeg.flatMap { CGImageSourceCreateWithData($0.0 as CFData, nil) }.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    expect(jpeg?.1 == 100 && jpeg?.2 == 50 && decoded?.width == 100 && decoded?.height == 50, "the image is the capture downscaled to maxDimension, as JPEG")
    let readText = image["readText"] as? [String: Any]
    expect(readText?["requested"] as? String == "auto" && readText?["executed"] as? Bool == false, "readText auto does not run OCR")
    let timings = image["timings"] as? [String: Any]
    expect((timings?["captureMs"] as? Int ?? -1) >= 0 && (timings?["describeMs"] as? Int ?? -1) >= 0 && timings?["readTextMs"] as? Int == 0, "timings are whole non-negative milliseconds, with no OCR time")
    let imageOutline = image["outline"] as? [String: Any] ?? [:]
    let imageOutlineRef = imageOutline["ref"] as? String ?? ""
    expect(imageOutlineRef.hasPrefix("e") && refStore.element(for: imageOutlineRef) != nil, "the outline root is a fresh element ref the look owns")
    expect(imageOutline["truncated"] as? Bool == true && (imageOutline["children"] as? [Any])?.isEmpty == true, "a root whose children read failed is truncated, never a leaf")
    expect(lookRect(imageOutline["rect"]) == CGRect(x: 0, y: 0, width: 0, height: 0), "an unread element frame clamps into the image as an empty rect")
    let imageRecord = bridge.lookRecord(for: "look_1")
    expect(imageRecord?.windowId == 42 && imageRecord?.windowRef == rootRef && imageRecord?.windowFrame == frame, "the image look records its window and capture frame")
    expect(imageRecord?.imageWidth == 100 && imageRecord?.imageHeight == 50 && imageRecord?.hasImage == true, "the image look records the output size and its image")

    // A capture without an image still records the capture geometry.
    trace = []
    let noImage = try look(["windowId": 42, "windowRef": rootRef, "includeImage": false, "readText": "auto", "scopeRef": refStore.storeElement(root)])
    expect(trace == ["owner:42"], "a semantic look never captures, got \(trace)")
    expect(noImage["image"] == nil, "a semantic look carries no image")
    let noImageOutline = noImage["outline"] as? [String: Any]
    expect(noImageOutline?["ref"] as? String != imageOutlineRef, "a scoped look mints its own root ref")
    let semanticRecord = bridge.lookRecord(for: "look_2")
    expect(semanticRecord?.windowFrame == .zero && semanticRecord?.imageWidth == 1 && semanticRecord?.imageHeight == 1 && semanticRecord?.hasImage == false, "a semantic look over an unread frame records a 1x1 frame-sized image space without an image")
    let semanticScale = (noImage["window"] as? [String: Any])?["scaleFactor"] as? Double ?? 0
    expect(semanticScale > 0, "an empty root frame falls back to a positive display scale")

    // A look on a base look inherits the base geometry and keeps the base's refs alive with its own.
    trace = []
    let incremental = try look(["windowRef": rootRef, "baseLookId": "look_1", "includeImage": false, "readText": "never"])
    expect(trace.isEmpty, "a semantic look without a window id resolves its owner from the AX root, got \(trace)")
    expect((incremental["window"] as? [String: Any])?["windowId"] as? Int == 0, "the reply keeps the request's missing window id")
    let incrementalRecord = bridge.lookRecord(for: "look_3")
    expect(incrementalRecord?.windowId == 42 && incrementalRecord?.windowRef == rootRef && incrementalRecord?.windowFrame == frame, "an incremental look records the base window id and frame")
    expect(incrementalRecord?.imageWidth == 100 && incrementalRecord?.imageHeight == 50 && incrementalRecord?.hasImage == true, "an incremental look records the base image space")
    let unbased = try look(["windowRef": rootRef, "baseLookId": "look_404", "includeImage": false, "readText": "never"])
    let unbasedRecord = bridge.lookRecord(for: unbased["lookId"] as? String ?? "")
    expect(unbasedRecord?.windowId == 0 && unbasedRecord?.windowFrame == .zero && unbasedRecord?.hasImage == false, "an unknown base look id is ignored")

    // look_1's refs now belong to look_3: evicting look_1 keeps them, evicting look_3 drops them.
    for _ in 5...9 { _ = try look(["windowRef": rootRef, "includeImage": false, "readText": "never"]) }
    expect(bridge.lookRecord(for: "look_1") == nil && bridge.lookRecord(for: "look_3") != nil, "the ninth look evicts only look_1")
    expect(refStore.element(for: imageOutlineRef) != nil, "a base look's refs outlive it while the incremental look is retained")
    for _ in 10...11 { _ = try look(["windowRef": rootRef, "includeImage": false, "readText": "never"]) }
    expect(bridge.lookRecord(for: "look_3") == nil, "the eleventh look evicts look_3")
    expect(refStore.element(for: imageOutlineRef) == nil, "evicting the incremental look drops the refs it took over")
    expect(refStore.elementCount == 2 + 8, "only the two direct refs and the eight retained looks' outline roots remain, got \(refStore.elementCount)")
    print("macos look assertions passed")
}

/// The `x`/`y`/`w`/`h` rect a look payload carries, or nil when a field is missing.
private func lookRect(_ value: Any?) -> CGRect? {
    func number(_ field: Any?) -> Double? { (field as? CGFloat).map(Double.init) ?? field as? Double }
    guard let rect = value as? [String: Any], let x = number(rect["x"]), let y = number(rect["y"]),
        let w = number(rect["w"]), let h = number(rect["h"])
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

private func lookBitmap(width: Int, height: Int) -> CGImage? {
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}
