import AppKit
import SwiftUI

@MainActor
protocol AgentCursorSurface: AnyObject {
    var isVisible: Bool { get }
    func orderFrontRegardless()
    func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int)
    func dismiss()
}

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>

    /// Idle time after the last action before the overlay hides and releases its view tree.
    static let idleHideDelay: Duration = .seconds(8)
    static let shared = AgentCursor(scheduleIdleHide: idleHideScheduler(after: idleHideDelay))

    private var overlay: (any AgentCursorSurface)?
    private var idleHideTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private let scheduleIdleHide: IdleHideScheduler
    private let renderer: AgentCursorRenderer
    private let mainFrame: () -> CGRect
    private let makeSurface: () -> any AgentCursorSurface

    convenience init(scheduleIdleHide: @escaping IdleHideScheduler) {
        self.init(scheduleIdleHide: scheduleIdleHide, renderer: .shared,
                  mainFrame: { NSScreen.main?.frame ?? .zero }, makeSurface: Self.makeWindow)
    }

    init(scheduleIdleHide: @escaping IdleHideScheduler, renderer: AgentCursorRenderer,
         mainFrame: @escaping () -> CGRect, makeSurface: @escaping () -> any AgentCursorSurface) {
        self.scheduleIdleHide = scheduleIdleHide
        self.renderer = renderer
        self.mainFrame = mainFrame
        self.makeSurface = makeSurface
    }

    func animate(to point: CGPoint, above windowId: UInt32) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let window = ensureWindow()
        if !window.isVisible { window.orderFrontRegardless() }
        window.order(.above, relativeTo: Int(windowId))

        if renderer.position.x < -100 {
            let frame = mainFrame()
            renderer.setInitialPosition(CGPoint(
                x: min(max(point.x - 140, frame.minX + 2), frame.maxX - 2),
                y: min(max(point.y - 140, frame.minY + 2), frame.maxY - 2)
            ))
        }
        renderer.moveTo(point: point)

        let generation = idleGeneration
        idleHideTask = scheduleIdleHide { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            renderer.cancelAnimation()
            window.dismiss()
            overlay = nil
            idleHideTask = nil
        }
    }

    /// Run `hide` after `sleep(delay)` returns unless the returned task is cancelled first. `sleep` is
    /// `Task.sleep` in production; tests inject one they control.
    static func idleHideScheduler(
        after delay: Duration,
        sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> IdleHideScheduler {
        { hide in
            Task { @MainActor in
                try? await sleep(delay)
                guard !Task.isCancelled else { return }
                hide()
            }
        }
    }

    private func ensureWindow() -> any AgentCursorSurface {
        if let overlay { return overlay }
        let window = makeSurface()
        overlay = window
        return window
    }

    private static func makeWindow() -> AgentCursorOverlayWindow {
        let window = AgentCursorOverlayWindow(
            contentRect: NSScreen.main?.frame ?? NSScreen.screens.first?.frame ?? .zero,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView(renderer: .shared))
        return window
    }
}

/// Main-display-only, click-through overlay that can never take focus.
private final class AgentCursorOverlayWindow: NSWindow, AgentCursorSurface {
    func dismiss() {
        orderOut(nil)
        contentView = nil
        close()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

/// Draws the renderer's cursor; the overlay window hosts it with the shared renderer.
@MainActor
struct AgentCursorView: View {
    @Bindable private var renderer: AgentCursorRenderer

    init(renderer: AgentCursorRenderer) {
        self.renderer = renderer
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 120.0, paused: !renderer.isAnimating)) { context in
            Canvas { graphics, _ in
                renderer.tick(now: context.date.timeIntervalSinceReferenceDate)
                drawCursor(in: graphics)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private func drawCursor(in graphics: GraphicsContext) {
        let point = renderer.position
        guard point.x > -100 else { return }

        let bloom = Color(nsColor: NSColor(red: 1, green: 0x78 / 255, blue: 0x18 / 255, alpha: 1))
        let radius: CGFloat = 22
        graphics.fill(
            Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
            with: .radialGradient(
                Gradient(colors: [bloom.opacity(0.55), bloom.opacity(0.15), bloom.opacity(0)]),
                center: point,
                startRadius: 0,
                endRadius: radius
            )
        )

        let transformed = agentCursorShape(at: point, heading: renderer.heading)
        graphics.fill(
            transformed,
            with: .linearGradient(
                Gradient(colors: [
                    Color(red: 1, green: 0xD0 / 255, blue: 0x76 / 255),
                    Color(red: 1, green: 0x78 / 255, blue: 0x18 / 255),
                    Color(red: 0xE8 / 255, green: 0x4A / 255, blue: 0x0C / 255),
                ]),
                startPoint: CGPoint(x: point.x + 14, y: point.y - 9),
                endPoint: CGPoint(x: point.x - 8, y: point.y + 9)
            )
        )
        graphics.stroke(transformed, with: .color(.white), lineWidth: 2)
    }
}

/// Rounded dart at `point`, rotated so its tip points along `heading + .pi`.
func agentCursorShape(at point: CGPoint, heading: Double) -> Path {
    let points = [
        CGPoint(x: 14, y: 0),
        CGPoint(x: -8, y: -9),
        CGPoint(x: -3, y: 0),
        CGPoint(x: -8, y: 9),
    ]
    var shape = Path()
    for index in points.indices {
        let previous = points[(index + points.count - 1) % points.count]
        let current = points[index]
        let next = points[(index + 1) % points.count]
        let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
        let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
        if index == points.startIndex { shape.move(to: entry) } else { shape.addLine(to: entry) }
        shape.addQuadCurve(to: exit, control: current)
    }
    shape.closeSubpath()
    return shape.applying(
        CGAffineTransform(translationX: point.x, y: point.y)
            .rotated(by: CGFloat(heading + .pi))
    )
}
