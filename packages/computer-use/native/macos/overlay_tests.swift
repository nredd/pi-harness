import AppKit
import QuartzCore
import SwiftUI

private final class GlowWindow: ActivityGlowWindow {
    private(set) var events: [String] = []

    func close() { events.append("close") }
    func orderFrontRegardless() { events.append("show") }
    func orderOut(_ sender: Any?) { events.append("hide") }
}

@MainActor
func runGlowLifecycleAssertions() async {
    let first = [GlowWindow(), GlowWindow()]
    let second = [GlowWindow()]
    let third = [GlowWindow()]
    var configurations = [first, second, third]
    var controller: ActivityGlowController? = ActivityGlowController(makeWindows: { configurations.removeFirst() })
    let one = UUID(), two = UUID()

    // Synchronize behind the controller's enqueued work, without sleeping or ordering real windows.
    func flush() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
    func screensChanged() {
        NotificationCenter.default.post(name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    expect(controller?.isActive == false, "glow starts inactive")
    expect(first.allSatisfy { $0.events.isEmpty }, "inactive glow does not show on construction")
    controller?.setActive(true, for: one)
    await flush()
    expect(first.allSatisfy { $0.events == ["show"] }, "first active client shows glow on all displays")
    controller?.setActive(true, for: one)
    controller?.setActive(true, for: two)
    await flush()
    expect(first.allSatisfy { $0.events == ["show"] }, "adding active clients does not reorder visible glow")
    controller?.disconnect(one)
    await flush()
    expect(controller?.isActive == true && first.allSatisfy { $0.events == ["show"] },
           "disconnecting one client must not hide another client's glow")

    screensChanged()
    expect(first.allSatisfy { $0.events == ["show", "close"] }, "display changes close obsolete glow windows")
    expect(second[0].events == ["show"], "display changes show replacement windows while active")
    controller?.disconnect(two)
    await flush()
    expect(controller?.isActive == false && second[0].events == ["show", "hide"],
           "disconnecting the last client hides the replacement window")
    screensChanged()
    expect(second[0].events == ["show", "hide", "close"] && third[0].events.isEmpty,
           "display changes replace but do not show inactive windows")

    controller?.setActive(true, for: one)
    controller = nil
    await flush()
    screensChanged()
    expect(configurations.isEmpty && third[0].events.isEmpty,
           "deallocated controller does not show queued glow or handle screen changes")
}

@MainActor
func runGlowLayoutAssertions() {
    let view = ActivityGlowView(frame: CGRect(x: 0, y: 0, width: 200, height: 120))
    expect(ActivityGlowView(coder: NSCoder()) == nil, "programmatic glow does not decode from an archive")
    guard let layer = view.layer, let layers = layer.sublayers, layers.count == 5 else {
        expect(false, "glow has four edge gradients and a border")
        return
    }
    expect(layer.masksToBounds, "glow does not extend past its window")
    view.layout()
    let gradient = layers.compactMap { $0 as? CAGradientLayer }
    expect(gradient.count == 4, "glow fades from every edge")
    let outer: [CGPoint] = [.init(x: 0.5, y: 1), .init(x: 0.5, y: 0), .init(x: 0, y: 0.5), .init(x: 1, y: 0.5)]
    let inner = [outer[1], outer[0], outer[3], outer[2]]
    expect(gradient.map(\.startPoint) == outer && gradient.map(\.endPoint) == inner,
           "all gradients point from the outside toward the center")
    expect(gradient.allSatisfy { edge in
        guard let colors = edge.colors as? [CGColor], colors.count == 3 else { return false }
        return colors[0].alpha > colors[1].alpha && colors[1].alpha > colors[2].alpha && colors[2].alpha == 0
    }, "glow fades to transparent")
    for (width, height) in [(200.0, 120.0), (480.0, 270.0)] {
        view.setFrameSize(CGSize(width: width, height: height))
        view.layout()
        expect(gradient.map(\.frame) == [
            CGRect(x: 0, y: height - 30, width: width, height: 30),
            CGRect(x: 0, y: 0, width: width, height: 30),
            CGRect(x: 0, y: 0, width: 30, height: height),
            CGRect(x: width - 30, y: 0, width: 30, height: height),
        ], "gradients follow all four edges after layout and resize")
        expect(layers[4].frame == view.bounds && layers[4].borderWidth == 2,
               "the border fits the glow bounds after resize")
    }
    guard let pulse = layer.animation(forKey: "computer-use-activity-pulse") as? CAKeyframeAnimation else {
        expect(false, "glow has an opacity pulse")
        return
    }
    let values = (pulse.values as? [NSNumber])?.map(\.doubleValue) ?? []
    expect(pulse.keyPath == "opacity" && values.count == 3 && abs(values[0] - 0.72) < 0.001
           && values[1] == 1 && values[0] == values[2] && pulse.repeatCount > 1,
           "glow repeatedly pulses and returns to dim opacity")
}

@MainActor
private final class CursorSurface: AgentCursorSurface {
    private(set) var isVisible = false
    private(set) var shows = 0
    private(set) var orders: [Int] = []
    private(set) var dismissals = 0

    func orderFrontRegardless() { isVisible = true; shows += 1 }
    func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        expect(place == .above, "cursor must stay above its target window")
        orders.append(otherWin)
    }
    func dismiss() { isVisible = false; dismissals += 1 }
}

@MainActor
func runCursorLifecycleAssertions() {
    let renderer = AgentCursorRenderer()
    var actions: [@MainActor () -> Void] = []
    var tasks: [Task<Void, Never>] = []
    var surfaces: [CursorSurface] = []
    var frameReads = 0
    var cursor: AgentCursor? = AgentCursor(scheduleIdleHide: { hide in
        actions.append(hide)
        let task = Task {}
        tasks.append(task)
        return task
    }, renderer: renderer, mainFrame: {
        frameReads += 1
        return CGRect(x: 100, y: 100, width: 500, height: 400)
    }, makeSurface: {
        let surface = CursorSurface()
        surfaces.append(surface)
        return surface
    })

    cursor?.animate(to: CGPoint(x: 150, y: 900), above: 42)
    expect(surfaces.count == 1 && surfaces[0].shows == 1 && surfaces[0].orders == [42],
           "first action creates and orders one visible overlay")
    expect(renderer.position == CGPoint(x: 102, y: 498) && renderer.isAnimating,
           "first action clamps the initial cursor within screen bounds and starts motion")
    cursor?.animate(to: CGPoint(x: 450, y: 350), above: 172)
    expect(surfaces.count == 1 && surfaces[0].shows == 1 && surfaces[0].orders == [42, 172] && frameReads == 1,
           "retargeting reuses the overlay without resetting its origin")
    expect(tasks[0].isCancelled && !tasks[1].isCancelled, "retargeting cancels only the superseded timeout")
    actions[0]()
    expect(surfaces[0].isVisible && surfaces[0].dismissals == 0 && renderer.isAnimating,
           "stale callback cannot dismiss a retargeted overlay or stop motion")
    actions[1]()
    expect(!surfaces[0].isVisible && surfaces[0].dismissals == 1 && !renderer.isAnimating,
           "current timeout dismisses the overlay and stops motion")
    actions[1]()
    expect(surfaces[0].dismissals == 1, "duplicate timeout cannot dismiss an already released overlay")

    cursor?.animate(to: CGPoint(x: 380, y: 330), above: 9)
    expect(surfaces.count == 2 && surfaces[1].orders == [9] && surfaces[1].shows == 1 && !tasks[1].isCancelled,
           "post-dismissal action starts a fresh overlay without retaining the completed timeout")
    cursor = nil
    actions[2]()
    expect(surfaces[1].dismissals == 0, "an abandoned controller is not retained by its timeout")
}

@MainActor
private final class HideCount {
    var value = 0
}

/// The production scheduler passes its delay to an injected sleep, fires once after it returns and never
/// after cancellation; the default sleep is exercised with a zero delay only.
@MainActor
func runCursorIdleHideAssertions() async {
    expect(AgentCursor.idleHideDelay == .seconds(8), "the overlay hides 8 s after the last action")
    let hides = HideCount()
    var release: CheckedContinuation<Void, Never>?
    var receivedDelay: Duration?
    let scheduler = AgentCursor.idleHideScheduler(after: .seconds(8), sleep: { delay in
        receivedDelay = delay
        await withCheckedContinuation { release = $0 }
    })
    let fired = scheduler { hides.value += 1 }
    for _ in 0..<100 where release == nil { await Task.yield() }
    expect(receivedDelay == .seconds(8) && release != nil && hides.value == 0,
           "idle hide waits for the requested delay before firing")
    release?.resume()
    await fired.value
    expect(hides.value == 1, "an uncancelled idle timeout hides the overlay once")
    release = nil
    receivedDelay = nil
    let cancelled = scheduler { hides.value += 1 }
    for _ in 0..<100 where release == nil { await Task.yield() }
    expect(receivedDelay == .seconds(8) && release != nil && hides.value == 1,
           "the next timeout is also pending before cancellation")
    cancelled.cancel()
    release?.resume()
    await cancelled.value
    expect(hides.value == 1, "a cancelled idle timeout never hides the overlay")
    let defaultSleep = AgentCursor.idleHideScheduler(after: .zero)({ hides.value += 1 })
    await defaultSleep.value
    expect(hides.value == 2, "the default sleep completes a zero-duration timeout")
}

/// Cursor geometry on exact paths, then one offscreen render of the overlay view; no window is created.
@MainActor
func runCursorRenderAssertions() {
    let origin = CGPoint(x: 100, y: 100)
    let east = agentCursorShape(at: origin, heading: -.pi)
    expect(east.contains(CGPoint(x: 106, y: 100)) && east.contains(CGPoint(x: 95, y: 106)),
           "an unrotated dart covers its axis ahead of the notch and its rear barbs")
    expect(!east.contains(CGPoint(x: 96, y: 100)), "the notch behind the dart stays open")
    expect(!east.contains(CGPoint(x: 113.5, y: 100)) && east.contains(CGPoint(x: 111.5, y: 100)),
           "corners are rounded: the sharp tip at +14 is cut back")
    let bounds = east.boundingRect
    expect(bounds.minX > 91 && bounds.maxX < 113 && bounds.minY > 91 && bounds.maxY < 109,
           "the dart stays inside its rounded control points")
    let diagonal = agentCursorShape(at: origin, heading: .pi / 4)
    let tip = CGPoint(x: 100 - 6 / 2.0.squareRoot(), y: 100 - 6 / 2.0.squareRoot())
    // 10 pt along the expected tip axis: inside this dart, behind the notch of one pointing the other way.
    let diagonalProbe = CGPoint(x: 100 - 10 / 2.0.squareRoot(), y: 100 - 10 / 2.0.squareRoot())
    let reversed = agentCursorShape(at: origin, heading: .pi / 4 - .pi)
    expect(diagonal.contains(diagonalProbe) && !reversed.contains(diagonalProbe),
           "the dart tip follows heading + pi")
    expect(!diagonal.contains(CGPoint(x: 100 + 6 / 2.0.squareRoot(), y: 100 + 6 / 2.0.squareRoot())),
           "the rotated notch stays open")

    func render(_ renderer: AgentCursorRenderer) -> NSBitmapImageRep? {
        let image = ImageRenderer(content: AgentCursorView(renderer: renderer).frame(width: 200, height: 200))
        image.scale = 1
        return image.cgImage.map(NSBitmapImageRep.init(cgImage:))
    }
    func alpha(_ bitmap: NSBitmapImageRep, _ x: Int, _ y: Int) -> CGFloat {
        bitmap.colorAt(x: x, y: y)?.alphaComponent ?? -1
    }
    let hidden = AgentCursorRenderer()
    guard let empty = render(hidden), empty.pixelsWide == 200, empty.pixelsHigh == 200 else {
        expect(false, "the cursor view renders offscreen")
        return
    }
    expect((0..<200).allSatisfy { x in (0..<200).allSatisfy { y in alpha(empty, x, y) == 0 } },
           "a renderer still at its offscreen origin draws nothing")
    let visible = AgentCursorRenderer()
    visible.setInitialPosition(origin)
    guard let drawn = render(visible), let body = drawn.colorAt(x: Int(tip.x), y: Int(tip.y))?
        .usingColorSpace(.sRGB) else {
        expect(false, "the cursor view renders its dart")
        return
    }
    expect(body.alphaComponent > 0.99 && body.redComponent > 0.9 && body.blueComponent < 0.5,
           "the dart body is an opaque orange gradient")
    let bloom = alpha(drawn, 100 + 12, 100 + 12)
    expect(bloom > 0.01 && bloom < 0.6, "a translucent bloom surrounds the dart")
    expect(alpha(drawn, 100 + 20, 100 + 20) == 0 && alpha(drawn, 10, 10) == 0,
           "nothing is drawn past the bloom radius")
}
